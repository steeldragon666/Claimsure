import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { createEnvelope, getSignedDocument } from './client.js';
import type { DocuSignClientOptions } from './types.js';

const BASE = 'https://demo.docusign.net/restapi/v2.1';
const ACCOUNT_ID = 'acct-guid-123';

const opts = (): DocuSignClientOptions => ({
  base_url: BASE,
  account_id: ACCOUNT_ID,
  access_token: 'fake-token',
});

beforeEach(() => {
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

test('createEnvelope: template path returns parsed envelope_id + sends correct body', async () => {
  let capturedBody: Record<string, unknown> | null = null;
  nock('https://demo.docusign.net')
    .post(`/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes`, (body: unknown) => {
      capturedBody = body as Record<string, unknown>;
      return true;
    })
    .matchHeader('authorization', 'Bearer fake-token')
    .reply(201, {
      envelopeId: 'env-abc-123',
      status: 'sent',
      uri: `/accounts/${ACCOUNT_ID}/envelopes/env-abc-123`,
    });

  const res = await createEnvelope(opts(), {
    template_id: 'tpl-xyz',
    recipient_email: 'signer@example.com',
    recipient_name: 'Sam Signer',
    subject: 'Please sign',
    email_blurb: 'Hi Sam, quick sig request',
    custom_fields: { signing_request_id: 'sr-1' },
  });

  assert.equal(res.envelope_id, 'env-abc-123');
  assert.equal(res.status, 'sent');
  assert.equal(res.uri, `/accounts/${ACCOUNT_ID}/envelopes/env-abc-123`);
  assert.ok(capturedBody, 'request body was captured');
  const body = capturedBody as Record<string, unknown>;
  assert.equal(body['templateId'], 'tpl-xyz');
  assert.equal(body['emailSubject'], 'Please sign');
  assert.equal(body['emailBlurb'], 'Hi Sam, quick sig request');
  assert.equal(body['status'], 'sent');
  const roles = body['templateRoles'] as Array<{ email: string; roleName: string }>;
  assert.equal(roles[0]?.email, 'signer@example.com');
  assert.equal(roles[0]?.roleName, 'Signer');
  const cf = body['customFields'] as {
    textCustomFields: Array<{ name: string; value: string; show: string }>;
  };
  assert.equal(cf.textCustomFields[0]?.name, 'signing_request_id');
  assert.equal(cf.textCustomFields[0]?.value, 'sr-1');
  assert.equal(cf.textCustomFields[0]?.show, 'false');
});

test('createEnvelope: document_base64 path uploads PDF + signers', async () => {
  let capturedBody: Record<string, unknown> | null = null;
  nock('https://demo.docusign.net')
    .post(`/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes`, (body: unknown) => {
      capturedBody = body as Record<string, unknown>;
      return true;
    })
    .reply(201, {
      envelopeId: 'env-doc-1',
      status: 'sent',
      uri: '/uri-1',
    });

  const res = await createEnvelope(opts(), {
    document_base64: 'JVBERi0xLjQK',
    document_name: 'engagement-letter.pdf',
    recipient_email: 'r@example.com',
    recipient_name: 'R Person',
    subject: 'Sign this',
  });

  assert.equal(res.envelope_id, 'env-doc-1');
  assert.ok(capturedBody);
  const body = capturedBody as Record<string, unknown>;
  const docs = body['documents'] as Array<{
    documentId: string;
    name: string;
    documentBase64: string;
    fileExtension: string;
  }>;
  assert.equal(docs[0]?.documentId, '1');
  assert.equal(docs[0]?.name, 'engagement-letter.pdf');
  assert.equal(docs[0]?.documentBase64, 'JVBERi0xLjQK');
  assert.equal(docs[0]?.fileExtension, 'pdf');
  const recips = body['recipients'] as {
    signers: Array<{ recipientId: string; email: string; routingOrder: string }>;
  };
  assert.equal(recips.signers[0]?.recipientId, '1');
  assert.equal(recips.signers[0]?.email, 'r@example.com');
});

test('createEnvelope: throws when neither template nor document supplied', async () => {
  await assert.rejects(
    createEnvelope(opts(), {
      recipient_email: 'r@example.com',
      recipient_name: 'R Person',
      subject: 'oops',
    }),
    /either template_id or \(document_base64 \+ document_name\) required/,
  );
});

test(
  'createEnvelope: 401 throws (after retry exhaustion treats it as failure)',
  { timeout: 60_000 },
  async () => {
    // 401 is non-retryable in withRetry's default policy in spirit, but
    // withRetry actually retries on any throw — we throw on !res.ok, so
    // 401 will be retried up to max_attempts. To keep this test fast we
    // pin the same 401 response across the retry budget.
    nock('https://demo.docusign.net')
      .post(`/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes`)
      .times(5)
      .reply(401, 'unauthorized');

    await assert.rejects(
      createEnvelope(opts(), {
        template_id: 'tpl',
        recipient_email: 'r@example.com',
        recipient_name: 'R Person',
        subject: 'x',
      }),
      /docusign create envelope: 401/,
    );
  },
);

test('createEnvelope: 5xx triggers retry and ultimately throws', { timeout: 60_000 }, async () => {
  // 5 sequential 500s — exhausts the default retry budget and surfaces
  // as a thrown error to the caller.
  nock('https://demo.docusign.net')
    .post(`/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes`)
    .times(5)
    .reply(500, 'internal');

  await assert.rejects(
    createEnvelope(opts(), {
      template_id: 'tpl',
      recipient_email: 'r@example.com',
      recipient_name: 'R Person',
      subject: 'x',
    }),
    /docusign create envelope: 500/,
  );
});

test('getSignedDocument: returns Buffer with the PDF bytes', async () => {
  const fakePdf = Buffer.from('%PDF-1.4 fake pdf bytes');
  nock('https://demo.docusign.net')
    .get(`/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes/env-1/documents/combined`)
    .matchHeader('authorization', 'Bearer fake-token')
    .reply(200, fakePdf, { 'Content-Type': 'application/pdf' });

  const buf = await getSignedDocument(opts(), 'env-1');
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf8'), '%PDF-1.4 fake pdf bytes');
});

test('getSignedDocument: throws on non-2xx', async () => {
  nock('https://demo.docusign.net')
    .get(`/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes/env-missing/documents/combined`)
    .reply(404, 'not found');

  await assert.rejects(getSignedDocument(opts(), 'env-missing'), /docusign get document: 404/);
});
