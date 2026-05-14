/**
 * Integration tests for GET /v1/claims/:id/budget.
 *
 * Mirrors the pattern in activities.test.ts: signSession() to mint a
 * cpa_session JWT, buildApp() per test, app.inject() to call the route.
 *
 * Coverage:
 *   1. Empty claim returns 0 used / full remaining / no agents
 *   2. Several free-tier rows aggregate correctly
 *   3. Crossing the A$50 threshold flips status to over_quota and
 *      remaining goes negative
 *   4. Per-agent breakdown sorted by spend desc
 *   5. 404 for a claim that doesn't exist
 *   6. 404 for a claim in a different tenant
 *   7. 401 without a session cookie
 *   8. claim_id=null rows are NOT counted (tenant-wide quota)
 */
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '@cpa/auth';
import { buildApp } from '../app.js';
import { privilegedSql, sql } from '@cpa/db/client';

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Pinned UUIDs (segment 'cb01' = "claim-budget 01")
const TENANT = '00000000-0000-4000-8000-0000000cb001';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000cb002';
const ADMIN_USER = '00000000-0000-4000-8000-0000000cb010';
const SUBJECT = '00000000-0000-4000-8000-0000000cb020';
const OTHER_SUBJECT = '00000000-0000-4000-8000-0000000cb021';
const PROJECT = '00000000-0000-4000-8000-0000000cb030';
const CLAIM = '00000000-0000-4000-8000-0000000cb040';
const OTHER_CLAIM = '00000000-0000-4000-8000-0000000cb041';
const MISSING_CLAIM = '00000000-0000-4000-8000-0000000cb0ff';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM llm_token_usage WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await privilegedSql`DELETE FROM project WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT}, ${OTHER_TENANT})`;
};

before(async () => {
  await cleanup();

  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT}, 'Budget Test Firm', 'budget-test', 'mixed')`;
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${OTHER_TENANT}, 'Other Firm', 'other-firm', 'mixed')`;

  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'cb-admin@example.com', 'microsoft', 'microsoft:cb-admin', 'CB Admin')`;

  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)`;

  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT}, ${TENANT}, 'Acme R&D CB', 'claimant')`;

  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT}, ${TENANT}, ${SUBJECT}, 'CB Project', '2025-07-01T00:00:00Z')`;

  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
                       VALUES (${CLAIM}, ${TENANT}, ${SUBJECT}, ${PROJECT}, 2026, 'engagement')`;

  // Other-tenant claim so we can verify cross-tenant 404.
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${OTHER_SUBJECT}, ${OTHER_TENANT}, 'Other claimant', 'claimant')`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
                       VALUES (${OTHER_CLAIM}, ${OTHER_TENANT}, ${OTHER_SUBJECT}, 2026, 'engagement')`;
});

beforeEach(async () => {
  await privilegedSql`DELETE FROM llm_token_usage WHERE tenant_id IN (${TENANT}, ${OTHER_TENANT})`;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const adminJwt = (tenantId: string = TENANT): Promise<string> =>
  signSession(
    {
      sub: ADMIN_USER,
      email: 'cb-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

async function seedLedgerRow(opts: {
  tenant_id?: string;
  claim_id?: string | null;
  agent_name: string;
  cost_aud_cents: number;
  status: 'free_tier' | 'billable' | 'gifted';
}): Promise<void> {
  await privilegedSql`
    INSERT INTO llm_token_usage
      (tenant_id, claim_id, subject_tenant_id, agent_name, model,
       tokens_in, tokens_out, cost_aud_cents, status)
    VALUES
      (${opts.tenant_id ?? TENANT},
       ${opts.claim_id === undefined ? CLAIM : opts.claim_id},
       ${SUBJECT},
       ${opts.agent_name},
       'claude-haiku-4-5',
       1000, 500,
       ${opts.cost_aud_cents},
       ${opts.status})
  `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('GET /v1/claims/:id/budget: 401 without session cookie', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM}/budget`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /v1/claims/:id/budget: empty ledger returns zeros', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM}/budget`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    used_aud_cents: number;
    remaining_aud_cents: number;
    budget_aud_cents: number;
    status: string;
    call_count: number;
    billable_aud_cents: number;
    free_tier_aud_cents: number;
    agents: unknown[];
  }>();
  assert.equal(body.used_aud_cents, 0);
  assert.equal(body.remaining_aud_cents, 5000);
  assert.equal(body.budget_aud_cents, 5000);
  assert.equal(body.status, 'free_tier');
  assert.equal(body.call_count, 0);
  assert.equal(body.billable_aud_cents, 0);
  assert.equal(body.free_tier_aud_cents, 0);
  assert.deepEqual(body.agents, []);
  await app.close();
});

