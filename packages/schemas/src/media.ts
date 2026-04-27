import { z } from 'zod';
import { Iso8601, Sha256Hash, Uuid } from './primitives.js';

/**
 * Media upload schemas (T-A6, T-A8).
 *
 * Three-step lifecycle:
 *   1. POST /v1/media/presigned-upload — client declares intent, server
 *      returns an S3 PUT URL the client can stream bytes to. The hash
 *      the client claims here is verified-on-finalize (not on the PUT,
 *      which goes direct to S3 and never touches our app).
 *   2. Client PUTs bytes to the returned URL.
 *   3. POST /v1/media/finalize — client tells the API the upload is
 *      complete; the API inserts a media_artefact row with
 *      ocr_status='pending' for the OCR worker (A9) to pick up.
 *
 * Splitting upload from finalize lets the bytes flow direct-to-S3
 * without round-tripping through our Fastify API, while still giving
 * us a server-side row creation hook to enqueue OCR / virus-scan jobs.
 *
 * For v1 the pre-signed URL is a placeholder; the actual S3 client
 * lands as a follow-up (no infra in this swimlane). The API still
 * returns a fully-shaped response so the mobile client can be tested
 * end-to-end against the contract.
 */

/**
 * Body for POST /v1/media/presigned-upload.
 *
 * `content_type`: must look like `image/...`, `video/...`, or
 * `application/...` (PDFs, DOCX). Plain text / unknown types are
 * rejected — the vault is for evidence artefacts, not arbitrary blobs.
 *
 * `size_bytes`: capped at 50 MB. A photo from a modern phone is
 * ~3-5 MB; a PDF or short video sits well under. Anything bigger is
 * either a mistake or a future video-clip feature that needs its
 * own pipeline.
 *
 * `sha256`: client-computed hex digest of the file. The
 * `media_artefact.content_dedupe_unique` index uses this to dedupe
 * re-uploads of the same file within a (tenant, subject_tenant)
 * tuple — without a client-supplied hash we'd have to receive the
 * bytes server-side first to dedupe, which defeats the direct-to-S3
 * design.
 */
export const presignedUploadBody = z.object({
  content_type: z
    .string()
    .regex(/^(image|video|application)\/.+/, 'must be image/*, video/*, or application/*'),
  size_bytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024, 'must be ≤ 50 MB'),
  sha256: Sha256Hash,
});
export type PresignedUploadBody = z.infer<typeof presignedUploadBody>;

/**
 * Response for POST /v1/media/presigned-upload.
 *
 * `s3_key` is the canonical key the client will reference in the
 * finalize call. It's namespaced
 * `tenants/<tenant_id>/subjects/<subject_id>/<sha256>` so cross-tenant
 * leakage is impossible even if RLS is disabled (defence in depth).
 *
 * `content_hash_required` echoes the client's claimed hash so finalize
 * can match the two and reject any tampering between presign + finalize.
 */
export const presignedUploadResponse = z.object({
  upload_url: z.string().url(),
  s3_key: z.string(),
  content_hash_required: Sha256Hash,
});
export type PresignedUploadResponse = z.infer<typeof presignedUploadResponse>;

/**
 * Body for POST /v1/media/finalize.
 *
 * `content_hash` must match the `sha256` claimed at presign-time. The
 * route enforces this by storing the claimed hash keyed on s3_key in
 * memory (v1) — once the real S3 client lands, this becomes a HEAD
 * request to S3 to read the object's ETag and compare.
 *
 * `event_id` is optional: an upload may be tied to an event (the
 * common case — photo of a whiteboard supporting a HYPOTHESIS event)
 * or stand alone (independent vault upload).
 *
 * `exif` is opaque jsonb — the camera plate-of-spaghetti from
 * expo-camera, stored verbatim. The assurance report (P5) reads
 * specific keys (GPS, capture time) but the column is a record-of-
 * unknown to allow forward-compat with new EXIF fields.
 */
export const finalizeMediaBody = z.object({
  s3_key: z.string().min(1).max(1024),
  content_hash: Sha256Hash,
  mime_type: z.string().min(1).max(128),
  size_bytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
  exif: z.record(z.unknown()).optional(),
  event_id: Uuid.optional(),
});
export type FinalizeMediaBody = z.infer<typeof finalizeMediaBody>;

/**
 * Single media_artefact row as returned by the API.
 *
 * Mirrors the DB schema (packages/db/src/schema/media_artefact.ts)
 * but with timestamps as ISO strings (audit-chain rule: every
 * timestamp the API emits is offset-anchored ISO-8601).
 */
export const mediaArtefact = z.object({
  id: Uuid,
  tenant_id: Uuid,
  subject_tenant_id: Uuid,
  event_id: Uuid.nullable(),
  uploaded_by_employee_id: Uuid,
  s3_key: z.string(),
  content_hash: Sha256Hash,
  mime_type: z.string(),
  size_bytes: z.number(),
  exif: z.record(z.unknown()).nullable(),
  ocr_text: z.string().nullable(),
  ocr_status: z.enum(['pending', 'complete', 'failed', 'skipped']),
  virus_scan_status: z.enum(['pending', 'clean', 'infected', 'failed']),
  uploaded_at: Iso8601,
});
export type MediaArtefact = z.infer<typeof mediaArtefact>;

/**
 * Query for GET /v1/media (list, T-A8).
 *
 * `subject_tenant_id` is required — the consultant UI is always
 * scoped to a claimant; a "list all media in firm" endpoint would
 * be a footgun (RLS would still scope it, but the route shape makes
 * the scoping intent explicit).
 */
export const listMediaQuery = z.object({
  subject_tenant_id: Uuid,
});
export type ListMediaQuery = z.infer<typeof listMediaQuery>;
