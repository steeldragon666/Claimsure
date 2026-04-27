import type { FastifyInstance } from 'fastify';
import { insertEventWithChain } from '@cpa/db';
import { sql, privilegedSql } from '@cpa/db/client';
import {
  createMobileEventBody,
  type CreateMobileEventBody,
  type Classification,
} from '@cpa/schemas';
import { requireMobileSession } from '../middleware/mobile-jwt-verifier.js';
import { runTranscribeJob } from '../jobs/transcribe.js';

/**
 * POST /v1/mobile/events body (T-A4 + T-A11).
 *
 * Discriminated-union body: `payload.source` selects the variant.
 *   - voice              → existing flow (placeholder event + transcribe job)
 *   - hypothesis_prompt  → kind forced to HYPOTHESIS + synthesised classification
 *
 * `subject_tenant_id` is OPTIONAL — when omitted, derived from
 * `req.mobileUser.subject_tenant_id`. `captured_at_local` is the
 * device-clock ms epoch and goes verbatim into the payload (the
 * canonical `event.captured_at` uses server NOW() for ingest order).
 *
 * See `@cpa/schemas/event` for the per-variant zod definitions.
 */
type MobileEventBody = CreateMobileEventBody;

/**
 * Hypothesis-form classification synthesis.
 *
 * The form IS the classification — no LLM call, no idempotency cache.
 * We mint a classification row inline so downstream views (assurance
 * report, ineligible filter) can still filter by `classification IS
 * NOT NULL` without adding a special-case for HYPOTHESIS. The model
 * name `mobile-hypothesis-form` is a deliberate non-LLM string so
 * cost-tracking dashboards can exclude it from token spend.
 *
 * Confidence pinned at 1.0 — the consultant-confirmed pre-experiment
 * framing is what makes this a HYPOTHESIS under §355-25(1)(a); the
 * form's "pre-dating the hypothesis is what makes the activity
 * systematic-experimental" prompt is the consent record.
 */
const HYPOTHESIS_PROMPT_VERSION = 'mobile@1.0.0';

function buildHypothesisClassification(): Classification {
  return {
    kind: 'HYPOTHESIS',
    confidence: 1.0,
    rationale: 'consultant-confirmed pre-experiment hypothesis',
    statutory_anchor: '§355-25(1)(a)',
    model: 'mobile-hypothesis-form',
    prompt_version: HYPOTHESIS_PROMPT_VERSION,
    tokens_in: 0,
    tokens_out: 0,
  };
}

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
 * Register POST /v1/mobile/events (T-A4 + T-A11).
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
 * Effect (variant-dependent):
 *   - source: 'voice'
 *     Inserts kind=SUPPORTING + payload = {_v:1, source:'voice_pending',
 *     audio_s3_key, captured_at_local} with classification=null.
 *     Best-effort enqueues the transcribe job, which patches payload
 *     to source='voice' once Deepgram returns. SUPPORTING is a
 *     placeholder — the classifier will reclassify downstream;
 *     OVERRIDE preserves the kind history if the placeholder was wrong.
 *
 *   - source: 'hypothesis_prompt'
 *     Inserts kind=HYPOTHESIS directly + classification synthesised
 *     inline (no LLM round-trip — the form IS the classification).
 *     statutory_anchor='§355-25(1)(a)' marks this as the systematic-
 *     experimental anchor for the chain.
 */
export function registerMobileEvents(app: FastifyInstance): void {
  app.post('/v1/mobile/events', { preHandler: requireMobileSession }, async (req, reply) => {
    const parsed = createMobileEventBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          errEnvelope(
            'INVALID_BODY',
            'Body must be { subject_tenant_id?, captured_at_local, payload: { source: "voice" | "hypothesis_prompt", ... } }',
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
          errEnvelope('FORBIDDEN', 'subject_tenant_id does not match employee binding', req.id),
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
      const existing = await privilegedSql<
        {
          id: string;
          captured_at: Date;
          received_at: Date;
          hash: string;
        }[]
      >`
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
            captured_at:
              e.captured_at instanceof Date ? e.captured_at.toISOString() : e.captured_at,
            received_at:
              e.received_at instanceof Date ? e.received_at.toISOString() : e.received_at,
            hash: e.hash,
          },
          duplicate: true,
        });
      }
    }

    // Branch on the discriminated-union variant. Voice → SUPPORTING
    // placeholder + transcribe enqueue. Hypothesis → HYPOTHESIS kind
    // + synthesised classification (no LLM round-trip).
    //
    // Both paths share the same row shape: kind, payload, classification.
    // The chain hash captures all three at insert time, so an OVERRIDE
    // event is required to change kind after the fact (audit invariant).
    const variant = body.payload;
    const isVoice = variant.source === 'voice';
    const eventKind: 'SUPPORTING' | 'HYPOTHESIS' = isVoice ? 'SUPPORTING' : 'HYPOTHESIS';
    const eventPayload: Record<string, unknown> = isVoice
      ? {
          _v: 1,
          source: 'voice_pending',
          audio_s3_key: variant.audio_s3_key,
          captured_at_local: body.captured_at_local,
        }
      : {
          _v: 1,
          source: 'hypothesis_prompt',
          predicted_outcome: variant.predicted_outcome,
          success_criteria: variant.success_criteria,
          uncertainty: variant.uncertainty,
          captured_at_local: body.captured_at_local,
        };
    const eventClassification = isVoice ? null : buildHypothesisClassification();

    // Mobile captures attribute to the employee, not a user. Migration
    // 0011 added `captured_by_employee_id` FK + a CHECK constraint
    // requiring exactly one of (captured_by_user_id, captured_by_employee_id)
    // to be set. The chain canonicaliser conditionally includes the
    // employee_id only when non-null, so existing P2 events
    // (employee_id always null) keep their original hashes.
    let inserted: { id: string; hash: string };
    try {
      const result = await insertEventWithChain({
        tenant_id: principal.tenantId,
        subject_tenant_id: subjectTenantId,
        kind: eventKind,
        payload: eventPayload,
        classification: eventClassification,
        captured_at: new Date(),
        captured_by_user_id: null,
        captured_by_employee_id: principal.employeeId,
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
        const winners = await privilegedSql<
          {
            id: string;
            captured_at: Date;
            received_at: Date;
            hash: string;
          }[]
        >`
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

    // Best-effort transcribe enqueue — voice variant only. The
    // placeholder getMediaBytes stub throws today; once S3 lands the
    // same call still works because the input shape is stable.
    // Hypothesis variant has no transcript phase — kind is already
    // HYPOTHESIS at insert time.
    if (isVoice) {
      enqueueTranscribeBestEffort(app, {
        audio_s3_key: variant.audio_s3_key,
        event_id: inserted.id,
        audio_mime_type: variant.audio_mime_type,
      });
    }

    // Read back the inserted row's timestamps so the client can
    // populate its local cache without a follow-up GET. captured_at /
    // received_at are server-side; the mobile UI uses captured_at_local
    // (in the payload) for its own offline-friendly ordering.
    const fresh = await privilegedSql<
      {
        captured_at: Date;
        received_at: Date;
      }[]
    >`
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
