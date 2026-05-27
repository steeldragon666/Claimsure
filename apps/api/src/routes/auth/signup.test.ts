import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import type { SignupEvaluator, SignupEvaluatorOutput } from '@cpa/agents/signup-evaluator';

// ---------------------------------------------------------------------------
// Test constants — fixed per-firm so cleanup is targeted.
// ---------------------------------------------------------------------------

const TEST_SESSION_SECRET = 'test-signup-session-secret-p9163!!';
const TEST_VERIFICATION_SECRET = 'test-signup-verification-secret-p9163!!';
const TEST_EMAIL = 'signup-test-p9163@example.com';
const TEST_EMAIL_DENY = 'signup-test-deny-p9163@example.com';
const TEST_EMAIL_OVERRIDE = 'override-test-p9163@example.com';
const TEST_EMAIL_DUPE = 'signup-test-dupe-p9163@example.com';
const TEST_FIRM = 'P9 Test Firm (signup)';
const TEST_FIRM_DENY = 'P9 Test Firm (deny)';
const TEST_FIRM_OVERRIDE = 'P9 Test Firm (override)';
const TEST_FIRM_DUPE_FIRST = 'P9 Test Firm (dupe-first)';
const TEST_FIRM_DUPE_SECOND = 'P9 Test Firm (dupe-second)';

// ---------------------------------------------------------------------------
// Mock evaluators
// ---------------------------------------------------------------------------

function approveEvaluator(): SignupEvaluator {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(): Promise<SignupEvaluatorOutput> {
      return {
        decision: 'approve',
        confidence: 0.9,
        rationale: 'test-approve',
        red_flags: [],
        model: 'test-evaluator',
        prompt_version: 'evaluate-signup@1.0.0',
        tokens_in: 100,
        tokens_out: 30,
      };
    },
  };
}

function denyEvaluator(): SignupEvaluator {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(): Promise<SignupEvaluatorOutput> {
      return {
        decision: 'deny',
        confidence: 0.95,
        rationale: 'test-deny',
        red_flags: ['test red flag'],
        model: 'test-evaluator',
        prompt_version: 'evaluate-signup@1.0.0',
        tokens_in: 100,
        tokens_out: 30,
      };
    },
  };
}

