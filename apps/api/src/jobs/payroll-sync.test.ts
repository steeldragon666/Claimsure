import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncEmploymentHero,
  syncKeypay,
  syncDeputy,
  syncXeroPayroll,
  type PayrollSyncDeps,
  type KeypaySyncDeps,
  type DeputySyncDeps,
  type XeroPayrollSyncDeps,
} from './payroll-sync.js';

const CONNECTION_ID = '00000000-0000-4000-8000-000000000bb1';
const TENANT_ID = '00000000-0000-4000-8000-000000000bb2';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000bb3';
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000bb4';

/**
 * The orchestrator chains five SQL operations:
 *   SELECT integration_connection
 *   UPDATE sync_state='syncing'        (or branch to fail-fast)
 *   SELECT subject_tenant
 *   SELECT tenant_user (admin)
 *   UPDATE sync_state='idle' / 'failed'
 *
 * The stub routes by SQL substring and returns canned rows so we can
 * exercise the success and failure branches without real Postgres.
 *
 * `update_calls` records every UPDATE issued so the test can assert
 * that 'syncing' → 'idle' (or 'failed') transitions actually fire.
 */
type StubRows = {
  integration_connection?: Array<{
    tenant_id: string;
    access_token_encrypted: string;
    external_account_id: string | null;
    last_synced_at: Date | null;
  }>;
  subject_tenant?: Array<{ id: string }>;
  tenant_user?: Array<{ user_id: string }>;
};

function makeSqlStub(rows: StubRows): {
  sql: PayrollSyncDeps['sql_client'];
  update_calls: Array<{ sql: string; params: unknown[] }>;
} {
  const update_calls: Array<{ sql: string; params: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const rendered = strings.join('?');
    if (rendered.includes('UPDATE integration_connection')) {
      update_calls.push({ sql: rendered, params: values });
      return Promise.resolve([]);
    }
    if (rendered.includes('FROM integration_connection')) {
      return Promise.resolve(rows.integration_connection ?? []);
    }
    if (rendered.includes('FROM subject_tenant')) {
      return Promise.resolve(rows.subject_tenant ?? []);
    }
    if (rendered.includes('FROM tenant_user')) {
      return Promise.resolve(rows.tenant_user ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as PayrollSyncDeps['sql_client'];
  return { sql: fn, update_calls };
}

const baseDeps = (
  rows: StubRows,
  overrides: Partial<PayrollSyncDeps> = {},
): { deps: PayrollSyncDeps; update_calls: Array<{ sql: string; params: unknown[] }> } => {
  const { sql, update_calls } = makeSqlStub(rows);
  const deps: PayrollSyncDeps = {
    sql_client: sql,
    decrypt: () => 'decrypted-access-token',
    get_encryption_key: () => 'fake-key',
    sync_employees: () => Promise.resolve({ upserted: 0, deactivated: 0 }),
    pull_timesheets: () =>
      Promise.resolve({ inserted: 0, updated: 0, skipped_unmatched: 0 }),
    ...overrides,
  };
  return { deps, update_calls };
};

test('syncEmploymentHero: success path → idle + last_synced_at + counts surfaced', async () => {
  const { deps, update_calls } = baseDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: 'eh-org-001',
          last_synced_at: null,
        },
      ],
      subject_tenant: [{ id: SUBJECT_ID }],
      tenant_user: [{ user_id: ADMIN_USER_ID }],
    },
    {
      sync_employees: () => Promise.resolve({ upserted: 5, deactivated: 1 }),
      pull_timesheets: () =>
        Promise.resolve({ inserted: 12, updated: 3, skipped_unmatched: 2 }),
    },
  );

  const result = await syncEmploymentHero(CONNECTION_ID, deps);

  assert.equal(result.tenant_id, TENANT_ID);
  assert.equal(result.provider, 'employment_hero');
  assert.equal(result.employees.upserted, 5);
  assert.equal(result.employees.deactivated, 1);
  assert.equal(result.timesheets.inserted, 12);
  assert.equal(result.timesheets.updated, 3);
  assert.equal(result.timesheets.skipped_unmatched, 2);
  assert.equal(result.error, undefined);

  // 2 UPDATEs: 'syncing' followed by 'idle' (with last_synced_at).
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'syncing'"));
  assert.ok(update_calls[1]?.sql.includes("sync_state = 'idle'"));
  assert.ok(update_calls[1]?.sql.includes('last_synced_at = NOW()'));
});