test('GET /v1/claims/:id/budget: three free-tier rows aggregate', async () => {
  await seedLedgerRow({ agent_name: 'document-analyzer', cost_aud_cents: 12, status: 'free_tier' });
  await seedLedgerRow({ agent_name: 'document-analyzer', cost_aud_cents: 18, status: 'free_tier' });
  await seedLedgerRow({
    agent_name: 'application-drafter',
    cost_aud_cents: 72,
    status: 'free_tier',
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM}/budget`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    used_aud_cents: number;
    remaining_aud_cents: number;
    status: string;
    call_count: number;
    free_tier_aud_cents: number;
    billable_aud_cents: number;
  }>();
  assert.equal(body.used_aud_cents, 102);
  assert.equal(body.remaining_aud_cents, 4898);
  assert.equal(body.status, 'free_tier');
  assert.equal(body.call_count, 3);
  assert.equal(body.free_tier_aud_cents, 102);
  assert.equal(body.billable_aud_cents, 0);
  await app.close();
});

test('GET /v1/claims/:id/budget: over-quota flips status + remaining negative', async () => {
  await seedLedgerRow({
    agent_name: 'application-drafter',
    cost_aud_cents: 4900,
    status: 'free_tier',
  });
  await seedLedgerRow({
    agent_name: 'application-drafter',
    cost_aud_cents: 200,
    status: 'free_tier',
  });
  await seedLedgerRow({
    agent_name: 'insights-generator',
    cost_aud_cents: 108,
    status: 'billable',
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM}/budget`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    used_aud_cents: number;
    remaining_aud_cents: number;
    status: string;
    free_tier_aud_cents: number;
    billable_aud_cents: number;
  }>();
  assert.equal(body.used_aud_cents, 5208);
  assert.equal(body.remaining_aud_cents, -208);
  assert.equal(body.status, 'over_quota');
  assert.equal(body.free_tier_aud_cents, 5100);
  assert.equal(body.billable_aud_cents, 108);
  await app.close();
});

test('GET /v1/claims/:id/budget: per-agent breakdown sorted by spend desc', async () => {
  await seedLedgerRow({ agent_name: 'insights-generator', cost_aud_cents: 50, status: 'billable' });
  await seedLedgerRow({ agent_name: 'document-analyzer', cost_aud_cents: 5, status: 'free_tier' });
  await seedLedgerRow({
    agent_name: 'application-drafter',
    cost_aud_cents: 700,
    status: 'free_tier',
  });
  await seedLedgerRow({
    agent_name: 'application-drafter',
    cost_aud_cents: 50,
    status: 'free_tier',
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM}/budget`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    agents: Array<{ agent_name: string; call_count: number; total_aud_cents: number }>;
  }>();
  assert.equal(body.agents.length, 3);
  // Sorted by spend desc: drafter (750) > insights (50) > analyzer (5)
  assert.equal(body.agents[0]!.agent_name, 'application-drafter');
  assert.equal(body.agents[0]!.total_aud_cents, 750);
  assert.equal(body.agents[0]!.call_count, 2);
  assert.equal(body.agents[1]!.agent_name, 'insights-generator');
  assert.equal(body.agents[1]!.total_aud_cents, 50);
  assert.equal(body.agents[2]!.agent_name, 'document-analyzer');
  await app.close();
});

test('GET /v1/claims/:id/budget: 404 for missing claim', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${MISSING_CLAIM}/budget`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json<{ error: string }>();
  assert.equal(body.error, 'claim_not_found');
  await app.close();
});

test('GET /v1/claims/:id/budget: 404 for other-tenant claim (cross-firm isolation)', async () => {
  // Seed a ledger row on the OTHER tenant's claim — even if isolation
  // were broken we'd still get a clean 404 because the tenant guard
  // runs before the aggregate query.
  await seedLedgerRow({
    tenant_id: OTHER_TENANT,
    claim_id: OTHER_CLAIM,
    agent_name: 'insights-generator',
    cost_aud_cents: 999,
    status: 'free_tier',
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${OTHER_CLAIM}/budget`,
    cookies: { cpa_session: await adminJwt() }, // session is for TENANT, not OTHER_TENANT
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /v1/claims/:id/budget: claim_id=null rows are NOT counted (tenant-wide quota)', async () => {
  // Extraction calls record with claim_id=null. They should NOT count
  // against any specific claim's A$50 envelope.
  await seedLedgerRow({
    claim_id: null,
    agent_name: 'document-analyzer',
    cost_aud_cents: 999,
    status: 'free_tier',
  });
  await seedLedgerRow({
    agent_name: 'application-drafter',
    cost_aud_cents: 50,
    status: 'free_tier',
  });

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/v1/claims/${CLAIM}/budget`,
    cookies: { cpa_session: await adminJwt() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ used_aud_cents: number; call_count: number }>();
  // Only the drafter row counts — not the null-claim-id extraction.
  assert.equal(body.used_aud_cents, 50);
  assert.equal(body.call_count, 1);
  await app.close();
});
