import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDb } from './db.js';

// Stub runQuery factories below use Promise.resolve/Promise.reject rather
// than `async` arrow functions to keep @typescript-eslint/require-await
// happy — the route signature is `() => Promise<unknown>`, which both forms
// satisfy. Behaviour is identical: a Promise that resolves/rejects/hangs.

test('checkDb: ok=true when runQuery resolves', async () => {
  const result = await checkDb(() => Promise.resolve(1));
  assert.equal(result.ok, true);
  assert.ok(result.latencyMs >= 0);
  assert.ok(result.latencyMs < 100, 'fast resolution');
});

test('checkDb: ok=false when runQuery rejects synchronously', async () => {
  const result = await checkDb(() => Promise.reject(new Error('connection refused')));
  assert.equal(result.ok, false);
  assert.ok(result.latencyMs >= 0);
});

test('checkDb: ok=false when runQuery hangs past timeout', async () => {
  const result = await checkDb(() => new Promise(() => {})); // never resolves
  assert.equal(result.ok, false);
  assert.ok(result.latencyMs >= 1500, 'timeout fired');
  assert.ok(result.latencyMs < 1700, 'did not wait far past timeout');
});

test('checkDb: optional logger receives error on failure', async () => {
  const calls: Array<{ obj: object; msg: string }> = [];
  const logger = {
    error: (obj: object, msg: string) => {
      calls.push({ obj, msg });
    },
  };
  await checkDb(() => Promise.reject(new Error('boom')), logger);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.msg, 'checkDb failed');
});
