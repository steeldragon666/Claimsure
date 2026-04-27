import { verifyDocuSignSignature } from '../runtime/webhook-verify.js';
import type { DocuSignEnvelopeStatus } from './types.js';

/**
 * DocuSign Connect webhook payload + parser (T-B5).
 *
 * DocuSign sends Connect callbacks as JSON (when configured for the
 * "JSON" data format — XML is legacy and not supported here). The body
 * carries the envelope's current state plus any custom fields we
 * stamped at creation.
 *
 * Signature verification:
 *   - HMAC-SHA256 over the raw request body, key from the Connect
 *     listener config (env DOCUSIGN_WEBHOOK_HMAC_SECRET).
 *   - Header: `X-DocuSign-Signature-1` (base64).
 *   - Constant-time compare via `verifyDocuSignSignature`.
 *
 * The split between `parseWebhookEvent` (pure, takes parsed JSON) and
 * `verifyAndParse` (Buffer-in, returns null on failure) lets API routes
 * compose verification + parsing without re-parsing JSON twice, while
 * unit tests can drive the parser directly.
 */
export type DocuSignWebhookPayload = {
  envelopeId: string;
  status: DocuSignEnvelopeStatus;
  statusChangedDateTime: string;
  customFields?: { textCustomFields?: Array<{ name: string; value: string }> };
};

export type ParsedDocuSignEvent = {
  envelope_id: string;
  status: DocuSignEnvelopeStatus;
  status_changed_at: Date;
  custom_fields: Record<string, string>;
};

export function parseWebhookEvent(payload: DocuSignWebhookPayload): ParsedDocuSignEvent {
  const customFields: Record<string, string> = {};
  for (const f of payload.customFields?.textCustomFields ?? []) {
    customFields[f.name] = f.value;
  }
  return {
    envelope_id: payload.envelopeId,
    status: payload.status,
    status_changed_at: new Date(payload.statusChangedDateTime),
    custom_fields: customFields,
  };
}

/**
 * One-shot verifier+parser. Returns `null` on either signature mismatch
 * or malformed JSON — callers treat both as "reject the webhook" and
 * return 401 (we deliberately collapse the cases so timing of the
 * response doesn't reveal which step failed).
 */
export function verifyAndParse(
  raw_body: Buffer,
  signature_header: string,
  hmac_secret: string,
): ParsedDocuSignEvent | null {
  if (
    !verifyDocuSignSignature({
      payload: raw_body,
      signature_header,
      secret: hmac_secret,
    })
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw_body.toString('utf8')) as DocuSignWebhookPayload;
    return parseWebhookEvent(parsed);
  } catch {
    return null;
  }
}
