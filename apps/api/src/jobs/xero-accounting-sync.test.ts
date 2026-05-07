import { test } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import {
  runXeroAccountingSyncForAllConnections,
  registerXeroAccountingSyncJob,
  XERO_ACCOUNTING_SYNC_JOB_NAME,
  XERO_ACCOUNTING_SYNC_CADENCE,
  type XeroAccountingSyncDeps,
  type PgBossLike,
} from './xero-accounting-sync.js';
import {
  syncInvoices as realSyncInvoices,
  syncBankTransactions as realSyncBankTransactions,
  syncReceipts as realSyncReceipts,
  syncContacts as realSyncContacts,
  syncAccounts as realSyncAccounts,
} from '@cpa/integrations/xero-accounting';

const CONN_A = '00000000-0000-4000-8000-000000000b61';
const CONN_B = '00000000-0000-4000-8000-000000000b62';
const TENANT_A = '00000000-0000-4000-8000-000000000ba1';
const TENANT_B = '00000000-0000-4000-8000-000000000ba2';
const FUTURE_EXPIRES_AT = new Date(Date.now() + 60 * 60 * 1000); // +1h

/**
 * The orchestrator emits these template-tag SQL calls per connection
 * (assuming success path):
 *   SELECT integration_connection            (× 1, top of run)
 *   SELECT pg_try_advisory_lock              (× 1, per connection)
 *   UPDATE sync_state='syncing'              (× 1, per connection)
 *   UPDATE sync_state='idle' (or 'failed')   (× 1, per connection)
 *   SELECT pg_advisory_unlock                (× 1, per connection)
 *
 * The stub routes by SQL substring + returns canned rows. `lock_results`
 * lets a test set the boolean returned by pg_try_advisory_lock per call
 * so the lock-held branch is exercisable. `update_calls` records every
 * UPDATE so the success/fail transitions can be asserted.
 */
type ConnectionRow = {
  id: string;
  tenant_id: string;
  access_token_encrypted: string;
  external_account_id: string | null;
  last_synced_at: Date | null;
  expires_at: Date | null;
};

type StubConfig = {
  connections: ConnectionRow[];
  /** Sequential booleans returned by pg_try_advisory_lock; defaults to true. */
  lock_results?: boolean[];
};

function makeSqlStub(cfg: StubConfig): {
  sql: NonNullable<XeroAccountingSyncDeps['sql_client']>;
  update_calls: Array<{ sql: string; params: unknown[]; conn_id?: string }>;
  lock_calls: number;
  unlock_calls: number;
} {
  const update_calls: Array<{ sql: string; params: unknown[]; conn_id?: string }> = [];
  let lockIdx = 0;
  let lockCalls = 0;
  let unlockCalls = 0;
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const rendered = strings.join('?');
    if (rendered.includes('pg_try_advisory_lock')) {
      const acquired = cfg.lock_results?.[lockIdx] ?? true;
      lockIdx += 1;
      lockCalls += 1;
      return Promise.resolve([{ acquired }]);
    }
    if (rendered.includes('pg_advisory_unlock')) {
      unlockCalls += 1;
      return Promise.resolve([{ pg_advisory_unlock: true }]);
    }
    if (rendered.includes('UPDATE integration_connection')) {
      // Conn id is the LAST param (WHERE id = $N at the tail).
      const conn_id = values[values.length - 1];
      update_calls.push({
        sql: rendered,
        params: values,
        conn_id: typeof conn_id === 'string' ? conn_id : undefined,
      });
      return Promise.resolve([]);
    }
    if (rendered.includes('FROM integration_connection')) {
      return Promise.resolve(cfg.connections);
    }
    return Promise.resolve([]);
  }) as unknown as NonNullable<XeroAccountingSyncDeps['sql_client']>;
  return {
    sql: fn,
    update_calls,
    get lock_calls(): number {
      return lockCalls;
    },
    get unlock_calls(): number {
      return unlockCalls;
    },
  };
}

