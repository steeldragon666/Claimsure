/**
 * DocuSign client + webhook payload types (T-B4 / T-B5).
 *
 * Naming convention: external API surface is camelCase (matches DocuSign's
 * REST shape) only on the wire — our internal types use snake_case so the
 * client.ts mapping is the single layer that knows the DocuSign quirks.
 *
 * `base_url` distinguishes demo (`https://demo.docusign.net/restapi/v2.1`)
 * from production (`https://www.docusign.net/restapi/v2.1`); both append
 * `/accounts/{account_id}/...` for envelope operations. The account_id is
 * the GUID DocuSign returns from the userinfo endpoint after OAuth — we
 * persist it on `integration_connection.external_account_id` (B3).
 */

export type DocuSignClientOptions = {
  /** e.g. 'https://demo.docusign.net/restapi/v2.1' */
  base_url: string;
  /** The DocuSign-side account GUID (per-firm). */
  account_id: string;
  /** Decrypted access token from `integration_connection.access_token_encrypted`. */
  access_token: string;
};

/**
 * Two ways to create an envelope: from a saved DocuSign template
 * (`template_id` + recipient role binding) or by uploading a base64-encoded
 * PDF (`document_base64` + `document_name`). Exactly one of those branches
 * must be provided — the client throws otherwise.
 *
 * `custom_fields` flow through to `envelope.customFields.textCustomFields`
 * and surface back on the webhook payload so we can stash internal IDs
 * (e.g. `signing_request_id`) with the envelope without polluting the
 * recipient-visible blurb.
 */
export type CreateEnvelopeRequest = {
  template_id?: string;
  document_base64?: string;
  document_name?: string;
  recipient_email: string;
  recipient_name: string;
  subject: string;
  email_blurb?: string;
  custom_fields?: Record<string, string>;
};

export type CreateEnvelopeResponse = {
  envelope_id: string;
  status: string;
  uri: string;
};

/**
 * The lifecycle DocuSign reports for an envelope. Mirrors
 * `SIGNING_STATUSES` in @cpa/db/schema/signing_request.ts so the webhook
 * handler can persist directly without re-mapping.
 */
export type DocuSignEnvelopeStatus =
  | 'sent'
  | 'delivered'
  | 'completed'
  | 'declined'
  | 'voided'
  | 'expired';