test('syncEmploymentHero: forwards changed_since when last_synced_at is set', async () => {
  const previousSync = new Date('2026-04-25T00:00:00Z');
  let observedChangedSince: Date | undefined;
  const { deps } = baseDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: 'eh-org-001',
          last_synced_at: previousSync,
        },
      ],
      subject_tenant: [{ id: SUBJECT_ID }],
      tenant_user: [{ user_id: ADMIN_USER_ID }],
    },
    {
      sync_employees: (opts) => {
        observedChangedSince = opts.changed_since;
        return Promise.resolve({ upserted: 0, deactivated: 0 });
      },
    },
  );

  await syncEmploymentHero(CONNECTION_ID, deps);
  assert.equal(observedChangedSince?.toISOString(), previousSync.toISOString());
});

test('syncEmploymentHero: decrypt failure → sync_state=failed + last_error set', async () => {
  const { deps, update_calls } = baseDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: 'eh-org-001',
          last_synced_at: null,
        },
      ],
      subject_tenant: [{ id: SUBJECT_ID }],
      tenant_user: [{ user_id: ADMIN_USER_ID }],
    },
    {
      decrypt: () => {
        throw new Error('malformed encrypted token');
      },
    },
  );

  const result = await syncEmploymentHero(CONNECTION_ID, deps);

  assert.equal(result.error, 'malformed encrypted token');
  assert.equal(result.employees.upserted, 0);
  assert.equal(result.timesheets.inserted, 0);

  // 'syncing' then 'failed'.
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'syncing'"));
  assert.ok(update_calls[1]?.sql.includes("sync_state = 'failed'"));
  assert.ok(update_calls[1]?.sql.includes('last_error'));
  assert.equal(update_calls[1]?.params[0], 'malformed encrypted token');
});

test('syncEmploymentHero: no subject_tenant → sync fails with descriptive error', async () => {
  const { deps, update_calls } = baseDeps({
    integration_connection: [
      {
        tenant_id: TENANT_ID,
        access_token_encrypted: 'enc.blob',
        external_account_id: 'eh-org-001',
        last_synced_at: null,
      },
    ],
    subject_tenant: [], // none
    tenant_user: [{ user_id: ADMIN_USER_ID }],
  });

  const result = await syncEmploymentHero(CONNECTION_ID, deps);
  assert.equal(result.error, 'no subject_tenant for this connection');
  // 'syncing' then 'failed'.
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[1]?.sql.includes("sync_state = 'failed'"));
});

test('syncEmploymentHero: no admin user → sync fails', async () => {
  const { deps, update_calls } = baseDeps({
    integration_connection: [
      {
        tenant_id: TENANT_ID,
        access_token_encrypted: 'enc.blob',
        external_account_id: 'eh-org-001',
        last_synced_at: null,
      },
    ],
    subject_tenant: [{ id: SUBJECT_ID }],
    tenant_user: [], // none
  });

  const result = await syncEmploymentHero(CONNECTION_ID, deps);
  assert.equal(result.error, 'no admin user for this connection');
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[1]?.sql.includes("sync_state = 'failed'"));
});

test('syncEmploymentHero: missing connection row → throws', async () => {
  const { deps } = baseDeps({ integration_connection: [] });
  await assert.rejects(
    syncEmploymentHero(CONNECTION_ID, deps),
    /integration_connection not found or failed/,
  );
});

test('syncEmploymentHero: missing external_account_id → fails fast without calling sub-functions', async () => {
  let employeesCalled = false;
  let timesheetsCalled = false;
  const { deps, update_calls } = baseDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: null,
          last_synced_at: null,
        },
      ],
    },
    {
      sync_employees: () => {
        employeesCalled = true;
        return Promise.resolve({ upserted: 0, deactivated: 0 });
      },
      pull_timesheets: () => {
        timesheetsCalled = true;
        return Promise.resolve({ inserted: 0, updated: 0, skipped_unmatched: 0 });
      },
    },
  );

  const result = await syncEmploymentHero(CONNECTION_ID, deps);
  assert.match(result.error ?? '', /external_account_id/);
  assert.equal(employeesCalled, false);
  assert.equal(timesheetsCalled, false);
  // Single UPDATE flipping straight to 'failed' (no 'syncing' step).
  assert.equal(update_calls.length, 1);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'failed'"));
});

