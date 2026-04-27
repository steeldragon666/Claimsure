import { withRetry } from '../runtime/retry.js';
import type {
  CreateEnvelopeRequest,
  CreateEnvelopeResponse,
  DocuSignClientOptions,
} from './types.js';

/**
 * DocuSign Envelopes API client (T-B4).
 *
 * Two operations:
 *
 *   - `createEnvelope`: send a document for signature. Supports both the
 *     template-driven path (`template_id` + recipient role) and the
 *     ad-hoc path (raw PDF uploaded as `document_base64`). Wrapped in
 *     `withRetry` because DocuSign's 5xx rate is non-trivial in sandbox
 *     and we never want a transient blip to surface as a user-visible
 *     "send failed".
 *
 *   - `getSignedDocument`: download the signed PDF after `completed`.
 *     Returns a Buffer ready to upload to S3. NOT retried — the caller
 *     (webhook handler / completion worker) controls retry/backoff at
 *     a higher level so we don't double-retry against the same envelope.
 *
 * Auth: Bearer access token. The caller is responsible for refreshing
 * via `integration_connection` before invoking — the client itself
 * surfaces 401 as a thrown error rather than re-reading from DB (keeps
 * the runtime helper free of DB dependencies).
 */

type DocuSignCreateEnvelopeBody = {
  emailSubject: string;
  emailBlurb?: string;
  status: 'sent' | 'created';
  templateId?: string;
  templateRoles?: Array<{ email: string; name: string; roleName: string }>;
  documents?: Array<{
    documentId: string;
    name: string;
    documentBase64: string;
    fileExtension: string;
  }>;
  recipients?: {
    signers: Array<{
      recipientId: string;
      email: string;
      name: string;
      routingOrder: string;
    }>;
  };
  customFields?: {
    textCustomFields: Array<{ name: string; value: string; show: string }>;
  };
};

export async function createEnvelope(
  opts: DocuSignClientOptions,
  req: CreateEnvelopeRequest,
): Promise<CreateEnvelopeResponse> {
  const url = `${opts.base_url}/accounts/${opts.account_id}/envelopes`;

  const body: DocuSignCreateEnvelopeBody = {
    emailSubject: req.subject,
    status: 'sent',
  };
  if (req.email_blurb !== undefined) body.emailBlurb = req.email_blurb;

  if (req.template_id) {
    body.templateId = req.template_id;
    body.templateRoles = [
      {
        email: req.recipient_email,
        name: req.recipient_name,
        roleName: 'Signer',
      },
    ];
  } else if (req.document_base64 && req.document_name) {
    body.documents = [
      {
        documentId: '1',
        name: req.document_name,
        documentBase64: req.document_base64,
        fileExtension: 'pdf',
      },
    ];
    body.recipients = {
      signers: [
        {
          recipientId: '1',
          email: req.recipient_email,
          name: req.recipient_name,
          routingOrder: '1',
        },
      ],
    };
  } else {
    throw new Error(
      'createEnvelope: either template_id or (document_base64 + document_name) required',
    );
  }

  if (req.custom_fields) {
    body.customFields = {
      textCustomFields: Object.entries(req.custom_fields).map(([name, value]) => ({
        name,
        value,
        // `show: 'false'` keeps the field internal — not rendered to the
        // signer, but echoed back on Connect webhook callbacks. This is
        // how we round-trip our internal `signing_request_id`.
        show: 'false',
      })),
    };
  }

  const res = await withRetry(() =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`docusign create envelope: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as {
    envelopeId: string;
    status: string;
    uri: string;
  };
  return {
    envelope_id: data.envelopeId,
    status: data.status,
    uri: data.uri,
  };
}

/**
 * Download the combined signed PDF for an envelope. `documents/combined`
 * returns a single PDF with all documents in the envelope merged — exactly
 * what we want for the audit-chain artefact. Returns a Buffer suitable
 * for direct S3 upload (no streaming required at v1 — engagement letters
 * are small).
 */
export async function getSignedDocument(
  opts: DocuSignClientOptions,
  envelopeId: string,
): Promise<Buffer> {
  const url = `${opts.base_url}/accounts/${opts.account_id}/envelopes/${envelopeId}/documents/combined`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.access_token}` },
  });
  if (!res.ok) {
    throw new Error(`docusign get document: ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
