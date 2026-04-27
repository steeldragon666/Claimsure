import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { insertEventWithChain } from '@cpa/db';
import { sql, privilegedSql } from '@cpa/db/client';
import { Uuid } from '@cpa/schemas';
import { requireMobileSession } from '../middleware/mobile-jwt-verifier.js';
import { runTranscribeJob } from '../jobs/transcribe.js';

/**
 * Mobile voice-event ingest body (T-A4).
 *
 * `subject_tenant_id` is OPTIONAL — when omitted, we derive it from
 * `req.mobileUser.subject_tenant_id` (the employee's bound claimant).
 * Allowing the override is what lets a future "consultant test mode"
 * post on behalf of a different claimant without re-binding the
 * employee, but the typical employee flow leaves it unset.
 *
 * `audio_s3_key` is the object key the mobile client uploaded the bytes
 * to before calling this endpoint — the upload step itself lands with
 * the rest of the media-upload pipeline; for v1 the route trusts the
 * key and the transcribe job's getMediaBytes stub throws.
 *
 * `captured_at_local` is the device-clock ms epoch — server stores it
 * verbatim in the payload (NOT in `event.captured_at`, which uses
 * server NOW() for ingest ordering). Future backdate-detection work
 * can compare the two.
 */
const mobileEventBody = z.object({
  subject_tenant_id: Uuid.optional(),
  audio_s3_key: z.string().min(1).max(1024),
  audio_mime_type: z.string().min(1).max(64),
  duration_ms: z.number().int().nonnegative(),
  captured_at_local: z.number().int().nonnegative(),
});
type MobileEventBody = z.infer<typeof mobileEventBody>;

const errEnvelope = (
  code: string,
  message: string,
  requestId: string,
): { error: { code: string; message: string }; requestId: string } => ({
  error: { code, message },
  requestId,
});

/**
 * Best-effort enqueue of the transcribe job.
 *
 * The pg-boss subscriber wiring lands in a follow-up task; for v1 we
 * call `runTranscribeJob` directly in a fire-and-forget so the
 * route can still return 201 quickly. Errors are logged via the
 * Fastify request logger but never bubbled up — the event row is
 * already persisted, so the user's capture isn't lost; a future
 * worker can re-enqueue for any rows where payload still has
 * source='voice_pending'.
 */
function enqueueTranscribeBestEffort(
  app: FastifyInstance,
  args: { audio_s3_key: string; event_id: string; audio_mime_type: string },
): void {
  void runTranscribeJob({
    audio_s3_key: args.audio_s3_key,
    event_id: args.event_id,
    audio_mime_type: args.audio_mime_type,
  }).catch((err: unknown) => {
    // The placeholder S3 stub throws by design until the upload pipe
    // lands; warn rather than error so test logs aren't noisy.
    app.log.warn(
      { err, event_id: args.event_id },
      'transcribe job (best-effort) failed — payload remains voice_pending',
    );
  });
}

/**
 * Register POST /v1/mobile/events (T-A4).
 *
 * Auth: requireMobileSession — the route is for the employee app, not
 * the consultant portal. F5's mobile JWT carries tenant_id +
 * subject_tenant_id, so the body's subject_tenant_id is optional.
 *
 * Idempotency: the Idempotency-Key header (typically the mobile
 * queue's local_id) is hashed and stored in `event.idempotency_key`.
 * On a duplicate request with the same key + same employee context
 * the route returns 200 with the existing row instead of inserting a
 * second one. This makes the mobile sync worker's "drain failed →
 * retry" path safe: the network failure that dropped the original
 * response can't double-create.
 *
 * Effect: inserts an event with kind=SUPPORTING + payload =
 * {_v:1, source:'voice_pending', audio_s3_key, captured_at_local}.
 * The transcribe job patches payload to source='voice' once Deepgram
 * returns. SUPPORTING is a placeholder — the classifier will reclassify
 * downstream; OVERRIDE preserves the kind history if the placeholder
 * was wrong.
 */