test('syncEmploymentHero: pulls call sub-functions with correct shared opts', async () => {
  let observedSyncOpts: Parameters<NonNullable<PayrollSyncDeps['sync_employees']>>[0] | null = null;
  let observedPullOpts: Parameters<NonNullable<PayrollSyncDeps['pull_timesheets']>>[0] | null = null;
  const { deps } = baseDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: 'eh-org-001',
          last_synced_at: null,
        },
      ],
      subject_tenant: [{ id: SUBJECT_ID }],
      tenant_user: [{ user_id: ADMIN_USER_ID }],
    },
    {
      sync_employees: (opts) => {
        observedSyncOpts = opts;
        return Promise.resolve({ upserted: 0, deactivated: 0 });
      },
      pull_timesheets: (opts) => {
        observedPullOpts = opts;
        return Promise.resolve({ inserted: 0, updated: 0, skipped_unmatched: 0 });
      },
    },
  );

  await syncEmploymentHero(CONNECTION_ID, deps);
  assert.ok(observedSyncOpts);
  assert.ok(observedPullOpts);
  assert.equal(observedSyncOpts.access_token, 'decrypted-access-token');
  assert.equal(observedSyncOpts.organisation_id, 'eh-org-001');
  assert.equal(observedSyncOpts.tenant_id, TENANT_ID);
  assert.equal(observedSyncOpts.subject_tenant_id, SUBJECT_ID);
  assert.equal(observedSyncOpts.invited_by_user_id, ADMIN_USER_ID);
  assert.equal(observedPullOpts.access_token, 'decrypted-access-token');
  assert.equal(observedPullOpts.organisation_id, 'eh-org-001');
});

// =====================================================================
// syncKeypay (T-B14) — mirrors syncEmploymentHero with two adaptations:
//   - Decrypted token is the KeyPay API key (not an OAuth access_token).
//   - external_account_id is the KeyPay business_id (string in DB, parsed
//     to number before invoking the KeyPay client).
// =====================================================================

const KEYPAY_CONNECTION_ID = '00000000-0000-4000-8000-000000000cc1';

type KeypayStubRows = {
  integration_connection?: Array<{
    tenant_id: string;
    access_token_encrypted: string;
    external_account_id: string | null;
    last_synced_at: Date | null;
  }>;
  subject_tenant?: Array<{ id: string }>;
  tenant_user?: Array<{ user_id: string }>;
};

function makeKeypaySqlStub(rows: KeypayStubRows): {
  sql: KeypaySyncDeps['sql_client'];
  update_calls: Array<{ sql: string; params: unknown[] }>;
} {
  const update_calls: Array<{ sql: string; params: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const rendered = strings.join('?');
    if (rendered.includes('UPDATE integration_connection')) {
      update_calls.push({ sql: rendered, params: values });
      return Promise.resolve([]);
    }
    if (rendered.includes('FROM integration_connection')) {
      return Promise.resolve(rows.integration_connection ?? []);
    }
    if (rendered.includes('FROM subject_tenant')) {
      return Promise.resolve(rows.subject_tenant ?? []);
    }
    if (rendered.includes('FROM tenant_user')) {
      return Promise.resolve(rows.tenant_user ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as KeypaySyncDeps['sql_client'];
  return { sql: fn, update_calls };
}

const baseKeypayDeps = (
  rows: KeypayStubRows,
  overrides: Partial<KeypaySyncDeps> = {},
): { deps: KeypaySyncDeps; update_calls: Array<{ sql: string; params: unknown[] }> } => {
  const { sql, update_calls } = makeKeypaySqlStub(rows);
  const deps: KeypaySyncDeps = {
    sql_client: sql,
    decrypt: () => 'decrypted-api-key',
    get_encryption_key: () => 'fake-key',
    sync_employees: () => Promise.resolve({ upserted: 0, deactivated: 0 }),
    pull_timesheets: () =>
      Promise.resolve({ inserted: 0, updated: 0, skipped_unmatched: 0 }),
    ...overrides,
  };
  return { deps, update_calls };
};

test('syncKeypay: success path → idle + business_id parsed to number + counts surfaced', async () => {
  let observedSyncOpts:
    | Parameters<NonNullable<KeypaySyncDeps['sync_employees']>>[0]
    | null = null;
  const { deps, update_calls } = baseKeypayDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: '4242',
          last_synced_at: null,
        },
      ],
      subject_tenant: [{ id: SUBJECT_ID }],
      tenant_user: [{ user_id: ADMIN_USER_ID }],
    },
    {
      sync_employees: (opts) => {
        observedSyncOpts = opts;
        return Promise.resolve({ upserted: 7, deactivated: 1 });
      },
      pull_timesheets: () =>
        Promise.resolve({ inserted: 15, updated: 4, skipped_unmatched: 1 }),
    },
  );

  const result = await syncKeypay(KEYPAY_CONNECTION_ID, deps);

  assert.equal(result.tenant_id, TENANT_ID);
  assert.equal(result.provider, 'keypay');
  assert.equal(result.employees.upserted, 7);
  assert.equal(result.employees.deactivated, 1);
  assert.equal(result.timesheets.inserted, 15);
  assert.equal(result.timesheets.updated, 4);
  assert.equal(result.timesheets.skipped_unmatched, 1);
  assert.equal(result.error, undefined);

  // Verify the KeyPay client is called with the parsed numeric business_id.
  assert.ok(observedSyncOpts);
  assert.equal(observedSyncOpts.api_key, 'decrypted-api-key');
  assert.equal(observedSyncOpts.business_id, 4242);
  assert.equal(typeof observedSyncOpts.business_id, 'number');
  assert.equal(observedSyncOpts.tenant_id, TENANT_ID);
  assert.equal(observedSyncOpts.subject_tenant_id, SUBJECT_ID);
  assert.equal(observedSyncOpts.invited_by_user_id, ADMIN_USER_ID);

  // 2 UPDATEs: 'syncing' then 'idle' (with last_synced_at).
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'syncing'"));
  assert.ok(update_calls[1]?.sql.includes("sync_state = 'idle'"));
  assert.ok(update_calls[1]?.sql.includes('last_synced_at = NOW()'));
});

