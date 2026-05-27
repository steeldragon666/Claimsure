import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../../app.js';
import { signFounderApproveToken } from '../../lib/founder-override-token.js';

const TEST_SESSION_SECRET = 'test-founder-approve-session-secret-32+bytes!!';
const TEST_OVERRIDE_SECRET = 'test-founder-approve-override-secret-32+bytes!!';
const TEST_EMAIL = 'founder-approve-test@example.com';
const TEST_FIRM = 'Founder Approve Test Firm';
const TEST_FIRM_ALREADY = 'Founder Approve Already Registered Firm';

interface RecordedSend {
  to: string | string[];
  subject: string;
  text: string;
  html: string;
}

function recorder(): {
  sender: {
    send: (input: RecordedSend) => Promise<{ id: string }>;
  };
  sent: RecordedSend[];
} {
  const sent: RecordedSend[] = [];
  return {
    sent,
    sender: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async send(input: RecordedSend): Promise<{ id: string }> {
        sent.push(input);
        return { id: `rec-${sent.length}` };
      },
    },
  };
}

function buildHostedApp(applicantSender: ReturnType<typeof recorder>['sender']) {
  return buildApp({
    founderApprove: {
      overrideSecret: TEST_OVERRIDE_SECRET,
      sessionSecret: TEST_SESSION_SECRET,
      applicantSigninSender: applicantSender,
    },
  });
}

async function insertClaudeDenyRow(args: { email: string; firmName: string }): Promise<string> {
  const rows = await privilegedSql<{ id: string }[]>`
    INSERT INTO signup_decision (
      email, firm_name, decision, reason,
      admin_override_hit, claude_decision, claude_confidence
    ) VALUES (
      ${args.email}, ${args.firmName}, 'deny', 'claude_deny',
      false, 'deny', 0.91
    )
    RETURNING id::text AS id
  `;
  return rows[0]!.id;
}

async function cleanup() {
  const firms = [TEST_FIRM, TEST_FIRM_ALREADY];
  const emails = [TEST_EMAIL];
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (
    SELECT id FROM tenant WHERE name = ANY(${firms}::text[])
  )`;
  await privilegedSql`DELETE FROM tenant WHERE name = ANY(${firms}::text[])`;
  await sql`DELETE FROM "user" WHERE email = ANY(${emails}::text[])`;
  await privilegedSql`DELETE FROM signup_decision WHERE email = ANY(${emails}::text[])`;
}

before(cleanup);
after(cleanup);

test('founder-approve: 401 HTML on missing token', async () => {
  await cleanup();
  const rec = recorder();
  const app = buildHostedApp(rec.sender);
  const decisionId = await insertClaudeDenyRow({ email: TEST_EMAIL, firmName: TEST_FIRM });
  const res = await app.inject({
    method: 'GET',
    url: `/v1/admin/signup-decisions/${decisionId}/approve`,
  });
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  await app.close();
});

test('founder-approve: 401 HTML on invalid token', async () => {
  await cleanup();
  const rec = recorder();
  const app = buildHostedApp(rec.sender);
  const decisionId = await insertClaudeDenyRow({ email: TEST_EMAIL, firmName: TEST_FIRM });
  const res = await app.inject({
    method: 'GET',
    url: `/v1/admin/signup-decisions/${decisionId}/approve?token=not-a-valid-token`,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('founder-approve: 400 HTML when decision is not claude_deny', async () => {
  await cleanup();
  const rec = recorder();
  const app = buildHostedApp(rec.sender);
  // Insert an approve row — should be ineligible.
  const rows = await privilegedSql<{ id: string }[]>`
    INSERT INTO signup_decision (
      email, firm_name, decision, reason, admin_override_hit
    ) VALUES (
      ${TEST_EMAIL}, ${TEST_FIRM}, 'approve', 'claude_approve', false
    )
    RETURNING id::text AS id
  `;
  const decisionId = rows[0]!.id;
  const token = signFounderApproveToken({
    decisionId,
    applicantEmail: TEST_EMAIL,
    secret: TEST_OVERRIDE_SECRET,
  });
  const res = await app.inject({
    method: 'GET',
    url: `/v1/admin/signup-decisions/${decisionId}/approve?token=${encodeURIComponent(token)}`,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /not eligible/i);
  await app.close();
});

test('founder-approve: happy path creates tenant + audit row + applicant email', async () => {
  await cleanup();
  const rec = recorder();
  const app = buildHostedApp(rec.sender);
  const decisionId = await insertClaudeDenyRow({ email: TEST_EMAIL, firmName: TEST_FIRM });
  const token = signFounderApproveToken({
    decisionId,
    applicantEmail: TEST_EMAIL,
    secret: TEST_OVERRIDE_SECRET,
  });

  const res = await app.inject({
    method: 'GET',
    url: `/v1/admin/signup-decisions/${decisionId}/approve?token=${encodeURIComponent(token)}`,
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Approved\./);

  // Tenant created
  const tRows = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM tenant WHERE name = ${TEST_FIRM}
  `;
  assert.equal(tRows.length, 1);

  // User created
  const uRows = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM "user" WHERE email = ${TEST_EMAIL}
  `;
  assert.equal(uRows.length, 1);

  // New audit row with admin_override
  const auditRows = await privilegedSql<{ reason: string; admin_override_hit: boolean }[]>`
    SELECT reason, admin_override_hit
      FROM signup_decision
     WHERE email = ${TEST_EMAIL}
     ORDER BY decided_at ASC
  `;
  assert.equal(auditRows.length, 2);
  assert.equal(auditRows[0]?.reason, 'claude_deny');
  assert.equal(auditRows[1]?.reason, 'admin_override');
  assert.equal(auditRows[1]?.admin_override_hit, true);

  // Applicant email sent
  assert.equal(rec.sent.length, 1);
  assert.equal(rec.sent[0]!.to, TEST_EMAIL);
  assert.match(rec.sent[0]!.subject, /workspace/i);
  assert.ok(rec.sent[0]!.html.includes('/v1/auth/founder-issued-signin?token='));

  await app.close();
});

test('founder-approve: idempotent — second click returns Already approved without creating extra rows', async () => {
  await cleanup();
  const rec = recorder();
  const app = buildHostedApp(rec.sender);
  const decisionId = await insertClaudeDenyRow({ email: TEST_EMAIL, firmName: TEST_FIRM });
  const token = signFounderApproveToken({
    decisionId,
    applicantEmail: TEST_EMAIL,
    secret: TEST_OVERRIDE_SECRET,
  });

  // First click — creates the tenant.
  const first = await app.inject({
    method: 'GET',
    url: `/v1/admin/signup-decisions/${decisionId}/approve?token=${encodeURIComponent(token)}`,
  });
  assert.equal(first.statusCode, 200);

  // Second click on the SAME link.
  const second = await app.inject({
    method: 'GET',
    url: `/v1/admin/signup-decisions/${decisionId}/approve?token=${encodeURIComponent(token)}`,
  });
  assert.equal(second.statusCode, 200);
  assert.match(second.body, /Already approved/);

  // Still exactly one tenant + user.
  const tRows = await sql<
    { id: string }[]
  >`SELECT id::text AS id FROM tenant WHERE name = ${TEST_FIRM}`;
  assert.equal(tRows.length, 1);

  await app.close();
});
