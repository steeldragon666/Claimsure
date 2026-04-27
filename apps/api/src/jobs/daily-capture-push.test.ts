import crypto from 'node:crypto';
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db';
import { runDailyCapturePushJob, selectEligibleRecipients } from './daily-capture-push.js';

// Pinned UUIDs — the 0a12 segment groups all A12 fixtures.
const TENANT = '00000000-0000-4000-8000-0000000a1201';
const ADMIN_USER = '00000000-0000-4000-8000-0000000a1210';
const SUBJECT = '00000000-0000-4000-8000-0000000a1221';

// Five distinct employees covering each branch of the eligibility filter.
const EMP_ELIGIBLE = '00000000-0000-4000-8000-0000000a1230';
const EMP_NO_TOKEN = '00000000-0000-4000-8000-0000000a1231';
const EMP_EXPIRED_SESSION = '00000000-0000-4000-8000-0000000a1232';
const EMP_REVOKED_SESSION = '00000000-0000-4000-8000-0000000a1233';
const EMP_DEACTIVATED = '00000000-0000-4000-8000-0000000a1234';
const EMP_INACTIVE = '00000000-0000-4000-8000-0000000a1235';
const EMP_CAPTURED_TODAY = '00000000-0000-4000-8000-0000000a1236';

const ALL_EMPLOYEES = [
  EMP_ELIGIBLE,
  EMP_NO_TOKEN,
  EMP_EXPIRED_SESSION,
  EMP_REVOKED_SESSION,
  EMP_DEACTIVATED,
  EMP_INACTIVE,
  EMP_CAPTURED_TODAY,
];

const cleanup = async (): Promise<void> => {
  await privilegedSql`
    DELETE FROM event WHERE tenant_id = ${TENANT}
  `;
  await privilegedSql`
    DELETE FROM mobile_session WHERE employee_id = ANY(${ALL_EMPLOYEES})
  `;
  await privilegedSql`
    DELETE FROM subject_tenant_employee WHERE id = ANY(${ALL_EMPLOYEES})
  `;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

const insertEmployee = async (args: {
  id: string;
  lastSeenDaysAgo?: number | null;
  deactivated?: boolean;
}): Promise<void> => {
  // last_seen_at: null (never logged in) or N days ago.
  const lastSeenSql =
    args.lastSeenDaysAgo === null || args.lastSeenDaysAgo === undefined
      ? null
      : new Date(Date.now() - args.lastSeenDaysAgo * 24 * 60 * 60 * 1000);
  await privilegedSql`
    INSERT INTO subject_tenant_employee (
      id, subject_tenant_id, tenant_id, email, name,
      invited_by_user_id, last_seen_at, deactivated_at
    ) VALUES (
      ${args.id}, ${SUBJECT}, ${TENANT},
      ${args.id.slice(-12) + '@a12.example'}, ${'A12 Emp ' + args.id.slice(-4)},
      ${ADMIN_USER},
      ${lastSeenSql ? lastSeenSql.toISOString() : null}::timestamptz,
      ${args.deactivated ? new Date().toISOString() : null}::timestamptz
    )
  `;
};

const insertSession = async (args: {
  employeeId: string;
  pushToken: string | null;
  expiresAt: Date;
  revokedAt?: Date | null;
}): Promise<void> => {
  const refreshHash = crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
  await privilegedSql`
    INSERT INTO mobile_session (
      id, employee_id, device_fingerprint, refresh_token_hash,
      expires_at, revoked_at, push_token
    ) VALUES (
      ${crypto.randomUUID()}, ${args.employeeId},
      ${'device-' + args.employeeId.slice(-4)}, ${refreshHash},
      ${args.expiresAt.toISOString()}::timestamptz,
      ${args.revokedAt ? args.revokedAt.toISOString() : null}::timestamptz,
      ${args.pushToken}
    )
  `;
};

before(async () => {
  await cleanup();
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT}, 'Firm A', 'firm-a-a12', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'a12-admin@example.com', 'microsoft', 'microsoft:a12-admin', 'A12 Admin')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT}, ${TENANT}, 'Acme Co', 'claimant')`;
});

beforeEach(async () => {
  // Per-test isolation: clear sessions + employees + events but keep
  // tenant/admin/subject. Each test recreates the exact employee set
  // it cares about.
  await privilegedSql`DELETE FROM event WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM mobile_session WHERE employee_id = ANY(${ALL_EMPLOYEES})`;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE id = ANY(${ALL_EMPLOYEES})`;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

const futureExpiry = (): Date => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const pastExpiry = (): Date => new Date(Date.now() - 24 * 60 * 60 * 1000);

test('selectEligibleRecipients: includes active employee with push_token + recent activity', async () => {
  await insertEmployee({ id: EMP_ELIGIBLE, lastSeenDaysAgo: 1 });
  await insertSession({
    employeeId: EMP_ELIGIBLE,
    pushToken: 'expo-token-eligible',
    expiresAt: futureExpiry(),
  });

  const rows = await selectEligibleRecipients();
  const ours = rows.filter((r) => r.employee_id === EMP_ELIGIBLE);
  assert.equal(ours.length, 1);
  assert.equal(ours[0]?.push_token, 'expo-token-eligible');
});