test('syncKeypay: decrypt failure → sync_state=failed + last_error set', async () => {
  const { deps, update_calls } = baseKeypayDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: '4242',
          last_synced_at: null,
        },
      ],
      subject_tenant: [{ id: SUBJECT_ID }],
      tenant_user: [{ user_id: ADMIN_USER_ID }],
    },
    {
      decrypt: () => {
        throw new Error('malformed encrypted api key');
      },
    },
  );

  const result = await syncKeypay(KEYPAY_CONNECTION_ID, deps);

  assert.equal(result.error, 'malformed encrypted api key');
  assert.equal(result.provider, 'keypay');
  assert.equal(result.employees.upserted, 0);
  assert.equal(result.timesheets.inserted, 0);

  // 'syncing' then 'failed'.
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'syncing'"));
  assert.ok(update_calls[1]?.sql.includes("sync_state = 'failed'"));
  assert.equal(update_calls[1]?.params[0], 'malformed encrypted api key');
});

test('syncKeypay: missing external_account_id → fails fast without calling sub-functions', async () => {
  let employeesCalled = false;
  let timesheetsCalled = false;
  const { deps, update_calls } = baseKeypayDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: null,
          last_synced_at: null,
        },
      ],
    },
    {
      sync_employees: () => {
        employeesCalled = true;
        return Promise.resolve({ upserted: 0, deactivated: 0 });
      },
      pull_timesheets: () => {
        timesheetsCalled = true;
        return Promise.resolve({ inserted: 0, updated: 0, skipped_unmatched: 0 });
      },
    },
  );

  const result = await syncKeypay(KEYPAY_CONNECTION_ID, deps);
  assert.match(result.error ?? '', /business_id/);
  assert.equal(employeesCalled, false);
  assert.equal(timesheetsCalled, false);
  // Single UPDATE — straight to 'failed' (no 'syncing' step).
  assert.equal(update_calls.length, 1);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'failed'"));
});

test('syncKeypay: non-numeric external_account_id → sync_state=failed, no client calls', async () => {
  let employeesCalled = false;
  const { deps, update_calls } = baseKeypayDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: 'not-a-number',
          last_synced_at: null,
        },
      ],
    },
    {
      sync_employees: () => {
        employeesCalled = true;
        return Promise.resolve({ upserted: 0, deactivated: 0 });
      },
    },
  );

  const result = await syncKeypay(KEYPAY_CONNECTION_ID, deps);
  assert.match(result.error ?? '', /must be a positive integer/);
  assert.equal(employeesCalled, false);
  // Single UPDATE — straight to 'failed' (no 'syncing' step).
  assert.equal(update_calls.length, 1);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'failed'"));
  assert.ok(update_calls[0]?.sql.includes('positive integer'));
});

test('syncKeypay: missing connection row → throws', async () => {
  const { deps } = baseKeypayDeps({ integration_connection: [] });
  await assert.rejects(
    syncKeypay(KEYPAY_CONNECTION_ID, deps),
    /integration_connection not found or failed/,
  );
});

