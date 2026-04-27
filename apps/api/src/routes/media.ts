import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import {
  finalizeMediaBody,
  listMediaQuery,
  presignedUploadBody,
  Uuid,
  type MediaArtefact,
} from '@cpa/schemas';
import { requireMobileSession } from '../middleware/mobile-jwt-verifier.js';

/**
 * Media upload + CRUD routes (T-A6, T-A8).
 *
 * Two surfaces share the file:
 *   - Upload pipeline (presigned → PUT → finalize), authed via mobile
 *     JWT. The employee-side capture screens drive these endpoints.
 *   - Consultant CRUD (list / detail / delete), authed via consultant
 *     OIDC session. Lands in A8 alongside this file.
 *
 * S3 stub: the v1 pre-signed URL is a placeholder
 * `https://placeholder.s3.amazonaws.com/<key>`. The mobile client's
 * PUT to it will fail at the network layer; the upload helper swallows
 * that error so the rest of the pipeline (finalize → media_artefact
 * row → OCR queue) still exercises the contract end-to-end. Once the
 * real S3 client lands, only this route changes — the mobile flow is
 * already shaped for a real PUT.
 */

const errEnvelope = (
  code: string,
  message: string,
  requestId: string,
): { error: { code: string; message: string }; requestId: string } => ({
  error: { code, message },
  requestId,
});

// postgres-js may return timestamptz columns as either a Date object
// or a postgres-native string ("2026-04-27 15:10:41.128715+00", with a
// space separator instead of the ISO 8601 'T'). Normalise both to ISO
// so API consumers see a single, regex-checkable format.
const isoOf = (v: Date | string): string =>
  typeof v === 'string' ? new Date(v).toISOString() : v.toISOString();

interface RawMediaRow {
  id: string;
  tenant_id: string;
  subject_tenant_id: string;
  event_id: string | null;
  uploaded_by_employee_id: string;
  s3_key: string;
  content_hash: string;
  mime_type: string;
  size_bytes: number | string;
  exif: unknown;
  ocr_text: string | null;
  ocr_status: 'pending' | 'complete' | 'failed' | 'skipped';
  virus_scan_status: 'pending' | 'clean' | 'infected' | 'failed';
  uploaded_at: Date | string;
}

const rowToArtefact = (r: RawMediaRow): MediaArtefact => ({
  id: r.id,
  tenant_id: r.tenant_id,
  subject_tenant_id: r.subject_tenant_id,
  event_id: r.event_id,
  uploaded_by_employee_id: r.uploaded_by_employee_id,
  s3_key: r.s3_key,
  content_hash: r.content_hash,
  mime_type: r.mime_type,
  // bigint columns come back as `number | string` depending on the
  // postgres-js parser config — coerce uniformly.
  size_bytes: typeof r.size_bytes === 'string' ? Number(r.size_bytes) : r.size_bytes,
  exif:
    r.exif && typeof r.exif === 'object' && !Array.isArray(r.exif)
      ? (r.exif as Record<string, unknown>)
      : null,
  ocr_text: r.ocr_text,
  ocr_status: r.ocr_status,
  virus_scan_status: r.virus_scan_status,
  uploaded_at: isoOf(r.uploaded_at),
});

/**
 * Build the canonical S3 key for an upload.
 *
 * Format: `tenants/<tenant_id>/subjects/<subject_tenant_id>/<sha256>`.
 * The hash-suffix means re-uploads of identical bytes resolve to the
 * same key, which lines up with the
 * `media_artefact_content_dedupe_unique` index (tenant + subject + hash
 * is unique). If two events reference the same artefact, both rows
 * point at one S3 object.
 */
function buildS3Key(args: { tenantId: string; subjectTenantId: string; sha256: string }): string {
  return `tenants/${args.tenantId}/subjects/${args.subjectTenantId}/${args.sha256}`;
}

/**
 * Stub presigned URL. v1 returns a placeholder under the
 * `placeholder.s3.amazonaws.com` host; the mobile client's PUT to it
 * will fail (DNS / network) but the upload helper swallows that so
 * the finalize step still runs. Once the real S3 client lands this
 * helper switches to `getSignedUrl(...)`.
 */
function stubPresignedUrl(s3Key: string): string {
  return `https://placeholder.s3.amazonaws.com/${s3Key}`;
}

