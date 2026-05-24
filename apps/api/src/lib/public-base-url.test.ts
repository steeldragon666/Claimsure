import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicBaseUrl, resetPublicBaseUrlForTesting } from './public-base-url.js';

// Snapshot the three env vars + NODE_ENV before each test, restore after.
// process.env mutation is the only way to exercise this — the codebase
// convention (see packages/db/src/env.ts:40) is to read process.env directly,
// so injection would be inconsistent.
const KEYS = ['PUBLIC_BASE_URL', 'APP_BASE_URL', 'WEB_BASE_URL', 'NODE_ENV'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  resetPublicBaseUrlForTesting();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetPublicBaseUrlForTesting();
});

// Capturing logger for the deprecation warnings.
const makeLogger = (): { warn: (msg: string) => void; warns: string[] } => {
  const warns: string[] = [];
  return {
    warn: (msg: string) => warns.push(msg),
    warns,
  };
};

test('getPublicBaseUrl: returns PUBLIC_BASE_URL when set', () => {
  process.env['PUBLIC_BASE_URL'] = 'https://example.com';
  assert.equal(getPublicBaseUrl(), 'https://example.com');
});

test('getPublicBaseUrl: strips trailing slash from PUBLIC_BASE_URL', () => {
  process.env['PUBLIC_BASE_URL'] = 'https://example.com/';
  assert.equal(getPublicBaseUrl(), 'https://example.com');
});

test('getPublicBaseUrl: falls back to APP_BASE_URL when PUBLIC_BASE_URL unset, logs deprecation', () => {
  process.env['APP_BASE_URL'] = 'https://app.example.com';
  const logger = makeLogger();
  assert.equal(getPublicBaseUrl({ logger }), 'https://app.example.com');
  assert.equal(logger.warns.length, 1);
  assert.match(logger.warns[0]!, /APP_BASE_URL.*deprecated.*PUBLIC_BASE_URL/);
});

test('getPublicBaseUrl: falls back to WEB_BASE_URL when neither PUBLIC nor APP set, logs deprecation', () => {
  process.env['WEB_BASE_URL'] = 'https://web.example.com';
  const logger = makeLogger();
  assert.equal(getPublicBaseUrl({ logger }), 'https://web.example.com');
  assert.equal(logger.warns.length, 1);
  assert.match(logger.warns[0]!, /WEB_BASE_URL.*deprecated.*PUBLIC_BASE_URL/);
});

test('getPublicBaseUrl: PUBLIC_BASE_URL wins over APP_BASE_URL', () => {
  process.env['PUBLIC_BASE_URL'] = 'https://winner.example.com';
  process.env['APP_BASE_URL'] = 'https://loser.example.com';
  const logger = makeLogger();
  assert.equal(getPublicBaseUrl({ logger }), 'https://winner.example.com');
  assert.equal(logger.warns.length, 0, 'no deprecation warning when canonical name is used');
});

test('getPublicBaseUrl: dev default is http://localhost:3000 (Next.js default)', () => {
  process.env['NODE_ENV'] = 'development';
  assert.equal(getPublicBaseUrl(), 'http://localhost:3000');
});

test('getPublicBaseUrl: test env also uses the dev default', () => {
  process.env['NODE_ENV'] = 'test';
  assert.equal(getPublicBaseUrl(), 'http://localhost:3000');
});

test('getPublicBaseUrl: production with no env var throws', () => {
  process.env['NODE_ENV'] = 'production';
  assert.throws(() => getPublicBaseUrl(), /PUBLIC_BASE_URL.*required.*production/);
});

test('getPublicBaseUrl: production with PUBLIC_BASE_URL set returns it (no throw)', () => {
  process.env['NODE_ENV'] = 'production';
  process.env['PUBLIC_BASE_URL'] = 'https://prod.example.com';
  assert.equal(getPublicBaseUrl(), 'https://prod.example.com');
});

test('getPublicBaseUrl: result is memoized after first call (same instance on repeat)', () => {
  process.env['PUBLIC_BASE_URL'] = 'https://memo.example.com';
  const a = getPublicBaseUrl();
  // Mutate env after first call — memoization should ignore the change.
  process.env['PUBLIC_BASE_URL'] = 'https://changed.example.com';
  const b = getPublicBaseUrl();
  assert.equal(a, b, 'memoized — change to env after first call has no effect');
  assert.equal(a, 'https://memo.example.com');
});