// =====================================================================
// syncDeputy (T-B17) — mirrors syncEmploymentHero (Deputy uses OAuth 2.0)
// with three adaptations:
//   - external_account_id holds the customer's Deputy install URL
//     (e.g. 'https://acme.deputy.com'); passed through as install_url.
//   - For v1 we surface a clear error if the access token has expired
//     (auto-refresh deferred to a follow-up task).
//   - Timesheet result includes the Deputy-specific skipped_discarded
//     counter for soft-deleted shifts.
// =====================================================================

const DEPUTY_CONNECTION_ID = '00000000-0000-4000-8000-000000000dd1';
const FUTURE_EXPIRES_AT = new Date(Date.now() + 60 * 60 * 1000); // +1h
const PAST_EXPIRES_AT = new Date(Date.now() - 60 * 1000); // -1m

type DeputyStubRows = {
  integration_connection?: Array<{
    tenant_id: string;
    access_token_encrypted: string;
    external_account_id: string | null;
    last_synced_at: Date | null;
    expires_at?: Date | null;
  }>;
  subject_tenant?: Array<{ id: string }>;
  tenant_user?: Array<{ user_id: string }>;
};

function makeDeputySqlStub(rows: DeputyStubRows): {
  sql: DeputySyncDeps['sql_client'];
  update_calls: Array<{ sql: string; params: unknown[] }>;
} {
  const update_calls: Array<{ sql: string; params: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const rendered = strings.join('?');
    if (rendered.includes('UPDATE integration_connection')) {
      update_calls.push({ sql: rendered, params: values });
      return Promise.resolve([]);
    }
    if (rendered.includes('FROM integration_connection')) {
      return Promise.resolve(rows.integration_connection ?? []);
    }
    if (rendered.includes('FROM subject_tenant')) {
      return Promise.resolve(rows.subject_tenant ?? []);
    }
    if (rendered.includes('FROM tenant_user')) {
      return Promise.resolve(rows.tenant_user ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as DeputySyncDeps['sql_client'];
  return { sql: fn, update_calls };
}

const baseDeputyDeps = (
  rows: DeputyStubRows,
  overrides: Partial<DeputySyncDeps> = {},
): { deps: DeputySyncDeps; update_calls: Array<{ sql: string; params: unknown[] }> } => {
  const { sql, update_calls } = makeDeputySqlStub(rows);
  const deps: DeputySyncDeps = {
    sql_client: sql,
    decrypt: () => 'decrypted-access-token',
    get_encryption_key: () => 'fake-key',
    sync_employees: () => Promise.resolve({ upserted: 0, deactivated: 0 }),
    pull_timesheets: () =>
      Promise.resolve({ inserted: 0, updated: 0, skipped_unmatched: 0, skipped_discarded: 0 }),
    ...overrides,
  };
  return { deps, update_calls };
};

test('syncDeputy: success path → idle + install_url forwarded + counts surfaced', async () => {
  let observedSyncOpts:
    | Parameters<NonNullable<DeputySyncDeps['sync_employees']>>[0]
    | null = null;
  let observedPullOpts:
    | Parameters<NonNullable<DeputySyncDeps['pull_timesheets']>>[0]
    | null = null;
  const { deps, update_calls } = baseDeputyDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: 'https://acme.deputy.com',
          last_synced_at: null,
          expires_at: FUTURE_EXPIRES_AT,
        },
      ],
      subject_tenant: [{ id: SUBJECT_ID }],
      tenant_user: [{ user_id: ADMIN_USER_ID }],
    },
    {
      sync_employees: (opts) => {
        observedSyncOpts = opts;
        return Promise.resolve({ upserted: 9, deactivated: 2 });
      },
      pull_timesheets: (opts) => {
        observedPullOpts = opts;
        return Promise.resolve({
          inserted: 11,
          updated: 5,
          skipped_unmatched: 1,
          skipped_discarded: 3,
        });
      },
    },
  );

  const result = await syncDeputy(DEPUTY_CONNECTION_ID, deps);

  assert.equal(result.tenant_id, TENANT_ID);
  assert.equal(result.provider, 'deputy');
  assert.equal(result.employees.upserted, 9);
  assert.equal(result.employees.deactivated, 2);
  assert.equal(result.timesheets.inserted, 11);
  assert.equal(result.timesheets.updated, 5);
  assert.equal(result.timesheets.skipped_unmatched, 1);
  assert.equal(result.timesheets.skipped_discarded, 3);
  assert.equal(result.error, undefined);

  // Verify the Deputy client receives install_url (not organisation_id).
  assert.ok(observedSyncOpts);
  assert.ok(observedPullOpts);
  assert.equal(observedSyncOpts.access_token, 'decrypted-access-token');
  assert.equal(observedSyncOpts.install_url, 'https://acme.deputy.com');
  assert.equal(observedSyncOpts.tenant_id, TENANT_ID);
  assert.equal(observedSyncOpts.subject_tenant_id, SUBJECT_ID);
  assert.equal(observedSyncOpts.invited_by_user_id, ADMIN_USER_ID);
  assert.equal(observedPullOpts.install_url, 'https://acme.deputy.com');

  // 2 UPDATEs: 'syncing' followed by 'idle' (with last_synced_at).
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'syncing'"));
  assert.ok(update_calls[1]?.sql.includes("sync_state = 'idle'"));
  assert.ok(update_calls[1]?.sql.includes('last_synced_at = NOW()'));
});

