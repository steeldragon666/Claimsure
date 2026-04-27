import { z } from 'zod';
import { Iso8601, Uuid } from './primitives.js';

/**
 * Document-signing schemas (T-B6).
 *
 * Mirrors DB enums in @cpa/db/schema/signing_request.ts (`SIGNING_DOCUMENT_KINDS`,
 * `SIGNING_STATUSES`). The DB CHECK is the source of truth — keep in sync.
 *
 * Naming: snake_case on the wire (consistent with the rest of the API).
 */
export const SIGNING_DOCUMENT_KINDS = [
  'engagement_letter',
  'representation_letter',
  'rfi_response',
  'custom',
] as const;
export const documentKind = z.enum(SIGNING_DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof documentKind>;

export const SIGNING_STATUSES = [
  'sent',
  'delivered',
  'completed',
  'declined',
  'voided',
  'expired',
] as const;
export const signingStatus = z.enum(SIGNING_STATUSES);
export type SigningStatus = z.infer<typeof signingStatus>;

/**
 * Public shape of a `signing_request` row over the API.
 *
 * No tokens or HMAC secrets surface here; only the metadata + completion
 * artefact pointer (`signed_pdf_s3_key`).
 */
export const signingRequest = z.object({
  id: Uuid,
  tenant_id: Uuid,
  subject_tenant_id: Uuid,
  initiated_by_user_id: Uuid,
  recipient_email: z.string().email(),
  document_kind: documentKind,
  docusign_envelope_id: z.string(),
  status: signingStatus,
  signed_at: Iso8601.nullable(),
  signed_pdf_s3_key: z.string().nullable(),
  created_at: Iso8601,
  updated_at: Iso8601,
});
export type SigningRequest = z.infer<typeof signingRequest>;

/**
 * POST /v1/signing/requests body.
 *
 * Refinement enforces the same XOR the DocuSign client requires:
 * either a saved template (`template_id`) OR an inline base64-encoded
 * PDF (`document_base64` + `document_name`). Both must not be empty
 * strings — Zod's `.optional()` only excludes undefined.
 */
export const createSigningRequestBody = z
  .object({
    subject_tenant_id: Uuid,
    recipient_email: z.string().email(),
    recipient_name: z.string().min(1).max(200),
    document_kind: documentKind,
    template_id: z.string().min(1).optional(),
    document_base64: z.string().min(1).optional(),
    document_name: z.string().min(1).optional(),
    subject: z.string().min(1).max(200),
    email_blurb: z.string().max(2000).optional(),
  })
  .refine(
    (v) => Boolean(v.template_id) || (Boolean(v.document_base64) && Boolean(v.document_name)),
    { message: 'either template_id OR (document_base64 + document_name) required' },
  );
export type CreateSigningRequestBody = z.infer<typeof createSigningRequestBody>;
