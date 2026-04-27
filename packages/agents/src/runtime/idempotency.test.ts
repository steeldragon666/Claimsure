import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { computeIdempotencyKey, lookupCache, writeCache } from './idempotency.js';
import { sql } from '@cpa/db/client';

after(async () => {
  await sql`DELETE FROM agent_call_cache WHERE agent_name = 'test-agent'`;
  await sql.end();
});

test('computeIdempotencyKey is deterministic', () => {
  const a = computeIdempotencyKey('classify@1.0.0', 'hello world');
  const b = computeIdempotencyKey('classify@1.0.0', 'hello world');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('computeIdempotencyKey differs on prompt-version change', () => {
  const a = computeIdempotencyKey('classify@1.0.0', 'x');
  const b = computeIdempotencyKey('classify@2.0.0', 'x');
  assert.notEqual(a, b);
});

test('writeCache + lookupCache round-trip', async () => {
  const key = computeIdempotencyKey('classify@1.0.0', 'idempotency-test-' + Math.random());
  const written = {
    idempotency_key: key,
    agent_name: 'test-agent',
    prompt_version: 'classify@1.0.0',
    output: { kind: 'HYPOTHESIS', confidence: 0.9 },
    tokens_in: 100,
    tokens_out: 50,
    model: 'test-model',
  };
  await writeCache(written);
  const got = await lookupCache(key);
  assert.ok(got);
  assert.equal(got.tokens_in, 100);
  assert.deepEqual(got.output, { kind: 'HYPOTHESIS', confidence: 0.9 });
});

test('lookupCache returns null for unknown key', async () => {
  const got = await lookupCache('0'.repeat(64));
  assert.equal(got, null);
});

test('writeCache is idempotent (ON CONFLICT DO NOTHING)', async () => {
  const key = computeIdempotencyKey('classify@1.0.0', 'idempotency-conflict-' + Math.random());
  const entry = {
    idempotency_key: key,
    agent_name: 'test-agent',
    prompt_version: 'classify@1.0.0',
    output: { v: 1 },
    tokens_in: 1,
    tokens_out: 1,
    model: 'm',
  };
  await writeCache(entry);
  // Second write with different output should NOT replace.
  await writeCache({ ...entry, output: { v: 2 } });
  const got = await lookupCache(key);
  assert.deepEqual(got!.output, { v: 1 });
});
