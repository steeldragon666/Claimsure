import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import {
  SIGNING_DOCUMENT_KINDS,
  SIGNING_STATUSES,
  createSigningRequestBody,
  type DocumentKind,
  type SigningRequest,
  type SigningStatus,
} from '@cpa/schemas';
import { decryptToken, getTokenEncryptionKey } from '@cpa/integrations/runtime';
import { createEnvelope, verifyAndParse } from '@cpa/integrations/docusign';
import type { CreateEnvelopeRequest } from '@cpa/integrations/docusign';

/**
 * Signing-request routes (T-B6).
 *
 * Surface:
 *   POST /v1/signing/requests
 *     Consultant initiates a DocuSign envelope for a claimant document.
 *     Looks up the firm's docusign integration_connection, decrypts the
 *     access token, calls DocuSign Envelopes::create, then inserts a
 *     signing_request row keyed on the returned envelope_id.
 *
 *   GET /v1/signing/:id
 *     Returns the signing_request row (status, signed_at, signed_pdf_s3_key).
 *
 *   POST /v1/integrations/docusign/webhook
 *     DocuSign Connect callback. HMAC-verifies against
 *     DOCUSIGN_WEBHOOK_HMAC_SECRET, looks up signing_request by envelope_id,
 *     and updates status + signed_at. Skips downloading the signed PDF for
 *     v1 — that lands in a follow-up worker task once we have S3 wired.
 *
 * Auth: requireSession + admin/consultant on POST /v1/signing/requests
 *       (viewers can read via GET); the webhook is unauthed but
 *       HMAC-verified.
 */

interface RawSigningRequestRow {
  id: string;
  tenant_id: string;
  subject_tenant_id: string;
  initiated_by_user_id: string;
  recipient_email: string;
  document_kind: DocumentKind;
  docusign_envelope_id: string;
  status: SigningStatus;
  signed_at: Date | string | null;
  signed_pdf_s3_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : isoOf(v));

const coerceStatus = (v: string): SigningStatus => {
  if ((SIGNING_STATUSES as readonly string[]).includes(v)) return v as SigningStatus;
  throw new Error(`row has invalid signing_request.status: ${v}`);
};

const coerceKind = (v: string): DocumentKind => {
  if ((SIGNING_DOCUMENT_KINDS as readonly string[]).includes(v)) return v as DocumentKind;
  throw new Error(`row has invalid signing_request.document_kind: ${v}`);
};

const toApi = (r: RawSigningRequestRow): SigningRequest => ({
  id: r.id,
  tenant_id: r.tenant_id,
  subject_tenant_id: r.subject_tenant_id,
  initiated_by_user_id: r.initiated_by_user_id,
  recipient_email: r.recipient_email,
  document_kind: coerceKind(r.document_kind),
  docusign_envelope_id: r.docusign_envelope_id,
  status: coerceStatus(r.status),
  signed_at: isoOrNull(r.signed_at),
  signed_pdf_s3_key: r.signed_pdf_s3_key,
  created_at: isoOf(r.created_at),
  updated_at: isoOf(r.updated_at),
});