test('syncDeputy: decrypt failure → sync_state=failed + last_error set', async () => {
  const { deps, update_calls } = baseDeputyDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: 'https://acme.deputy.com',
          last_synced_at: null,
          expires_at: FUTURE_EXPIRES_AT,
        },
      ],
      subject_tenant: [{ id: SUBJECT_ID }],
      tenant_user: [{ user_id: ADMIN_USER_ID }],
    },
    {
      decrypt: () => {
        throw new Error('malformed encrypted access token');
      },
    },
  );

  const result = await syncDeputy(DEPUTY_CONNECTION_ID, deps);

  assert.equal(result.error, 'malformed encrypted access token');
  assert.equal(result.provider, 'deputy');
  assert.equal(result.employees.upserted, 0);
  assert.equal(result.timesheets.inserted, 0);

  // 'syncing' then 'failed'.
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'syncing'"));
  assert.ok(update_calls[1]?.sql.includes("sync_state = 'failed'"));
  assert.equal(update_calls[1]?.params[0], 'malformed encrypted access token');
});

test('syncDeputy: missing external_account_id (install_url) → fails fast without calling sub-functions', async () => {
  let employeesCalled = false;
  let timesheetsCalled = false;
  const { deps, update_calls } = baseDeputyDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: null,
          last_synced_at: null,
          expires_at: FUTURE_EXPIRES_AT,
        },
      ],
    },
    {
      sync_employees: () => {
        employeesCalled = true;
        return Promise.resolve({ upserted: 0, deactivated: 0 });
      },
      pull_timesheets: () => {
        timesheetsCalled = true;
        return Promise.resolve({
          inserted: 0,
          updated: 0,
          skipped_unmatched: 0,
          skipped_discarded: 0,
        });
      },
    },
  );

  const result = await syncDeputy(DEPUTY_CONNECTION_ID, deps);
  assert.match(result.error ?? '', /install_url/);
  assert.equal(employeesCalled, false);
  assert.equal(timesheetsCalled, false);
  // Single UPDATE — straight to 'failed' (no 'syncing' step).
  assert.equal(update_calls.length, 1);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'failed'"));
});

test('syncDeputy: expired access token → sync_state=failed with reconnect message, no client calls', async () => {
  let employeesCalled = false;
  const { deps, update_calls } = baseDeputyDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: 'https://acme.deputy.com',
          last_synced_at: null,
          expires_at: PAST_EXPIRES_AT,
        },
      ],
    },
    {
      sync_employees: () => {
        employeesCalled = true;
        return Promise.resolve({ upserted: 0, deactivated: 0 });
      },
    },
  );

  const result = await syncDeputy(DEPUTY_CONNECTION_ID, deps);
  assert.match(result.error ?? '', /access token expired/);
  assert.match(result.error ?? '', /reconnect required/);
  assert.equal(employeesCalled, false);
  // Single UPDATE — straight to 'failed' (no 'syncing' step).
  assert.equal(update_calls.length, 1);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'failed'"));
});

test('syncDeputy: missing connection row → throws', async () => {
  const { deps } = baseDeputyDeps({ integration_connection: [] });
  await assert.rejects(
    syncDeputy(DEPUTY_CONNECTION_ID, deps),
    /integration_connection not found or failed/,
  );
});

// =====================================================================
// syncXeroPayroll (T-B20) — mirrors syncDeputy (Xero uses OAuth 2.0)
// with three adaptations:
//   - external_account_id holds the Xero tenant_id (a GUID) discovered
//     via `GET /connections` after OAuth; passed through as
//     xero_tenant_id (which the client maps to the `Xero-tenant-id`
//     header on every API call).
//   - For v1 we surface a clear error if the access token has expired
//     (auto-refresh deferred — Xero's ~30-min token lifetime makes
//     this a higher-priority follow-up than Deputy's).
//   - Timesheet result includes the Xero-specific skipped_rejected
//     counter for consultant-rejected timesheets.
// =====================================================================

