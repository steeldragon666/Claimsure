import type { FastifyInstance } from 'fastify';
import { sql, privilegedSql } from '@cpa/db/client';
import {
  finalizeMediaBody,
  presignedUploadBody,
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

const isoOf = (v: Date | string): string =>
  typeof v === 'string' ? v : v.toISOString();

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
function buildS3Key(args: {
  tenantId: string;
  subjectTenantId: string;
  sha256: string;
}): string {
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
        return reply.status(400).send(
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
  app.post(
    '/v1/media/finalize',
    { preHandler: requireMobileSession },
    async (req, reply) => {
      const parsed = finalizeMediaBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(
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
          .send(
            errEnvelope(
              'FORBIDDEN',
              's3_key does not match caller scope',
              req.id,
            ),
          );
      }

      // The trailing segment of our own keys is the sha256 — confirm
      // the client's claimed content_hash matches it. If it doesn't,
      // either the client lied at presign-time or the upload swapped
      // bytes between presign + finalize.
      const trailing = body.s3_key.slice(expectedPrefix.length);
      if (trailing !== body.content_hash) {
        return reply
          .status(400)
          .send(
            errEnvelope(
              'HASH_MISMATCH',
              'content_hash does not match s3_key suffix',
              req.id,
            ),
          );
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
            .send(
              errEnvelope(
                'EVENT_NOT_FOUND',
                'No event with that id in this firm',
                req.id,
              ),
            );
        }
      }

      // Insert under privileged sql — the employee binding gives us
      // tenant scoping at the JWT layer, and we need to write across
      // RLS for the insert path. The SELECT below uses RLS to read
      // back the inserted row.
      try {
        const inserted = await privilegedSql<RawMediaRow[]>`
          INSERT INTO media_artefact (
            tenant_id, subject_tenant_id, event_id, uploaded_by_employee_id,
            s3_key, content_hash, mime_type, size_bytes, exif,
            ocr_status, virus_scan_status
          ) VALUES (
            ${principal.tenantId},
            ${principal.subjectTenantId},
            ${body.event_id ?? null},
            ${principal.employeeId},
            ${body.s3_key},
            ${body.content_hash},
            ${body.mime_type},
            ${body.size_bytes},
            ${body.exif ? JSON.stringify(body.exif) : null}::jsonb,
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
            return reply
              .status(200)
              .send({ media: rowToArtefact(winner), duplicate: true });
          }
        }
        throw err;
      }
    },
  );
}
