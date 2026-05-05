import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { getBoss, stopBoss, __resetBossForTests } from './pg-boss-client.js';

// These tests round-trip a real job through pg-boss against the
// `pgboss.*` schema in the test DB. They share a single boss instance
// across the file (the pg-boss singleton) and tear it down once at the
// end — restarting boss between tests would re-run schema-migration
// checks for no benefit.
//
// Running locally requires DATABASE_URL pointing at a Postgres reachable
// from the test process. CI provisions one via the standard pgvector
// container; if it's missing locally, this test will fail fast with a
// connection error from boss.start().
after(async () => {
  await stopBoss();
  __resetBossForTests();
});

test('pg-boss-client: send + work round-trip', async () => {
  const boss = await getBoss();
  // Unique queue per run avoids leftover-row interference if a prior
  // failed test left a job in the queue, and lets parallel CI shards
  // exercise this test against the same DB without colliding.
  const QUEUE = `test-roundtrip-${crypto.randomUUID()}`;
  // pg-boss 12 requires queues to exist before send(). createQueue is
  // idempotent and uses the default queue policy (standard).
  await boss.createQueue(QUEUE);

  const received = new Promise<{ payload: { hello: string } }>((resolve) => {
    // pg-boss's WorkHandler delivers a job array (default batch size 1).
    // The handler must be async (pg-boss awaits its return); we narrow
    // the array via the early-return rather than a non-null assertion,
    // and `await Promise.resolve()` keeps the function genuinely async
    // for both the @typescript-eslint/require-await rule and the engine.
    void boss.work<{ hello: string }>(QUEUE, async ([job]) => {
      await Promise.resolve();
      if (!job) return;
      resolve({ payload: job.data });
    });
  });

  await boss.send(QUEUE, { hello: 'world' });

  // Bound the test at 5s so a misconfigured boss/handler pair fails
  // fast rather than hanging the suite.
  const result = await Promise.race([
    received,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout waiting for pg-boss work handler')), 5000),
    ),
  ]);
  assert.equal(result.payload.hello, 'world');
});

test('pg-boss-client: getBoss returns same instance on repeat call', async () => {
  const boss1 = await getBoss();
  const boss2 = await getBoss();
  assert.equal(boss1, boss2, 'singleton must be stable across calls');
});
