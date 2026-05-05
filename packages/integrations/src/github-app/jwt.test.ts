import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createAppJwt } from './jwt.js';

// Module-level keypair fixture — generated once per test process.
// Real GitHub App private keys must NEVER be committed; this is a fresh
// 2048-bit RSA pair generated at module load.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { format: 'pem', type: 'spki' },
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
});

function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signatureB64url: string;
} {
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'JWT must have 3 segments');
  const [h, p, s] = parts as [string, string, string];
  const fromB64Url = (str: string): Buffer =>
    Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return {
    header: JSON.parse(fromB64Url(h).toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(fromB64Url(p).toString('utf8')) as Record<string, unknown>,
    signingInput: `${h}.${p}`,
    signatureB64url: s,
  };
}

test('createAppJwt: header has alg=RS256, typ=JWT', () => {
  const token = createAppJwt({ appId: '123', privateKey });
  const { header } = decodeJwt(token);
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');
});

test('createAppJwt: payload has iss=appId and exp - iat <= 600', () => {
  const token = createAppJwt({ appId: '987654', privateKey });
  const { payload } = decodeJwt(token);
  assert.equal(payload.iss, '987654');
  const iat = payload.iat as number;
  const exp = payload.exp as number;
  assert.ok(typeof iat === 'number' && typeof exp === 'number', 'iat/exp present');
  assert.ok(exp - iat <= 600, `exp - iat = ${exp - iat}, must be <= 600`);
  assert.ok(exp - iat > 0, 'exp must be after iat');
});

test('createAppJwt: iat is now - 60s (clock-skew safety)', () => {
  const fixedNow = 1_700_000_000_000;
  const token = createAppJwt({ appId: '1', privateKey, now: () => fixedNow });
  const { payload } = decodeJwt(token);
  assert.equal(payload.iat, Math.floor(fixedNow / 1000) - 60);
  assert.equal(payload.exp, Math.floor(fixedNow / 1000) - 60 + 600);
});

test('createAppJwt: signature verifies against the matching public key', () => {
  const token = createAppJwt({ appId: '42', privateKey });
  const { signingInput, signatureB64url } = decodeJwt(token);
  const sigBuf = Buffer.from(signatureB64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();
  assert.ok(verifier.verify(publicKey, sigBuf), 'signature must verify');
});

test('createAppJwt: signature does NOT verify against an unrelated public key', () => {
  const other = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { format: 'pem', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  });
  const token = createAppJwt({ appId: '42', privateKey });
  const { signingInput, signatureB64url } = decodeJwt(token);
  const sigBuf = Buffer.from(signatureB64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();
  assert.equal(verifier.verify(other.publicKey, sigBuf), false);
});

test('createAppJwt: custom ttlSeconds within [1, 600] is honored', () => {
  const fixedNow = 1_700_000_000_000;
  const token = createAppJwt({ appId: '1', privateKey, ttlSeconds: 120, now: () => fixedNow });
  const { payload } = decodeJwt(token);
  assert.equal((payload.exp as number) - (payload.iat as number), 120);
});

test('createAppJwt: ttlSeconds > 600 is rejected', () => {
  assert.throws(
    () => createAppJwt({ appId: '1', privateKey, ttlSeconds: 601 }),
    /ttlSeconds must be in/,
  );
});

test('createAppJwt: ttlSeconds <= 0 is rejected', () => {
  assert.throws(
    () => createAppJwt({ appId: '1', privateKey, ttlSeconds: 0 }),
    /ttlSeconds must be in/,
  );
});

test('createAppJwt: missing appId throws', () => {
  assert.throws(() => createAppJwt({ appId: '', privateKey }), /appId is required/);
});

test('createAppJwt: missing privateKey throws', () => {
  assert.throws(() => createAppJwt({ appId: '1', privateKey: '' }), /privateKey is required/);
});
