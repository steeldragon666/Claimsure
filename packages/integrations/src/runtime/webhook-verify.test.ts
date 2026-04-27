import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyDocuSignSignature, verifyHmacSha256 } from './webhook-verify.js';

test('verifyHmacSha256 returns true for a valid hex signature', () => {
  const secret = 'shh';
  const payload = Buffer.from('{"event":"x"}');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  assert.equal(verifyHmacSha256({ payload, signature_header: sig, secret }), true);
});

test('verifyHmacSha256 accepts uppercase signatures (case-insensitive hex)', () => {
  const secret = 'shh';
  const payload = 'string-payload';
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').toUpperCase();
  assert.equal(verifyHmacSha256({ payload, signature_header: sig, secret }), true);
});

test('verifyHmacSha256 returns false for a tampered payload', () => {
  const secret = 'shh';
  const original = Buffer.from('{"amount":10}');
  const tampered = Buffer.from('{"amount":9999}');
  const sig = crypto.createHmac('sha256', secret).update(original).digest('hex');
  assert.equal(verifyHmacSha256({ payload: tampered, signature_header: sig, secret }), false);
});

test('verifyHmacSha256 returns false on malformed signature header', () => {
  assert.equal(
    verifyHmacSha256({
      payload: 'x',
      signature_header: 'not-hex',
      secret: 'shh',
    }),
    false,
  );
});

test('verifyHmacSha256 returns false when signature is wrong length', () => {
  assert.equal(
    verifyHmacSha256({
      payload: 'x',
      signature_header: 'ab', // valid hex but wrong length
      secret: 'shh',
    }),
    false,
  );
});

test('verifyDocuSignSignature accepts a valid base64 signature', () => {
  const secret = 'docusign-key';
  const payload = Buffer.from('<root>signed-payload</root>');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  assert.equal(verifyDocuSignSignature({ payload, signature_header: sig, secret }), true);
});

test('verifyDocuSignSignature rejects a bad signature', () => {
  const secret = 'docusign-key';
  const payload = Buffer.from('<root>signed-payload</root>');
  const wrong = crypto.createHmac('sha256', 'different-key').update(payload).digest('base64');
  assert.equal(verifyDocuSignSignature({ payload, signature_header: wrong, secret }), false);
});

test('verifyDocuSignSignature returns false when payload is tampered', () => {
  const secret = 'docusign-key';
  const original = Buffer.from('<root>amount=10</root>');
  const tampered = Buffer.from('<root>amount=9999</root>');
  const sig = crypto.createHmac('sha256', secret).update(original).digest('base64');
  assert.equal(
    verifyDocuSignSignature({ payload: tampered, signature_header: sig, secret }),
    false,
  );
});