function throwingEvaluator(): SignupEvaluator {
  return {
    evaluate(): Promise<SignupEvaluatorOutput> {
      throw new Error('test: evaluator must not be called');
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSignupApp(evaluator: SignupEvaluator) {
  const app = buildApp({
    signup: {
      sessionSecret: TEST_SESSION_SECRET,
      verificationSecret: TEST_VERIFICATION_SECRET,
      cookieName: 'cpa_session',
      cookieSecure: false,
      ttlSeconds: 3600,
      signupEvaluator: evaluator,
    },
  });
  return { app };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function cleanup() {
  const firms = [
    TEST_FIRM,
    TEST_FIRM_DENY,
    TEST_FIRM_OVERRIDE,
    TEST_FIRM_DUPE_FIRST,
    TEST_FIRM_DUPE_SECOND,
  ];
  const emails = [TEST_EMAIL, TEST_EMAIL_DENY, TEST_EMAIL_OVERRIDE, TEST_EMAIL_DUPE];
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (
    SELECT id FROM tenant WHERE name = ANY(${firms}::text[])
  )`;
  await privilegedSql`DELETE FROM tenant WHERE name = ANY(${firms}::text[])`;
  await sql`DELETE FROM "user" WHERE email = ANY(${emails}::text[])`;
  await privilegedSql`DELETE FROM signup_decision WHERE email = ANY(${emails}::text[])`;
}

before(cleanup);
after(cleanup);

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

test('POST /v1/auth/signup: 422 with missing email', async () => {
  const { app } = buildSignupApp(throwingEvaluator());
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { firmName: 'Some Firm' },
  });
  assert.equal(res.statusCode, 422);
  await app.close();
});

test('POST /v1/auth/signup: 422 with missing firmName', async () => {
  const { app } = buildSignupApp(throwingEvaluator());
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: TEST_EMAIL },
  });
  assert.equal(res.statusCode, 422);
  await app.close();
});

// ---------------------------------------------------------------------------
// APPROVE path
// ---------------------------------------------------------------------------

test('POST /v1/auth/signup: 200 on approve — creates tenant + sets session cookie + redirectTo', async () => {
  await cleanup();
  const { app } = buildSignupApp(approveEvaluator());
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: TEST_EMAIL, firmName: TEST_FIRM, displayName: 'Test User' },
  });
  assert.equal(res.statusCode, 200);
  const body: { ok: boolean; decision: string; redirectTo: string } = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.decision, 'approved');
  assert.equal(body.redirectTo, '/subject-tenants');

  // Session cookie must be set
  const setCookie = res.headers['set-cookie'] as string | string[];
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
  assert.ok(cookieStr?.includes('cpa_session'), 'session cookie must be set');

  // Tenant row should exist with trial settings
  const rows = await sql<{ trial_status: string; billing_mode: string; trial_ends_at: Date }[]>`
    SELECT trial_status, billing_mode, trial_ends_at
      FROM tenant
     WHERE name = ${TEST_FIRM}
  `;
  assert.equal(rows[0]?.trial_status, 'active');
  assert.equal(rows[0]?.billing_mode, 'trial');

  // tenant_user row should exist with admin role
  const tuRows = await privilegedSql<{ role: string }[]>`
    SELECT tu.role
      FROM tenant_user tu
      JOIN tenant t ON t.id = tu.tenant_id
     WHERE t.name = ${TEST_FIRM}
  `;
  assert.equal(tuRows[0]?.role, 'admin');

  // signup_decision audit row should exist
  const auditRows = await privilegedSql<
    {
      decision: string;
      reason: string;
      resulting_tenant_id: string | null;
      resulting_user_id: string | null;
    }[]
  >`
    SELECT decision, reason, resulting_tenant_id, resulting_user_id
      FROM signup_decision
     WHERE email = ${TEST_EMAIL}
  `;
  assert.equal(auditRows[0]?.decision, 'approve');
  assert.equal(auditRows[0]?.reason, 'claude_approve');
  assert.ok(auditRows[0]?.resulting_tenant_id);
  assert.ok(auditRows[0]?.resulting_user_id);

  await app.close();
});

// ---------------------------------------------------------------------------
// DENY path
// ---------------------------------------------------------------------------

test('POST /v1/auth/signup: 403 on deny — no tenant created + generic message', async () => {
  await cleanup();
  const { app } = buildSignupApp(denyEvaluator());
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: TEST_EMAIL_DENY, firmName: TEST_FIRM_DENY },
  });
  assert.equal(res.statusCode, 403);
  const body: { ok: boolean; decision: string; message: string } = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.decision, 'denied');
  // Generic message — no probing for reason.
  assert.ok(body.message.includes('aaron@carbonproject.com.au'));
  // Reason MUST NOT be exposed
  assert.ok(!('reason' in body));

  // No tenant created
  const rows = await sql<{ id: string }[]>`SELECT id FROM tenant WHERE name = ${TEST_FIRM_DENY}`;
  assert.equal(rows.length, 0);

  // No user created
  const userRows = await sql<
    { id: string }[]
  >`SELECT id FROM "user" WHERE email = ${TEST_EMAIL_DENY}`;
  assert.equal(userRows.length, 0);

  // Audit row should exist with decision=deny
  const auditRows = await privilegedSql<{ decision: string; reason: string }[]>`
    SELECT decision, reason FROM signup_decision WHERE email = ${TEST_EMAIL_DENY}
  `;
  assert.equal(auditRows[0]?.decision, 'deny');

  await app.close();
});

// ---------------------------------------------------------------------------
// Admin override path
// ---------------------------------------------------------------------------

test('POST /v1/auth/signup: admin override approves without calling evaluator', async () => {
  await cleanup();
  process.env['SIGNUP_AUTO_APPROVE_OVERRIDE_EMAILS'] = TEST_EMAIL_OVERRIDE;
  try {
    const { app } = buildSignupApp(throwingEvaluator()); // would throw if called
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: TEST_EMAIL_OVERRIDE, firmName: TEST_FIRM_OVERRIDE },
    });
    assert.equal(res.statusCode, 200);
    const body: { decision: string } = res.json();
    assert.equal(body.decision, 'approved');

    const auditRows = await privilegedSql<{ reason: string; admin_override_hit: boolean }[]>`
      SELECT reason, admin_override_hit FROM signup_decision WHERE email = ${TEST_EMAIL_OVERRIDE}
    `;
    assert.equal(auditRows[0]?.reason, 'admin_override');
    assert.equal(auditRows[0]?.admin_override_hit, true);

    await app.close();
  } finally {
    delete process.env['SIGNUP_AUTO_APPROVE_OVERRIDE_EMAILS'];
  }
});

// ---------------------------------------------------------------------------
// Duplicate-registration regression (PR #101 hardening, finding #12)
// ---------------------------------------------------------------------------

test('POST /v1/auth/signup: second signup with same email returns 409 and creates no extra tenant/user', async () => {
  await cleanup();
  // First signup — approved + tenant created.
  const first = buildSignupApp(approveEvaluator());
  const firstRes = await first.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: TEST_EMAIL_DUPE, firmName: TEST_FIRM_DUPE_FIRST, displayName: 'Dupe One' },
  });
  assert.equal(firstRes.statusCode, 200);
  await first.app.close();

  // Capture state after the first signup.
  const tenantsBefore = await sql<
    { id: string; name: string }[]
  >`SELECT id, name FROM tenant WHERE name = ANY(${[TEST_FIRM_DUPE_FIRST, TEST_FIRM_DUPE_SECOND]}::text[])`;
  assert.equal(tenantsBefore.length, 1, 'first signup should produce exactly one tenant');
  const usersBefore = await sql<
    { id: string }[]
  >`SELECT id FROM "user" WHERE email = ${TEST_EMAIL_DUPE}`;
  assert.equal(usersBefore.length, 1, 'first signup should produce exactly one user');

  // Second signup — same email, different firm name. Must 409 already_registered.
  const second = buildSignupApp(approveEvaluator());
  const secondRes = await second.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      email: TEST_EMAIL_DUPE,
      firmName: TEST_FIRM_DUPE_SECOND,
      displayName: 'Dupe Two',
    },
  });
  assert.equal(secondRes.statusCode, 409);
  const secondBody: { error: string } = secondRes.json();
  assert.equal(secondBody.error, 'already_registered');
  await second.app.close();

  // No NEW tenant created (only the original).
  const tenantsAfter = await sql<
    { name: string }[]
  >`SELECT name FROM tenant WHERE name = ANY(${[TEST_FIRM_DUPE_FIRST, TEST_FIRM_DUPE_SECOND]}::text[])`;
  assert.equal(tenantsAfter.length, 1, 'second signup must not create a tenant');
  assert.equal(tenantsAfter[0]?.name, TEST_FIRM_DUPE_FIRST);

  // No NEW user created.
  const usersAfter = await sql<
    { id: string }[]
  >`SELECT id FROM "user" WHERE email = ${TEST_EMAIL_DUPE}`;
  assert.equal(usersAfter.length, 1, 'second signup must not create a user');

  // Audit row for the second attempt should be reason=already_registered.
  const auditRows = await privilegedSql<
    {
      decision: string;
      reason: string;
      resulting_tenant_id: string | null;
      resulting_user_id: string | null;
    }[]
  >`
    SELECT decision, reason, resulting_tenant_id, resulting_user_id
      FROM signup_decision
     WHERE email = ${TEST_EMAIL_DUPE}
     ORDER BY decided_at ASC
  `;
  assert.equal(auditRows.length, 2, 'two audit rows: first approve, then already_registered');
  assert.equal(auditRows[0]?.reason, 'claude_approve');
  assert.equal(auditRows[1]?.reason, 'already_registered');
  // Resulting IDs on the duplicate audit row MUST be null — no tenant was created.
  assert.equal(auditRows[1]?.resulting_tenant_id, null);
  assert.equal(auditRows[1]?.resulting_user_id, null);
});

// ---------------------------------------------------------------------------
// Legacy /v1/auth/verify-email — returns 410 Gone
// ---------------------------------------------------------------------------

test('POST /v1/auth/verify-email: legacy endpoint returns 410 with explanation', async () => {
  const { app } = buildSignupApp(approveEvaluator());
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: 'anything' },
  });
  assert.equal(res.statusCode, 410);
  const body: { error: string; message: string } = res.json();
  assert.equal(body.error, 'verification_flow_retired');
  assert.ok(body.message.includes('/signup'));
  await app.close();
});
