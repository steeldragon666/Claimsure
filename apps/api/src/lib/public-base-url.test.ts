import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicBaseUrl, publicUrl, resetPublicBaseUrlForTesting } from './public-base-url.js';

const ENV_KEYS = ['PUBLIC_BASE_URL', 'APP_BASE_URL', 'WEB_BASE_URL', 'NODE_ENV'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetPublicBaseUrlForTesting();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetPublicBaseUrlForTesting();
});

function captureWarnings() {
  const warnings: string[] = [];
  return {
    logger: {
      warn: (message: string) => warnings.push(message),
    },
    warnings,
  };
}

test('getPublicBaseUrl prefers PUBLIC_BASE_URL and strips trailing slashes', () => {
  process.env['PUBLIC_BASE_URL'] = 'https://archiveone.com.au///';
  process.env['APP_BASE_URL'] = 'https://legacy.example';
  assert.equal(getPublicBaseUrl(), 'https://archiveone.com.au');
});

test('getPublicBaseUrl falls back to APP_BASE_URL with a warning', () => {
  process.env['APP_BASE_URL'] = 'https://app.example/';
  const { logger, warnings } = captureWarnings();

  assert.equal(getPublicBaseUrl({ logger }), 'https://app.example');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /APP_BASE_URL.*PUBLIC_BASE_URL/);
});

test('getPublicBaseUrl falls back to WEB_BASE_URL after APP_BASE_URL', () => {
  process.env['WEB_BASE_URL'] = 'https://web.example/';
  const { logger, warnings } = captureWarnings();

  assert.equal(getPublicBaseUrl({ logger }), 'https://web.example');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /WEB_BASE_URL.*PUBLIC_BASE_URL/);
});

test('getPublicBaseUrl throws in production without a public URL', () => {
  process.env['NODE_ENV'] = 'production';
  assert.throws(() => getPublicBaseUrl(), /PUBLIC_BASE_URL is required in production/);
});

test('getPublicBaseUrl uses a local web default outside production', () => {
  process.env['NODE_ENV'] = 'development';
  assert.equal(getPublicBaseUrl(), 'http://localhost:5173');
});

test('publicUrl appends paths to the resolved public origin', () => {
  process.env['PUBLIC_BASE_URL'] = 'https://archiveone.com.au/';
  assert.equal(
    publicUrl('/verify-email?token=abc'),
    'https://archiveone.com.au/verify-email?token=abc',
  );
  assert.equal(
    publicUrl('federation/accept?token=abc'),
    'https://archiveone.com.au/federation/accept?token=abc',
  );
});