const baseDeps = (
  cfg: StubConfig,
  overrides: Partial<XeroAccountingSyncDeps> = {},
): {
  deps: XeroAccountingSyncDeps;
  update_calls: Array<{ sql: string; params: unknown[]; conn_id?: string }>;
  stub: ReturnType<typeof makeSqlStub>;
} => {
  const stub = makeSqlStub(cfg);
  const deps: XeroAccountingSyncDeps = {
    sql_client: stub.sql,
    decrypt: () => 'decrypted-access-token',
    get_encryption_key: () => 'fake-key',
    sync_invoices: () =>
      Promise.resolve({ fetched: 0, inserted: 0, updated: 0, lines: 0, events_written: 0 }),
    sync_bank_transactions: () =>
      Promise.resolve({ fetched: 0, inserted: 0, updated: 0, lines: 0, events_written: 0 }),
    sync_receipts: () =>
      Promise.resolve({
        fetched: 0,
        inserted: 0,
        updated: 0,
        lines: 0,
        events_written: 0,
        reimbursee_matched: 0,
      }),
    sync_contacts: () => Promise.resolve({ fetched: 0, inserted: 0, updated: 0 }),
    sync_accounts: () => Promise.resolve({ fetched: 0, inserted: 0, updated: 0 }),
    ...overrides,
  };
  return { deps, update_calls: stub.update_calls, stub };
};

const baseConn = (id: string, tenant: string, last_synced_at: Date | null): ConnectionRow => ({
  id,
  tenant_id: tenant,
  access_token_encrypted: 'enc.blob',
  external_account_id: 'xero-org-' + id.slice(-4),
  last_synced_at,
  expires_at: FUTURE_EXPIRES_AT,
});

test('XERO_ACCOUNTING_SYNC_CADENCE is "*/15 * * * *" (every 15 minutes)', () => {
  assert.equal(XERO_ACCOUNTING_SYNC_CADENCE, '*/15 * * * *');
  assert.equal(XERO_ACCOUNTING_SYNC_JOB_NAME, 'xero-accounting-sync');
});