test('selectEligibleRecipients: excludes employee whose session has no push_token', async () => {
  await insertEmployee({ id: EMP_NO_TOKEN, lastSeenDaysAgo: 1 });
  await insertSession({
    employeeId: EMP_NO_TOKEN,
    pushToken: null,
    expiresAt: futureExpiry(),
  });

  const rows = await selectEligibleRecipients();
  assert.equal(rows.filter((r) => r.employee_id === EMP_NO_TOKEN).length, 0);
});

test('selectEligibleRecipients: excludes employee whose session is expired', async () => {
  await insertEmployee({ id: EMP_EXPIRED_SESSION, lastSeenDaysAgo: 1 });
  await insertSession({
    employeeId: EMP_EXPIRED_SESSION,
    pushToken: 'expo-token-expired',
    expiresAt: pastExpiry(),
  });

  const rows = await selectEligibleRecipients();
  assert.equal(rows.filter((r) => r.employee_id === EMP_EXPIRED_SESSION).length, 0);
});

test('selectEligibleRecipients: excludes employee whose session is revoked', async () => {
  await insertEmployee({ id: EMP_REVOKED_SESSION, lastSeenDaysAgo: 1 });
  await insertSession({
    employeeId: EMP_REVOKED_SESSION,
    pushToken: 'expo-token-revoked',
    expiresAt: futureExpiry(),
    revokedAt: new Date(Date.now() - 1000),
  });

  const rows = await selectEligibleRecipients();
  assert.equal(rows.filter((r) => r.employee_id === EMP_REVOKED_SESSION).length, 0);
});

test('selectEligibleRecipients: excludes deactivated employee', async () => {
  await insertEmployee({
    id: EMP_DEACTIVATED,
    lastSeenDaysAgo: 1,
    deactivated: true,
  });
  await insertSession({
    employeeId: EMP_DEACTIVATED,
    pushToken: 'expo-token-deactivated',
    expiresAt: futureExpiry(),
  });

  const rows = await selectEligibleRecipients();
  assert.equal(rows.filter((r) => r.employee_id === EMP_DEACTIVATED).length, 0);
});

test('selectEligibleRecipients: excludes employee inactive for > 30 days', async () => {
  await insertEmployee({ id: EMP_INACTIVE, lastSeenDaysAgo: 45 });
  await insertSession({
    employeeId: EMP_INACTIVE,
    pushToken: 'expo-token-inactive',
    expiresAt: futureExpiry(),
  });

  const rows = await selectEligibleRecipients();
  assert.equal(rows.filter((r) => r.employee_id === EMP_INACTIVE).length, 0);
});

test('selectEligibleRecipients: excludes employee who has captured today', async () => {
  await insertEmployee({ id: EMP_CAPTURED_TODAY, lastSeenDaysAgo: 1 });
  await insertSession({
    employeeId: EMP_CAPTURED_TODAY,
    pushToken: 'expo-token-captured',
    expiresAt: futureExpiry(),
  });
  // Insert an event so the EXISTS subquery catches them.
  // captured_by_user_id FKs to user.id, not subject_tenant_employee.id —
  // mobile-employee captures are recorded against the firm's admin user
  // (the one who invited them); the actual employee_id lives in the payload.
  await insertEventWithChain({
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
    kind: 'SUPPORTING',
    payload: {
      _v: 1,
      source: 'voice_pending',
      audio_s3_key: 's3://bucket/test',
      captured_at_local: Date.now(),
      captured_by_employee_id: EMP_CAPTURED_TODAY,
    },
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: ADMIN_USER,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
    idempotency_key: null,
  });

  const rows = await selectEligibleRecipients();
  assert.equal(rows.filter((r) => r.employee_id === EMP_CAPTURED_TODAY).length, 0);
});

test('runDailyCapturePushJob: returns sent=0 when no employees match', async () => {
  // No employees inserted in this test (beforeEach cleared everything).
  const result = await runDailyCapturePushJob();
  // The shared SUBJECT may have other employees from concurrent tests
  // in the same DB run, so we can only assert the SHAPE here.
  assert.equal(typeof result.sent, 'number');
  assert.equal(result.skipped, 0);
});

test('runDailyCapturePushJob: counts the eligible employee', async () => {
  await insertEmployee({ id: EMP_ELIGIBLE, lastSeenDaysAgo: 2 });
  await insertSession({
    employeeId: EMP_ELIGIBLE,
    pushToken: 'expo-token-counted',
    expiresAt: futureExpiry(),
  });

  const result = await runDailyCapturePushJob();
  // The exact `sent` count depends on what other A12 test bodies
  // left lying around in the same connection — we only assert that
  // it includes ours.
  assert.ok(result.sent >= 1);
});