export function registerMobileEvents(app: FastifyInstance): void {
  app.post('/v1/mobile/events', { preHandler: requireMobileSession }, async (req, reply) => {
    const parsed = mobileEventBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(
        errEnvelope(
          'INVALID_BODY',
          'Body must be { subject_tenant_id?, audio_s3_key, audio_mime_type, duration_ms, captured_at_local }',
          req.id,
        ),
      );
    }
    const body: MobileEventBody = parsed.data;
    const principal = req.mobileUser!;
    const subjectTenantId = body.subject_tenant_id ?? principal.subjectTenantId;

    // Reject cross-firm subject overrides — the employee can only post
    // on behalf of their own claimant. If a future consultant-test
    // mode legitimately needs cross-tenant posting it'll come via a
    // different audience claim, not this route.
    if (
      body.subject_tenant_id !== undefined &&
      body.subject_tenant_id !== principal.subjectTenantId
    ) {
      return reply
        .status(403)
        .send(
          errEnvelope(
            'FORBIDDEN',
            'subject_tenant_id does not match employee binding',
            req.id,
          ),
        );
    }

    // Confirm the subject_tenant is visible (and live) under RLS using
    // the consultant firm's tenant context (from the JWT).
    const subjectVisible = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${principal.tenantId}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM subject_tenant
         WHERE id = ${subjectTenantId} AND deleted_at IS NULL
      `;
      return rows[0] != null;
    });
    if (!subjectVisible) {
      return reply
        .status(404)
        .send(errEnvelope('SUBJECT_TENANT_NOT_FOUND', 'No claimant with that id', req.id));
    }

    // Idempotency-Key header support. We pass the raw value through to
    // event.idempotency_key — the partial unique index serialises
    // duplicate inserts. Empty / absent header = no idempotency
    // protection (caller opted out, eg. an in-app retry that wants a
    // fresh row).
    const idemHeader = req.headers['idempotency-key'];
    const idempotencyKey =
      typeof idemHeader === 'string' && idemHeader.length > 0 ? idemHeader : null;

    if (idempotencyKey) {
      // Look up first — return 200 + existing row on hit. This avoids
      // the unique-violation 23505 round-trip below for the common
      // "already received" case, and guarantees the response payload is
      // identical across re-tries (same id, hash, etc.).
      const existing = await privilegedSql<{
        id: string;
        captured_at: Date;
        received_at: Date;
        hash: string;
      }[]>`
        SELECT id, captured_at, received_at, hash FROM event
         WHERE idempotency_key = ${idempotencyKey}
           AND tenant_id = ${principal.tenantId}
      `;
      const e = existing[0];
      if (e) {
        return reply.status(200).send({
          event: {
            id: e.id,
            tenant_id: principal.tenantId,
            subject_tenant_id: subjectTenantId,
            captured_at: e.captured_at instanceof Date ? e.captured_at.toISOString() : e.captured_at,
            received_at: e.received_at instanceof Date ? e.received_at.toISOString() : e.received_at,
            hash: e.hash,
          },
          duplicate: true,
        });
      }
    }

    // Insert the placeholder event. SUPPORTING kind acts as the
    // pre-classification holding bay — once the transcribe job runs
    // and the classifier reclassifies, it'll OVERRIDE this if needed.
    let inserted: { id: string; hash: string };
    try {
      const result = await insertEventWithChain({
        tenant_id: principal.tenantId,
        subject_tenant_id: subjectTenantId,
        kind: 'SUPPORTING',
        payload: {
          _v: 1,
          source: 'voice_pending',
          audio_s3_key: body.audio_s3_key,
          captured_at_local: body.captured_at_local,
        },
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: principal.employeeId,
        override_of_event_id: null,
        override_new_kind: null,
        override_reason: null,
        idempotency_key: idempotencyKey,
      });
      inserted = { id: result.id, hash: result.hash };
    } catch (err) {
      // Race window: a concurrent retry with the same idempotency key
      // landed between our SELECT above and the INSERT. The unique
      // partial index throws 23505 — re-resolve and return the
      // surviving row.
      if ((err as { code?: string }).code === '23505' && idempotencyKey) {
        const winners = await privilegedSql<{
          id: string;
          captured_at: Date;
          received_at: Date;
          hash: string;
        }[]>`
          SELECT id, captured_at, received_at, hash FROM event
           WHERE idempotency_key = ${idempotencyKey}
             AND tenant_id = ${principal.tenantId}
        `;
        const winner = winners[0];
        if (winner) {
          return reply.status(200).send({
            event: {
              id: winner.id,
              tenant_id: principal.tenantId,
              subject_tenant_id: subjectTenantId,
              captured_at:
                winner.captured_at instanceof Date
                  ? winner.captured_at.toISOString()
                  : winner.captured_at,
              received_at:
                winner.received_at instanceof Date
                  ? winner.received_at.toISOString()
                  : winner.received_at,
              hash: winner.hash,
            },
            duplicate: true,
          });
        }
      }
      throw err;
    }

    // Best-effort transcribe enqueue. The placeholder getMediaBytes
    // stub throws today; once S3 lands the same call still works
    // because the input shape is stable.
    enqueueTranscribeBestEffort(app, {
      audio_s3_key: body.audio_s3_key,
      event_id: inserted.id,
      audio_mime_type: body.audio_mime_type,
    });

    // Read back the inserted row's timestamps so the client can
    // populate its local cache without a follow-up GET. captured_at /
    // received_at are server-side; the mobile UI uses captured_at_local
    // (in the payload) for its own offline-friendly ordering.
    const fresh = await privilegedSql<{
      captured_at: Date;
      received_at: Date;
    }[]>`
      SELECT captured_at, received_at FROM event WHERE id = ${inserted.id}
    `;
    const f = fresh[0]!;
    return reply.status(201).send({
      event: {
        id: inserted.id,
        tenant_id: principal.tenantId,
        subject_tenant_id: subjectTenantId,
        captured_at: f.captured_at instanceof Date ? f.captured_at.toISOString() : f.captured_at,
        received_at: f.received_at instanceof Date ? f.received_at.toISOString() : f.received_at,
        hash: inserted.hash,
      },
    });
  });
}