test('runs all 5 sync functions in sequence per connection (success path)', async () => {
  const calls: string[] = [];
  const { deps, update_calls } = baseDeps(
    { connections: [baseConn(CONN_A, TENANT_A, null)] },
    {
      sync_invoices: () => {
        calls.push('invoices');
        return Promise.resolve({
          fetched: 1,
          inserted: 1,
          updated: 0,
          lines: 1,
          events_written: 1,
        });
      },
      sync_bank_transactions: () => {
        calls.push('bank_tx');
        return Promise.resolve({
          fetched: 2,
          inserted: 2,
          updated: 0,
          lines: 2,
          events_written: 2,
        });
      },
      sync_receipts: () => {
        calls.push('receipts');
        return Promise.resolve({
          fetched: 3,
          inserted: 3,
          updated: 0,
          lines: 3,
          events_written: 3,
          reimbursee_matched: 1,
        });
      },
      sync_contacts: () => {
        calls.push('contacts');
        return Promise.resolve({ fetched: 4, inserted: 4, updated: 0 });
      },
      sync_accounts: () => {
        calls.push('accounts');
        return Promise.resolve({ fetched: 5, inserted: 5, updated: 0 });
      },
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.deepEqual(calls, ['invoices', 'bank_tx', 'receipts', 'contacts', 'accounts']);
  assert.equal(result.matched, 1);
  assert.equal(result.ran, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);
  const r0 = result.per_connection[0]!;
  assert.equal(r0.invoices?.inserted, 1);
  assert.equal(r0.bank_transactions?.inserted, 2);
  assert.equal(r0.receipts?.inserted, 3);
  assert.equal(r0.contacts?.inserted, 4);
  assert.equal(r0.accounts?.inserted, 5);

  // 2 UPDATEs: 'syncing' then 'idle' with last_synced_at.
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[0]!.sql.includes("sync_state = 'syncing'"));
  assert.ok(update_calls[1]!.sql.includes("sync_state = 'idle'"));
  assert.ok(update_calls[1]!.sql.includes('last_synced_at = NOW()'));
});

test('skips connection when advisory lock is held by another worker', async () => {
  let invoicesCalled = false;
  const { deps, update_calls, stub } = baseDeps(
    {
      connections: [baseConn(CONN_A, TENANT_A, null)],
      lock_results: [false],
    },
    {
      sync_invoices: () => {
        invoicesCalled = true;
        return Promise.resolve({
          fetched: 0,
          inserted: 0,
          updated: 0,
          lines: 0,
          events_written: 0,
        });
      },
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.equal(invoicesCalled, false);
  assert.equal(result.matched, 1);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.per_connection[0]!.ran, false);
  assert.equal(result.per_connection[0]!.skipped_reason, 'lock_held');
  // No UPDATE issued — we skipped before the syncing transition. No
  // unlock either (lock was never acquired).
  assert.equal(update_calls.length, 0);
  assert.equal(stub.unlock_calls, 0);
  // Lock attempt was made.
  assert.equal(stub.lock_calls, 1);
});

test('uses backfill mode on first run (no last_synced_at)', async () => {
  let observedMode: string | undefined;
  let observedSince: Date | undefined;
  const { deps } = baseDeps(
    { connections: [baseConn(CONN_A, TENANT_A, null)] },
    {
      sync_invoices: (_conn, opts) => {
        observedMode = opts.mode;
        observedSince = opts.since;
        return Promise.resolve({
          fetched: 0,
          inserted: 0,
          updated: 0,
          lines: 0,
          events_written: 0,
        });
      },
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.equal(observedMode, 'backfill');
  assert.equal(observedSince, undefined);
  assert.equal(result.per_connection[0]!.mode, 'backfill');
});

test('uses incremental mode with since=last_synced_at on subsequent runs', async () => {
  const previousSync = new Date('2026-04-25T00:00:00Z');
  const observed: Array<{ mode: string; since: Date | undefined }> = [];
  const captureMode =
    <T>(rv: T) =>
    (_c: unknown, opts: { mode: string; since?: Date }) => {
      observed.push({ mode: opts.mode, since: opts.since });
      return Promise.resolve(rv);
    };
  const { deps } = baseDeps(
    { connections: [baseConn(CONN_A, TENANT_A, previousSync)] },
    {
      sync_invoices: captureMode({
        fetched: 0,
        inserted: 0,
        updated: 0,
        lines: 0,
        events_written: 0,
      }),
      sync_bank_transactions: captureMode({
        fetched: 0,
        inserted: 0,
        updated: 0,
        lines: 0,
        events_written: 0,
      }),
      sync_receipts: captureMode({
        fetched: 0,
        inserted: 0,
        updated: 0,
        lines: 0,
        events_written: 0,
        reimbursee_matched: 0,
      }),
      sync_contacts: captureMode({ fetched: 0, inserted: 0, updated: 0 }),
      sync_accounts: captureMode({ fetched: 0, inserted: 0, updated: 0 }),
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.equal(observed.length, 5);
  for (const o of observed) {
    assert.equal(o.mode, 'incremental');
    assert.equal(o.since?.toISOString(), previousSync.toISOString());
  }
  assert.equal(result.per_connection[0]!.mode, 'incremental');
});

test('updates last_synced_at only after all 5 syncs succeed', async () => {
  // Simulate the 3rd sync (receipts) throwing. last_synced_at must NOT
  // be updated; sync_state must be 'failed' with last_error set; the
  // 4th + 5th syncs must NOT run.
  let contactsCalled = false;
  let accountsCalled = false;
  const { deps, update_calls } = baseDeps(
    { connections: [baseConn(CONN_A, TENANT_A, null)] },
    {
      sync_receipts: () => Promise.reject(new Error('xero 503 throttle')),
      sync_contacts: () => {
        contactsCalled = true;
        return Promise.resolve({ fetched: 0, inserted: 0, updated: 0 });
      },
      sync_accounts: () => {
        accountsCalled = true;
        return Promise.resolve({ fetched: 0, inserted: 0, updated: 0 });
      },
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.equal(contactsCalled, false);
  assert.equal(accountsCalled, false);
  assert.equal(result.failed, 1);
  assert.equal(result.ran, 0);
  assert.equal(result.per_connection[0]!.error, 'xero 503 throttle');

  // 2 UPDATEs: 'syncing' then 'failed' (NOT 'idle' / NOT last_synced_at).
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[0]!.sql.includes("sync_state = 'syncing'"));
  assert.ok(update_calls[1]!.sql.includes("sync_state = 'failed'"));
  assert.ok(!update_calls[1]!.sql.includes('last_synced_at = NOW()'));
  assert.equal(update_calls[1]!.params[0], 'xero 503 throttle');
});

test('processes multiple connections in sequence (matched=2, ran=2)', async () => {
  const callOrder: string[] = [];
  const { deps, update_calls } = baseDeps(
    {
      connections: [baseConn(CONN_A, TENANT_A, null), baseConn(CONN_B, TENANT_B, null)],
    },
    {
      sync_invoices: (conn) => {
        callOrder.push(`invoices:${conn.id}`);
        return Promise.resolve({
          fetched: 0,
          inserted: 0,
          updated: 0,
          lines: 0,
          events_written: 0,
        });
      },
      sync_accounts: (conn) => {
        callOrder.push(`accounts:${conn.id}`);
        return Promise.resolve({ fetched: 0, inserted: 0, updated: 0 });
      },
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.equal(result.matched, 2);
  assert.equal(result.ran, 2);
  assert.equal(result.failed, 0);
  // CONN_A invoices runs before CONN_A accounts; CONN_A accounts (the
  // 5th sync) runs before CONN_B invoices (per-connection sequential).
  assert.deepEqual(callOrder, [
    `invoices:${CONN_A}`,
    `accounts:${CONN_A}`,
    `invoices:${CONN_B}`,
    `accounts:${CONN_B}`,
  ]);
  // 2 UPDATEs per connection × 2 connections = 4.
  assert.equal(update_calls.length, 4);
  // Both connections finished with 'idle'.
  const idleUpdates = update_calls.filter((c) => c.sql.includes("sync_state = 'idle'"));
  assert.equal(idleUpdates.length, 2);
});

test('exits gracefully with matched=0/ran=0 when no connections match', async () => {
  let invoicesCalled = false;
  const { deps, update_calls, stub } = baseDeps(
    { connections: [] },
    {
      sync_invoices: () => {
        invoicesCalled = true;
        return Promise.resolve({
          fetched: 0,
          inserted: 0,
          updated: 0,
          lines: 0,
          events_written: 0,
        });
      },
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.equal(invoicesCalled, false);
  assert.equal(result.matched, 0);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.per_connection, []);
  assert.equal(update_calls.length, 0);
  assert.equal(stub.lock_calls, 0);
  assert.equal(stub.unlock_calls, 0);
});

test('expired access token → sync_state=failed, no sync calls', async () => {
  let invoicesCalled = false;
  const expired = new Date(Date.now() - 60_000);
  const { deps, update_calls } = baseDeps(
    {
      connections: [
        {
          id: CONN_A,
          tenant_id: TENANT_A,
          access_token_encrypted: 'enc.blob',
          external_account_id: 'xero-org-foo',
          last_synced_at: null,
          expires_at: expired,
        },
      ],
    },
    {
      sync_invoices: () => {
        invoicesCalled = true;
        return Promise.resolve({
          fetched: 0,
          inserted: 0,
          updated: 0,
          lines: 0,
          events_written: 0,
        });
      },
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.equal(invoicesCalled, false);
  assert.equal(result.failed, 1);
  assert.match(result.per_connection[0]!.error ?? '', /access token expired/);
  // Single UPDATE — straight to 'failed' (no 'syncing' step).
  assert.equal(update_calls.length, 1);
  assert.ok(update_calls[0]!.sql.includes("sync_state = 'failed'"));
});

test('missing external_account_id → sync_state=failed without calling sync functions', async () => {
  let invoicesCalled = false;
  const { deps, update_calls } = baseDeps(
    {
      connections: [
        {
          id: CONN_A,
          tenant_id: TENANT_A,
          access_token_encrypted: 'enc.blob',
          external_account_id: null,
          last_synced_at: null,
          expires_at: FUTURE_EXPIRES_AT,
        },
      ],
    },
    {
      sync_invoices: () => {
        invoicesCalled = true;
        return Promise.resolve({
          fetched: 0,
          inserted: 0,
          updated: 0,
          lines: 0,
          events_written: 0,
        });
      },
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.equal(invoicesCalled, false);
  assert.equal(result.failed, 1);
  assert.match(result.per_connection[0]!.error ?? '', /xero_tenant_id/);
  // Single UPDATE — straight to 'failed'.
  assert.equal(update_calls.length, 1);
  assert.ok(update_calls[0]!.sql.includes("sync_state = 'failed'"));
});

test('registerXeroAccountingSyncJob wires createQueue + work + schedule in correct order', async () => {
  // pg-boss v12+ requires createQueue first, then work (which uses the
  // queue), then schedule (which has a FK on queue.name). Asserting the
  // order regresses the original bug where schedule ran before either.
  const calls: Array<{ kind: 'createQueue' | 'schedule' | 'work'; name: string; cron?: string }> =
    [];
  const boss: PgBossLike = {
    createQueue: (name): Promise<void> => {
      calls.push({ kind: 'createQueue', name });
      return Promise.resolve();
    },
    schedule: (name, cron): Promise<void> => {
      calls.push({ kind: 'schedule', name, cron });
      return Promise.resolve();
    },
    work: <T>(name: string, _handler: (job: { data: T }) => unknown): Promise<string> => {
      calls.push({ kind: 'work', name });
      return Promise.resolve('worker-id-stub');
    },
  };

  await registerXeroAccountingSyncJob(boss);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { kind: 'createQueue', name: 'xero-accounting-sync' });
  assert.equal(calls[1]!.kind, 'work');
  assert.equal(calls[1]!.name, 'xero-accounting-sync');
  assert.deepEqual(calls[2], {
    kind: 'schedule',
    name: 'xero-accounting-sync',
    cron: '*/15 * * * *',
  });
});

test('advisory lock is released after sync (try/finally)', async () => {
  // Even when the per-connection sync THROWS internally (caught by the
  // try/catch in runOneConnection — produces an error-tagged result),
  // the orchestrator's outer try/finally must still unlock.
  const { deps, stub } = baseDeps(
    { connections: [baseConn(CONN_A, TENANT_A, null)] },
    {
      sync_invoices: () => Promise.reject(new Error('boom')),
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.equal(result.failed, 1);
  // Lock acquired (1) and released (1).
  assert.equal(stub.lock_calls, 1);
  assert.equal(stub.unlock_calls, 1);
});

// -- B7 integration: stub fallback wired through runOneConnection ---------
//
// Proves the factory swap (`XERO_IMPL=stub` → `xeroAccountingGetStub`)
// flows through the real B2-B5 sync code into `runOneConnection`, with
// no network calls. Existing B6 tests above mock at the sync-function
// deps layer and stay green under both env states; this test replaces
// the deps overrides with thin closures that thread a SQL stub through
// the REAL sync functions, so the factory + fixture path executes
// end-to-end.
test('B7 stub: runOneConnection completes 5-sync sequence via factory + fixtures', async () => {
  const ORIGINAL_XERO_IMPL = process.env.XERO_IMPL;
  process.env.XERO_IMPL = 'stub';

  // nock.disableNetConnect proves no fetch reaches the wire — if the
  // factory failed to swap and the real client tried to call api.xero.com,
  // nock would throw a "Disallowed net connect" error.
  nock.disableNetConnect();

  try {
    // Per-row SQL behaviour: all 5 syncs share the same stub. The stub
    // routes by SQL substring + returns canned rows that drive the
    // INSERT-path through every sync. See sync-invoices.test.ts for the
    // shape this stub mirrors.
    let nextId = 1;
    const fakeId = (): string => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

    type SqlFn = NonNullable<XeroAccountingSyncDeps['sql_client']>;
    const sqlStub: SqlFn = ((
      strings: TemplateStringsArray,
      ..._values: unknown[]
    ): Promise<unknown[]> => {
      const sqlText = strings.join('?');
      // Connection select happens at the orchestrator, not here.
      if (sqlText.includes('FROM integration_connection')) {
        // Single matched row, expires in the future, no last_synced_at.
        return Promise.resolve([
          {
            id: CONN_A,
            tenant_id: TENANT_A,
            access_token_encrypted: 'enc.blob',
            external_account_id: 'xero-org-stub',
            last_synced_at: null,
            expires_at: FUTURE_EXPIRES_AT,
          },
        ]);
      }
      if (sqlText.includes('pg_try_advisory_lock')) {
        return Promise.resolve([{ acquired: true }]);
      }
      if (sqlText.includes('pg_advisory_unlock')) {
        return Promise.resolve([{ pg_advisory_unlock: true }]);
      }
      if (sqlText.includes('SELECT id FROM expenditure')) {
        // INSERT path — no existing row.
        return Promise.resolve([]);
      }
      if (sqlText.includes('SELECT id FROM subject_tenant')) {
        return Promise.resolve([{ id: fakeId() }]);
      }
      if (sqlText.includes('INSERT INTO expenditure (') && sqlText.includes('RETURNING id')) {
        return Promise.resolve([{ id: fakeId() }]);
      }
      if (sqlText.includes('INSERT INTO xero_contact')) {
        // ON CONFLICT UPSERT — return inserted=true to simulate first run.
        return Promise.resolve([{ inserted: true }]);
      }
      if (sqlText.includes('INSERT INTO xero_account')) {
        return Promise.resolve([{ inserted: true }]);
      }
      // Receipts reimbursee resolver — no match (keeps the path simple
      // without needing to seed user / tenant_user rows).
      if (sqlText.includes('FROM "user"')) {
        return Promise.resolve([]);
      }
      // UPDATE statements (sync_state transitions, expenditure UPDATE on
      // the UPDATE path which we don't exercise here) and DELETE
      // (expenditure_line full-replace on UPDATE) — return empty.
      return Promise.resolve([]);
    }) as unknown as SqlFn;

    // The real sync functions accept sql_client + chain_insert via their
    // options bag and default to the production singletons. Wrap each so
    // runOneConnection's `{ mode, since }` baseSyncOpts get augmented with
    // our SQL stub + a no-op chain inserter. This keeps runOneConnection's
    // call-shape unchanged while letting the real syncs execute against
    // an in-memory backend.
    const chainInsertStub = ((): Parameters<typeof realSyncInvoices>[1]['chain_insert'] => {
      const fn: NonNullable<Parameters<typeof realSyncInvoices>[1]['chain_insert']> = () =>
        Promise.resolve({
          id: '00000000-0000-4000-8000-eeeeeeeeeeee',
          prev_hash: null,
          hash: 'fakehash',
        });
      return fn;
    })();

    const deps: XeroAccountingSyncDeps = {
      sql_client: sqlStub,
      decrypt: () => 'decrypted-access-token',
      get_encryption_key: () => 'fake-key',
      sync_invoices: (conn, opts) =>
        realSyncInvoices(conn, {
          ...opts,
          sql_client: sqlStub,
          chain_insert: chainInsertStub,
        }),
      sync_bank_transactions: (conn, opts) =>
        realSyncBankTransactions(conn, {
          ...opts,
          sql_client: sqlStub,
          chain_insert: chainInsertStub,
        }),
      sync_receipts: (conn, opts) =>
        realSyncReceipts(conn, {
          ...opts,
          sql_client: sqlStub,
          chain_insert: chainInsertStub,
        }),
      sync_contacts: (conn, opts) => realSyncContacts(conn, { ...opts, sql_client: sqlStub }),
      sync_accounts: (conn, opts) => realSyncAccounts(conn, { ...opts, sql_client: sqlStub }),
    };

    const result = await runXeroAccountingSyncForAllConnections(deps);

    // The orchestrator must have walked the full 5-sync sequence for the
    // single connection, picking up the fixture counts.
    assert.equal(result.matched, 1);
    assert.equal(result.ran, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);
    const r = result.per_connection[0];
    assert.ok(r);
    assert.equal(r.ran, true);
    assert.equal(r.error, undefined);

    // Fixture-driven counts. See packages/integrations/src/xero-accounting/
    // fixtures/*.json for the source data.
    assert.equal(r.invoices?.fetched, 3);
    assert.equal(r.invoices?.inserted, 3);
    assert.equal(r.bank_transactions?.fetched, 3);
    assert.equal(r.bank_transactions?.inserted, 3);
    assert.equal(r.receipts?.fetched, 2);
    assert.equal(r.receipts?.inserted, 2);
    assert.equal(r.contacts?.fetched, 6);
    assert.equal(r.contacts?.inserted, 6);
    assert.equal(r.accounts?.fetched, 10);
    assert.equal(r.accounts?.inserted, 10);
  } finally {
    nock.enableNetConnect();
    nock.cleanAll();
    if (ORIGINAL_XERO_IMPL === undefined) {
      delete process.env.XERO_IMPL;
    } else {
      process.env.XERO_IMPL = ORIGINAL_XERO_IMPL;
    }
  }
});

// ---------------------------------------------------------------------------
// Task 3.4 — Agent A trigger hook propagation.
//
// The orchestrator collects `inserted_expenditure_ids` from each
// expenditure-emitting sync (invoices, bank-tx, receipts) and dispatches
// them via `enqueueExpenditureClassify` (apps/api/src/lib/enqueue-classify.ts).
// We can't easily exercise the shim's internal classifier path here
// (that needs the full DB harness — covered by routes/expenditures.test.ts),
// but we CAN verify the orchestrator forwards inserted ids through
// per-connection results and tolerates absence of ids without errors.
// ---------------------------------------------------------------------------

test('Task 3.4: inserted_expenditure_ids flow through per_connection result', async () => {
  // Default the agent flag OFF so the shim short-circuits without
  // touching the real DB. The orchestrator must still propagate the
  // ids on the result object regardless of the trigger outcome.
  const ORIG_FLAG = process.env.P6_AGENT_A_ENABLED;
  process.env.P6_AGENT_A_ENABLED = 'false';
  try {
    const newInvId = '00000000-0000-4000-8000-0000000b3401';
    const newBtId = '00000000-0000-4000-8000-0000000b3402';
    const newRcptId = '00000000-0000-4000-8000-0000000b3403';
    const { deps } = baseDeps(
      { connections: [baseConn(CONN_A, TENANT_A, null)] },
      {
        sync_invoices: () =>
          Promise.resolve({
            fetched: 1,
            inserted: 1,
            updated: 0,
            lines: 1,
            events_written: 1,
            inserted_expenditure_ids: [newInvId],
          }),
        sync_bank_transactions: () =>
          Promise.resolve({
            fetched: 1,
            inserted: 1,
            updated: 0,
            lines: 1,
            events_written: 1,
            inserted_expenditure_ids: [newBtId],
          }),
        sync_receipts: () =>
          Promise.resolve({
            fetched: 1,
            inserted: 1,
            updated: 0,
            lines: 1,
            events_written: 1,
            reimbursee_matched: 0,
            inserted_expenditure_ids: [newRcptId],
          }),
      },
    );

    const result = await runXeroAccountingSyncForAllConnections(deps);
    assert.equal(result.failed, 0);
    assert.equal(result.ran, 1);
    const r0 = result.per_connection[0]!;
    assert.deepEqual(r0.invoices?.inserted_expenditure_ids, [newInvId]);
    assert.deepEqual(r0.bank_transactions?.inserted_expenditure_ids, [newBtId]);
    assert.deepEqual(r0.receipts?.inserted_expenditure_ids, [newRcptId]);
  } finally {
    if (ORIG_FLAG === undefined) {
      delete process.env.P6_AGENT_A_ENABLED;
    } else {
      process.env.P6_AGENT_A_ENABLED = ORIG_FLAG;
    }
  }
});

test('Task 3.4: empty inserted_expenditure_ids does not error orchestrator', async () => {
  // Re-confirm the existing happy-path stubs (no `inserted_expenditure_ids`
  // field at all) still produce a successful run — the orchestrator
  // coalesces undefined to `[]` before calling the shim.
  const { deps } = baseDeps(
    { connections: [baseConn(CONN_A, TENANT_A, null)] },
    {
      sync_invoices: () =>
        Promise.resolve({
          fetched: 0,
          inserted: 0,
          updated: 0,
          lines: 0,
          events_written: 0,
        }),
    },
  );

  const result = await runXeroAccountingSyncForAllConnections(deps);
  assert.equal(result.failed, 0);
  assert.equal(result.ran, 1);
});
