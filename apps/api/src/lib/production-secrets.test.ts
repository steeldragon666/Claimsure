import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDistinctProductionSecrets, readSecretEnv } from './production-secrets.js';

const ENV_KEYS = ['NODE_ENV', 'SESSION_JWT_SECRET', 'SIGNUP_VERIFICATION_SECRET'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('readSecretEnv returns a dev fallback outside production', () => {
  process.env['NODE_ENV'] = 'development';
  assert.equal(readSecretEnv('SESSION_JWT_SECRET', { devFallback: 'dev-secret' }), 'dev-secret');
});

test('readSecretEnv reads a configured value outside production', () => {
  process.env['SESSION_JWT_SECRET'] = 'configured-local-secret';
  assert.equal(
    readSecretEnv('SESSION_JWT_SECRET', { devFallback: 'dev-secret' }),
    'configured-local-secret',
  );
});

test('readSecretEnv requires an explicit value in production', () => {
  process.env['NODE_ENV'] = 'production';
  assert.throws(
    () => readSecretEnv('SESSION_JWT_SECRET', { devFallback: 'dev-secret' }),
    /SESSION_JWT_SECRET is required in production/,
  );
});

test('readSecretEnv rejects known development defaults in production', () => {
  process.env['NODE_ENV'] = 'production';
  process.env['SESSION_JWT_SECRET'] = 'dev-only-32-bytes-of-entropy-pad!';
  assert.throws(
    () => readSecretEnv('SESSION_JWT_SECRET', { devFallback: 'dev-secret' }),
    /must not use a development fallback/,
  );
});

test('readSecretEnv enforces minimum production length', () => {
  process.env['NODE_ENV'] = 'production';
  process.env['SESSION_JWT_SECRET'] = 'too-short';
  assert.throws(
    () => readSecretEnv('SESSION_JWT_SECRET', { devFallback: 'dev-secret' }),
    /at least 32 characters/,
  );
});

test('assertDistinctProductionSecrets rejects reused production secrets', () => {
  process.env['NODE_ENV'] = 'production';
  const secret = 'same-secret-with-32-plus-characters';
  assert.throws(
    () =>
      assertDistinctProductionSecrets(
        'SESSION_JWT_SECRET',
        secret,
        'SIGNUP_VERIFICATION_SECRET',
        secret,
      ),
    /must be different in production/,
  );
});

test('assertDistinctProductionSecrets allows reused dev secrets outside production', () => {
  process.env['NODE_ENV'] = 'test';
  assert.doesNotThrow(() =>
    assertDistinctProductionSecrets(
      'SESSION_JWT_SECRET',
      'same',
      'SIGNUP_VERIFICATION_SECRET',
      'same',
    ),
  );
});