export function registerSigning(app: FastifyInstance): void {
  app.post('/v1/signing/requests', { preHandler: requireSession }, async (req, reply) => {
    const role = req.user!.role;
    if (role !== 'admin' && role !== 'consultant') {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Admin or consultant role required',
        requestId: req.id,
      });
    }

    const parsed = createSigningRequestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
        requestId: req.id,
      });
    }
    const body = parsed.data;
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    // Look up the firm's docusign integration_connection. We use
    // privilegedSql here intentionally: the query is exact-match on
    // (tenant_id, provider) so RLS isn't needed for safety, and the
    // route already gate-checked tenantId comes from the session JWT.
    // The integration_connection row carries the encrypted access token
    // we need to call DocuSign on the firm's behalf.
    const connRows = await privilegedSql<
      {
        access_token_encrypted: string;
        external_account_id: string | null;
        sync_state: string;
        last_error: string | null;
      }[]
    >`
      SELECT access_token_encrypted, external_account_id, sync_state, last_error
        FROM integration_connection
       WHERE tenant_id = ${tenantId} AND provider = 'docusign'
    `;
    const conn = connRows[0];
    if (!conn || conn.sync_state === 'failed' || conn.last_error === 'revoked') {
      return reply.status(412).send({
        error: 'docusign_not_connected',
        message:
          'No active DocuSign integration for this firm — connect via /v1/integrations/docusign/connect',
        requestId: req.id,
      });
    }

    let accessToken: string;
    try {
      accessToken = decryptToken(conn.access_token_encrypted, getTokenEncryptionKey());
    } catch (err) {
      req.log.error({ err }, 'failed to decrypt docusign access token');
      return reply.status(500).send({
        error: 'docusign_token_decrypt_failed',
        message: 'Stored DocuSign token could not be decrypted',
        requestId: req.id,
      });
    }

    // Account-id resolution: prefer the per-firm external_account_id
    // captured at OAuth time (B3 will populate this from /oauth/userinfo
    // once that lands); fall back to a platform default env var so dev
    // + initial demos have a sensible value before per-firm wiring.
    const accountId = conn.external_account_id ?? process.env['DOCUSIGN_ACCOUNT_ID'] ?? '';
    if (!accountId) {
      return reply.status(412).send({
        error: 'docusign_account_id_missing',
        message: 'No DocuSign account_id captured for this firm and no platform default set',
        requestId: req.id,
      });
    }
    const baseUrl =
      process.env['DOCUSIGN_API_BASE_URL'] ?? 'https://demo.docusign.net/restapi/v2.1';

    // Stamp the soon-to-be signing_request id as a custom field so the
    // webhook callback can correlate without re-querying by envelope_id.
    // Both lookups are supported (envelope_id is unique-indexed) but the
    // custom field is the cheaper hot path.
    const signingRequestId = crypto.randomUUID();
    const envelopeReq: CreateEnvelopeRequest = {
      recipient_email: body.recipient_email,
      recipient_name: body.recipient_name,
      subject: body.subject,
      custom_fields: { signing_request_id: signingRequestId },
    };
    if (body.email_blurb !== undefined) envelopeReq.email_blurb = body.email_blurb;
    if (body.template_id) {
      envelopeReq.template_id = body.template_id;
    } else if (body.document_base64 && body.document_name) {
      envelopeReq.document_base64 = body.document_base64;
      envelopeReq.document_name = body.document_name;
    }

    let envelope;
    try {
      envelope = await createEnvelope(
        { base_url: baseUrl, account_id: accountId, access_token: accessToken },
        envelopeReq,
      );
    } catch (err) {
      req.log.error({ err }, 'docusign createEnvelope failed');
      return reply.status(502).send({
        error: 'docusign_create_envelope_failed',
        message: 'Failed to create DocuSign envelope',
        requestId: req.id,
      });
    }

    // Insert under RLS: the signing_request row is tenant-scoped, so the
    // RLS policy guards even if the route's tenantId got tampered with.
    const inserted = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const rows = await tx<RawSigningRequestRow[]>`
        INSERT INTO signing_request (
          id, tenant_id, subject_tenant_id, initiated_by_user_id,
          recipient_email, document_kind, document_template_id,
          docusign_envelope_id, status
        ) VALUES (
          ${signingRequestId}, ${tenantId}, ${body.subject_tenant_id}, ${userId},
          ${body.recipient_email}, ${body.document_kind},
          ${body.template_id ?? null}, ${envelope.envelope_id}, 'sent'
        )
        RETURNING id, tenant_id, subject_tenant_id, initiated_by_user_id,
                  recipient_email, document_kind, docusign_envelope_id,
                  status, signed_at, signed_pdf_s3_key, created_at, updated_at
      `;
      return rows[0];
    });
    if (!inserted) {
      throw new Error('POST /v1/signing/requests: INSERT returned no row');
    }

    return reply.status(201).send({ signing_request: toApi(inserted) });
  });

  app.get<{ Params: { id: string } }>(
    '/v1/signing/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawSigningRequestRow[]>`
          SELECT id, tenant_id, subject_tenant_id, initiated_by_user_id,
                 recipient_email, document_kind, docusign_envelope_id,
                 status, signed_at, signed_pdf_s3_key, created_at, updated_at
            FROM signing_request
           WHERE id = ${id}
        `;
        const row = rows[0];
        if (!row) {
          return reply.status(404).send({
            error: 'signing_request_not_found',
            message: 'No signing request with that id in this firm',
            requestId: req.id,
          });
        }
        return { signing_request: toApi(row) };
      });
    },
  );
}

/**
 * Maps the DocuSign envelope status onto our signing_request.status enum.
 * Both have identical string values (we mirror the DocuSign vocabulary
 * exactly in @cpa/schemas), so this is just a runtime guard against
 * future drift.
 */
function mapEnvelopeStatusToSigningStatus(s: string): SigningStatus | null {
  return (SIGNING_STATUSES as readonly string[]).includes(s) ? (s as SigningStatus) : null;
}

/**
 * Webhook plugin (T-B6).
 *
 * Registered as a separate Fastify-encapsulated plugin so we can override
 * the application/json content-type parser for this single route — DocuSign
 * Connect signs the raw bytes, so we MUST hold the original Buffer to verify
 * the HMAC. Default JSON parsing produces an object; the raw bytes are
 * lost. Encapsulation keeps the override scoped: every other route still
 * gets normal JSON parsing.
 */
export function registerDocuSignWebhookPlugin(app: FastifyInstance): void {
  app.register((instance, _opts, done) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, doneCb) => {
        // Body arrives as Buffer (because parseAs:'buffer'). We pass it
        // through unchanged as req.body so the route handler can verify
        // the HMAC against the exact bytes DocuSign signed.
        doneCb(null, body);
      },
    );

    instance.post('/v1/integrations/docusign/webhook', async (req, reply) => {
      const secret = process.env['DOCUSIGN_WEBHOOK_HMAC_SECRET'];
      if (!secret) {
        req.log.error('DOCUSIGN_WEBHOOK_HMAC_SECRET not set — refusing webhook');
        return reply.status(500).send({
          error: 'docusign_webhook_misconfigured',
          message: 'Server is missing DOCUSIGN_WEBHOOK_HMAC_SECRET',
          requestId: req.id,
        });
      }

      // Headers come in lowercase via Fastify; DocuSign Connect emits
      // X-DocuSign-Signature-1 (and may emit -2 for HMAC key rotation,
      // but v1 only verifies -1).
      const sigHeader = req.headers['x-docusign-signature-1'];
      const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      if (!signature) {
        return reply.status(401).send({
          error: 'missing_signature',
          message: 'X-DocuSign-Signature-1 header required',
          requestId: req.id,
        });
      }

      const rawBody = req.body;
      if (!Buffer.isBuffer(rawBody)) {
        // Defensive: with parseAs:'buffer' wired we should always get a
        // Buffer, but defend against an empty/null body shape so we
        // never call verify on a non-Buffer.
        return reply.status(400).send({
          error: 'invalid_body',
          message: 'Webhook body missing',
          requestId: req.id,
        });
      }

      const event = verifyAndParse(rawBody, signature, secret);
      if (!event) {
        return reply.status(401).send({
          error: 'invalid_signature',
          message: 'Webhook signature invalid or body malformed',
          requestId: req.id,
        });
      }

      const newStatus = mapEnvelopeStatusToSigningStatus(event.status);
      if (!newStatus) {
        // Defensive: DocuSign occasionally emits non-canonical statuses
        // (e.g. 'created'). We log + 200 so DocuSign doesn't retry the
        // webhook indefinitely; the row stays in its current status.
        req.log.warn({ status: event.status }, 'unmapped DocuSign envelope status — ignoring');
        return reply.status(200).send({ ok: true });
      }

      const signedAt = newStatus === 'completed' ? event.status_changed_at.toISOString() : null;

      // Update by envelope_id (globally unique). privilegedSql so the
      // webhook can update across tenants without juggling RLS GUC —
      // the HMAC verification is the trust boundary.
      const rows = await privilegedSql<{ id: string; tenant_id: string }[]>`
        UPDATE signing_request
           SET status = ${newStatus},
               signed_at = COALESCE(${signedAt}::timestamptz, signed_at),
               updated_at = NOW()
         WHERE docusign_envelope_id = ${event.envelope_id}
        RETURNING id, tenant_id
      `;
      if (!rows[0]) {
        // Unknown envelope_id — likely a webhook from a stale envelope or
        // a different environment. 200 (don't make DocuSign retry) but
        // log so ops can spot it.
        req.log.warn(
          { envelope_id: event.envelope_id, status: event.status },
          'webhook for unknown signing_request — ignoring',
        );
        return reply.status(200).send({ ok: true, matched: false });
      }

      return reply.status(200).send({ ok: true, matched: true });
    });

    done();
  });
}