const XERO_CONNECTION_ID = '00000000-0000-4000-8000-000000000ee1';
const XERO_TENANT_GUID = '11111111-2222-3333-4444-555555555555';
const XERO_FUTURE_EXPIRES_AT = new Date(Date.now() + 30 * 60 * 1000); // +30m
const XERO_PAST_EXPIRES_AT = new Date(Date.now() - 60 * 1000); // -1m

type XeroStubRows = {
  integration_connection?: Array<{
    tenant_id: string;
    access_token_encrypted: string;
    external_account_id: string | null;
    last_synced_at: Date | null;
    expires_at?: Date | null;
  }>;
  subject_tenant?: Array<{ id: string }>;
  tenant_user?: Array<{ user_id: string }>;
};

function makeXeroSqlStub(rows: XeroStubRows): {
  sql: XeroPayrollSyncDeps['sql_client'];
  update_calls: Array<{ sql: string; params: unknown[] }>;
} {
  const update_calls: Array<{ sql: string; params: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const rendered = strings.join('?');
    if (rendered.includes('UPDATE integration_connection')) {
      update_calls.push({ sql: rendered, params: values });
      return Promise.resolve([]);
    }
    if (rendered.includes('FROM integration_connection')) {
      return Promise.resolve(rows.integration_connection ?? []);
    }
    if (rendered.includes('FROM subject_tenant')) {
      return Promise.resolve(rows.subject_tenant ?? []);
    }
    if (rendered.includes('FROM tenant_user')) {
      return Promise.resolve(rows.tenant_user ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as XeroPayrollSyncDeps['sql_client'];
  return { sql: fn, update_calls };
}

const baseXeroDeps = (
  rows: XeroStubRows,
  overrides: Partial<XeroPayrollSyncDeps> = {},
): { deps: XeroPayrollSyncDeps; update_calls: Array<{ sql: string; params: unknown[] }> } => {
  const { sql, update_calls } = makeXeroSqlStub(rows);
  const deps: XeroPayrollSyncDeps = {
    sql_client: sql,
    decrypt: () => 'decrypted-access-token',
    get_encryption_key: () => 'fake-key',
    sync_employees: () => Promise.resolve({ upserted: 0, deactivated: 0 }),
    pull_timesheets: () =>
      Promise.resolve({ inserted: 0, updated: 0, skipped_unmatched: 0, skipped_rejected: 0 }),
    ...overrides,
  };
  return { deps, update_calls };
};

test('syncXeroPayroll: success path → idle + xero_tenant_id forwarded + counts surfaced', async () => {
  let observedSyncOpts:
    | Parameters<NonNullable<XeroPayrollSyncDeps['sync_employees']>>[0]
    | null = null;
  let observedPullOpts:
    | Parameters<NonNullable<XeroPayrollSyncDeps['pull_timesheets']>>[0]
    | null = null;
  const { deps, update_calls } = baseXeroDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: XERO_TENANT_GUID,
          last_synced_at: null,
          expires_at: XERO_FUTURE_EXPIRES_AT,
        },
      ],
      subject_tenant: [{ id: SUBJECT_ID }],
      tenant_user: [{ user_id: ADMIN_USER_ID }],
    },
    {
      sync_employees: (opts) => {
        observedSyncOpts = opts;
        return Promise.resolve({ upserted: 4, deactivated: 1 });
      },
      pull_timesheets: (opts) => {
        observedPullOpts = opts;
        return Promise.resolve({
          inserted: 14,
          updated: 2,
          skipped_unmatched: 0,
          skipped_rejected: 1,
        });
      },
    },
  );

  const result = await syncXeroPayroll(XERO_CONNECTION_ID, deps);

  assert.equal(result.tenant_id, TENANT_ID);
  assert.equal(result.provider, 'xero_payroll');
  assert.equal(result.employees.upserted, 4);
  assert.equal(result.employees.deactivated, 1);
  assert.equal(result.timesheets.inserted, 14);
  assert.equal(result.timesheets.updated, 2);
  assert.equal(result.timesheets.skipped_unmatched, 0);
  assert.equal(result.timesheets.skipped_rejected, 1);
  assert.equal(result.error, undefined);

  // Verify the Xero client receives xero_tenant_id (not install_url /
  // organisation_id / business_id).
  assert.ok(observedSyncOpts);
  assert.ok(observedPullOpts);
  assert.equal(observedSyncOpts.access_token, 'decrypted-access-token');
  assert.equal(observedSyncOpts.xero_tenant_id, XERO_TENANT_GUID);
  assert.equal(observedSyncOpts.tenant_id, TENANT_ID);
  assert.equal(observedSyncOpts.subject_tenant_id, SUBJECT_ID);
  assert.equal(observedSyncOpts.invited_by_user_id, ADMIN_USER_ID);
  assert.equal(observedPullOpts.xero_tenant_id, XERO_TENANT_GUID);

  // 2 UPDATEs: 'syncing' followed by 'idle' (with last_synced_at).
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'syncing'"));
  assert.ok(update_calls[1]?.sql.includes("sync_state = 'idle'"));
  assert.ok(update_calls[1]?.sql.includes('last_synced_at = NOW()'));
});

