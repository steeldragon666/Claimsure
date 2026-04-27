import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseWebhookEvent, verifyAndParse } from './webhook.js';
import type { DocuSignWebhookPayload } from './webhook.js';

const SECRET = 'docusign-webhook-secret';

const sign = (body: Buffer): string =>
  crypto.createHmac('sha256', SECRET).update(body).digest('base64');

test('parseWebhookEvent: maps fields + custom_fields into snake_case', () => {
  const payload: DocuSignWebhookPayload = {
    envelopeId: 'env-1',
    status: 'completed',
    statusChangedDateTime: '2026-04-27T12:00:00Z',
    customFields: {
      textCustomFields: [
        { name: 'signing_request_id', value: 'sr-1' },
        { name: 'tenant_id', value: 't-1' },
      ],
    },
  };
  const parsed = parseWebhookEvent(payload);
  assert.equal(parsed.envelope_id, 'env-1');
  assert.equal(parsed.status, 'completed');
  assert.ok(parsed.status_changed_at instanceof Date);
  assert.equal(parsed.status_changed_at.toISOString(), '2026-04-27T12:00:00.000Z');
  assert.deepEqual(parsed.custom_fields, {
    signing_request_id: 'sr-1',
    tenant_id: 't-1',
  });
});

test('parseWebhookEvent: empty custom_fields when none provided', () => {
  const payload: DocuSignWebhookPayload = {
    envelopeId: 'env-2',
    status: 'sent',
    statusChangedDateTime: '2026-04-27T13:00:00Z',
  };
  const parsed = parseWebhookEvent(payload);
  assert.deepEqual(parsed.custom_fields, {});
});

test('verifyAndParse: valid signature + valid JSON returns parsed event', () => {
  const body = Buffer.from(
    JSON.stringify({
      envelopeId: 'env-3',
      status: 'completed',
      statusChangedDateTime: '2026-04-27T14:00:00Z',
      customFields: {
        textCustomFields: [{ name: 'k', value: 'v' }],
      },
    } satisfies DocuSignWebhookPayload),
  );
  const sig = sign(body);
  const parsed = verifyAndParse(body, sig, SECRET);
  assert.ok(parsed);
  assert.equal(parsed.envelope_id, 'env-3');
  assert.equal(parsed.status, 'completed');
  assert.deepEqual(parsed.custom_fields, { k: 'v' });
});

test('verifyAndParse: invalid signature returns null', () => {
  const body = Buffer.from('{"envelopeId":"x","status":"sent","statusChangedDateTime":"2026-04-27T14:00:00Z"}');
  const wrongSig = crypto.createHmac('sha256', 'different-key').update(body).digest('base64');
  const parsed = verifyAndParse(body, wrongSig, SECRET);
  assert.equal(parsed, null);
});

test('verifyAndParse: valid signature + malformed JSON returns null', () => {
  const body = Buffer.from('not json {{{');
  const sig = sign(body);
  const parsed = verifyAndParse(body, sig, SECRET);
  assert.equal(parsed, null);
});

test('verifyAndParse: tampered body fails signature check', () => {
  const original = Buffer.from('{"envelopeId":"x","status":"sent","statusChangedDateTime":"2026-04-27T14:00:00Z"}');
  const sig = sign(original);
  const tampered = Buffer.from('{"envelopeId":"y","status":"sent","statusChangedDateTime":"2026-04-27T14:00:00Z"}');
  const parsed = verifyAndParse(tampered, sig, SECRET);
  assert.equal(parsed, null);
});