export function registerMedia(app: FastifyInstance): void {
  /**
   * POST /v1/media/presigned-upload — mobile auth.
   *
   * Returns the URL the client should PUT bytes to + the canonical
   * s3_key it should reference at finalize-time. The route is
   * idempotent: same body → same s3_key (because the key is hashed
   * over the file).
   */
  app.post(
    '/v1/media/presigned-upload',
    { preHandler: requireMobileSession },
    async (req, reply) => {
      const parsed = presignedUploadBody.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(
            errEnvelope(
              'INVALID_BODY',
              'Body must be { content_type, size_bytes (≤ 50MB), sha256 (64 hex) }',
              req.id,
            ),
          );
      }
      const principal = req.mobileUser!;
      const { sha256 } = parsed.data;
      const s3Key = buildS3Key({
        tenantId: principal.tenantId,
        subjectTenantId: principal.subjectTenantId,
        sha256,
      });

      return reply.status(200).send({
        upload_url: stubPresignedUrl(s3Key),
        s3_key: s3Key,
        content_hash_required: sha256,
      });
    },
  );

  /**
   * POST /v1/media/finalize — mobile auth.
   *
   * Inserts the media_artefact row + returns it. Idempotent on the
   * (tenant, subject, content_hash) unique index — re-finalizing the
   * same upload returns the existing row (status 200) rather than
   * creating a duplicate.
   *
   * `event_id`, when supplied, is verified against the same RLS scope
   * the employee's mobile session sees — cross-firm attaches are
   * rejected with 404 (the event's tenant doesn't match the JWT's
   * tenant).
   */
  app.post('/v1/media/finalize', { preHandler: requireMobileSession }, async (req, reply) => {
    const parsed = finalizeMediaBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          errEnvelope(
            'INVALID_BODY',
            'Body must be { s3_key, content_hash (64 hex), mime_type, size_bytes, exif?, event_id? }',
            req.id,
          ),
        );
    }
    const principal = req.mobileUser!;
    const body = parsed.data;

    // Verify the s3_key is one we issued for this caller. The key
    // format encodes tenant + subject + hash, so a key that doesn't
    // start with the caller's prefix is either spoofed or stale.
    const expectedPrefix = `tenants/${principal.tenantId}/subjects/${principal.subjectTenantId}/`;
    if (!body.s3_key.startsWith(expectedPrefix)) {
      return reply
        .status(403)
        .send(errEnvelope('FORBIDDEN', 's3_key does not match caller scope', req.id));
    }

    // The trailing segment of our own keys is the sha256 — confirm
    // the client's claimed content_hash matches it. If it doesn't,
    // either the client lied at presign-time or the upload swapped
    // bytes between presign + finalize.
    const trailing = body.s3_key.slice(expectedPrefix.length);
    if (trailing !== body.content_hash) {
      return reply
        .status(400)
        .send(errEnvelope('HASH_MISMATCH', 'content_hash does not match s3_key suffix', req.id));
    }

    // Optional event_id check. The RLS-scoped SELECT serves as both
    // existence + cross-firm guard.
    if (body.event_id) {
      const eventVisible = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${principal.tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
            SELECT id FROM event WHERE id = ${body.event_id!}
          `;
        return rows[0] != null;
      });
      if (!eventVisible) {
        return reply
          .status(404)
          .send(errEnvelope('EVENT_NOT_FOUND', 'No event with that id in this firm', req.id));
      }
    }

    // Insert under privileged sql — the employee binding gives us
    // tenant scoping at the JWT layer, and we need to write across
    // RLS for the insert path. The SELECT below uses RLS to read
    // back the inserted row.
    try {
      // The Drizzle schema's `id` column has `$defaultFn(() => crypto.randomUUID())`
      // — a TS-side default that fires for `db.insert(mediaArtefact)` paths. The
      // raw INSERT below bypasses that, so we must supply the uuid explicitly to
      // avoid a not-null constraint violation. (Migration 0008 declares
      // id PRIMARY KEY NOT NULL with no DB-level default.)
      const inserted = await privilegedSql<RawMediaRow[]>`
          INSERT INTO media_artefact (
            id, tenant_id, subject_tenant_id, event_id, uploaded_by_employee_id,
            s3_key, content_hash, mime_type, size_bytes, exif,
            ocr_status, virus_scan_status
          ) VALUES (
            ${crypto.randomUUID()},
            ${principal.tenantId},
            ${principal.subjectTenantId},
            ${body.event_id ?? null},
            ${principal.employeeId},
            ${body.s3_key},
            ${body.content_hash},
            ${body.mime_type},
            ${body.size_bytes},
            ${body.exif ? privilegedSql.json(body.exif as Record<string, never>) : null},
            'pending',
            'pending'
          )
          RETURNING
            id, tenant_id, subject_tenant_id, event_id, uploaded_by_employee_id,
            s3_key, content_hash, mime_type, size_bytes, exif,
            ocr_text, ocr_status, virus_scan_status, uploaded_at
        `;
      const row = inserted[0]!;
      return await reply.status(201).send({ media: rowToArtefact(row) });
    } catch (err) {
      // Unique violation on (tenant, subject, content_hash) — a prior
      // finalize already inserted this row. Return 200 + existing
      // row for idempotency.
      if ((err as { code?: string }).code === '23505') {
        const existing = await privilegedSql<RawMediaRow[]>`
            SELECT
              id, tenant_id, subject_tenant_id, event_id, uploaded_by_employee_id,
              s3_key, content_hash, mime_type, size_bytes, exif,
              ocr_text, ocr_status, virus_scan_status, uploaded_at
              FROM media_artefact
             WHERE tenant_id = ${principal.tenantId}
               AND subject_tenant_id = ${principal.subjectTenantId}
               AND content_hash = ${body.content_hash}
          `;
        const winner = existing[0];
        if (winner) {
          return reply.status(200).send({ media: rowToArtefact(winner), duplicate: true });
        }
      }
      throw err;
    }
  });

  // ---------------- Consultant CRUD (T-A8) ----------------

  /**
   * GET /v1/media?subject_tenant_id=… — consultant session.
   *
   * Lists media artefacts for the given claimant, RLS-scoped to the
   * caller's active firm. Cross-firm subjects come back as 0 rows
   * (RLS filters silently — no leakage of claimant existence).
   *
   * Returns rows ordered by upload time desc (newest first) so the
   * consultant UI's default "recent uploads" view is one query.
   * Pagination is deferred — the v1 vault stays small enough that
   * a single page is fine. Add cursor pagination once a claimant
   * regularly hits 100+ artefacts.
   */
  app.get('/v1/media', { preHandler: requireSession }, async (req, reply) => {
    const parsed = listMediaQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(errEnvelope('INVALID_QUERY', 'Query must be { subject_tenant_id: uuid }', req.id));
    }
    const { subject_tenant_id } = parsed.data;
    const tenantId = req.user!.tenantId!;

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return await tx<RawMediaRow[]>`
        SELECT
          id, tenant_id, subject_tenant_id, event_id, uploaded_by_employee_id,
          s3_key, content_hash, mime_type, size_bytes, exif,
          ocr_text, ocr_status, virus_scan_status, uploaded_at
          FROM media_artefact
         WHERE subject_tenant_id = ${subject_tenant_id}
         ORDER BY uploaded_at DESC
      `;
    });

    return reply.status(200).send({ media: rows.map(rowToArtefact) });
  });

  /**
   * GET /v1/media/:id — consultant session.
   *
   * Returns the row + a stub download URL. The download URL is
   * conventional `https://placeholder.s3.amazonaws.com/<s3_key>` —
   * once the real S3 client lands, this becomes a 5-minute
   * pre-signed GET. The contract shape stays the same.
   *
   * 404 covers both "doesn't exist" and "exists in another firm";
   * RLS filters silently and we don't distinguish (no claimant-
   * existence leak).
   */
  app.get<{ Params: { id: string } }>(
    '/v1/media/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const idParsed = Uuid.safeParse(req.params.id);
      if (!idParsed.success) {
        return reply.status(400).send(errEnvelope('INVALID_PARAM', 'id must be a UUID v4', req.id));
      }
      const tenantId = req.user!.tenantId!;
      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return await tx<RawMediaRow[]>`
          SELECT
            id, tenant_id, subject_tenant_id, event_id, uploaded_by_employee_id,
            s3_key, content_hash, mime_type, size_bytes, exif,
            ocr_text, ocr_status, virus_scan_status, uploaded_at
            FROM media_artefact
           WHERE id = ${idParsed.data}
        `;
      });
      const row = rows[0];
      if (!row) {
        return reply
          .status(404)
          .send(errEnvelope('NOT_FOUND', 'No media with that id in this firm', req.id));
      }
      return reply.status(200).send({
        media: rowToArtefact(row),
        download_url: stubPresignedUrl(row.s3_key),
      });
    },
  );

  /**
   * DELETE /v1/media/:id — consultant session.
   *
   * Hard delete. The schema has no `deleted_at` column on
   * media_artefact (per design doc — vault deletes are rare and
   * audit-logged at the chain level via a separate event), so we
   * issue an actual DELETE.
   *
   * RLS scopes the delete to the caller's tenant; cross-firm
   * deletes return 404 (the row count comes back 0). Idempotent: a
   * second delete of the same id also returns 404.
   *
   * The S3 object isn't cleaned up — that's a follow-up sweeper
   * job. Orphan keys are cheap; orphan rows would be a problem.
   */
  app.delete<{ Params: { id: string } }>(
    '/v1/media/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const idParsed = Uuid.safeParse(req.params.id);
      if (!idParsed.success) {
        return reply.status(400).send(errEnvelope('INVALID_PARAM', 'id must be a UUID v4', req.id));
      }
      const tenantId = req.user!.tenantId!;
      const deleted = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          DELETE FROM media_artefact WHERE id = ${idParsed.data} RETURNING id
        `;
        return rows[0] ?? null;
      });
      if (!deleted) {
        return reply
          .status(404)
          .send(errEnvelope('NOT_FOUND', 'No media with that id in this firm', req.id));
      }
      return reply.status(200).send({ deleted: true });
    },
  );
}