test('syncXeroPayroll: decrypt failure → sync_state=failed + last_error set', async () => {
  const { deps, update_calls } = baseXeroDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: XERO_TENANT_GUID,
          last_synced_at: null,
          expires_at: XERO_FUTURE_EXPIRES_AT,
        },
      ],
      subject_tenant: [{ id: SUBJECT_ID }],
      tenant_user: [{ user_id: ADMIN_USER_ID }],
    },
    {
      decrypt: () => {
        throw new Error('malformed encrypted access token');
      },
    },
  );

  const result = await syncXeroPayroll(XERO_CONNECTION_ID, deps);

  assert.equal(result.error, 'malformed encrypted access token');
  assert.equal(result.provider, 'xero_payroll');
  assert.equal(result.employees.upserted, 0);
  assert.equal(result.timesheets.inserted, 0);

  // 'syncing' then 'failed'.
  assert.equal(update_calls.length, 2);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'syncing'"));
  assert.ok(update_calls[1]?.sql.includes("sync_state = 'failed'"));
  assert.equal(update_calls[1]?.params[0], 'malformed encrypted access token');
});

test('syncXeroPayroll: missing external_account_id (xero_tenant_id) → fails fast without calling sub-functions', async () => {
  let employeesCalled = false;
  let timesheetsCalled = false;
  const { deps, update_calls } = baseXeroDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: null,
          last_synced_at: null,
          expires_at: XERO_FUTURE_EXPIRES_AT,
        },
      ],
    },
    {
      sync_employees: () => {
        employeesCalled = true;
        return Promise.resolve({ upserted: 0, deactivated: 0 });
      },
      pull_timesheets: () => {
        timesheetsCalled = true;
        return Promise.resolve({
          inserted: 0,
          updated: 0,
          skipped_unmatched: 0,
          skipped_rejected: 0,
        });
      },
    },
  );

  const result = await syncXeroPayroll(XERO_CONNECTION_ID, deps);
  assert.match(result.error ?? '', /xero_tenant_id/);
  assert.equal(employeesCalled, false);
  assert.equal(timesheetsCalled, false);
  // Single UPDATE — straight to 'failed' (no 'syncing' step).
  assert.equal(update_calls.length, 1);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'failed'"));
});

test('syncXeroPayroll: expired access token → sync_state=failed with reconnect message, no client calls', async () => {
  let employeesCalled = false;
  const { deps, update_calls } = baseXeroDeps(
    {
      integration_connection: [
        {
          tenant_id: TENANT_ID,
          access_token_encrypted: 'enc.blob',
          external_account_id: XERO_TENANT_GUID,
          last_synced_at: null,
          expires_at: XERO_PAST_EXPIRES_AT,
        },
      ],
    },
    {
      sync_employees: () => {
        employeesCalled = true;
        return Promise.resolve({ upserted: 0, deactivated: 0 });
      },
    },
  );

  const result = await syncXeroPayroll(XERO_CONNECTION_ID, deps);
  assert.match(result.error ?? '', /access token expired/);
  assert.match(result.error ?? '', /reconnect required/);
  assert.equal(employeesCalled, false);
  // Single UPDATE — straight to 'failed' (no 'syncing' step).
  assert.equal(update_calls.length, 1);
  assert.ok(update_calls[0]?.sql.includes("sync_state = 'failed'"));
});

test('syncXeroPayroll: missing connection row → throws', async () => {
  const { deps } = baseXeroDeps({ integration_connection: [] });
  await assert.rejects(
    syncXeroPayroll(XERO_CONNECTION_ID, deps),
    /integration_connection not found or failed/,
  );
});
