import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, privilegedSql } from '@cpa/db/client';
import {
  runEngagementReminderTick,
  type RecipientResolver,
  type ReminderEmailSender,
  type ReminderEmailInput,
} from './engagement-reminder-tick.js';

/**
 * Wizard Step 1 Task 04 — daily reminder/expire tick tests.
 *
 * UUID block `0e2` is reserved for this file's fixtures (mirrors the
 * `0e1` precedent in routes/engagement-letter.test.ts).
 *
 * Fixtures cover four age points so the same fixture sweep can assert
 * all three transitions + the negative-case "fresh row, do nothing":
 *
 *   FRESH (1d ago)  — no reminder, no expire
 *   AT_7D  (7d ago) — 7-day reminder queued
 *   AT_14D (14d ago) — 14-day reminder queued + consultant notified
 *   AT_30D (31d ago) — auto-expired
 *
 * The handler is invoked twice in the idempotency test; recorded emails
 * are diffed across calls to assert no duplicate sends.
 */

// ---------------------------------------------------------------------------
// Fixture identifiers (UUID block 0e2)
// ---------------------------------------------------------------------------

const TENANT = '00000000-0000-4000-8000-00000000e2a1';
const SUBJECT = '00000000-0000-4000-8000-00000000e2a2';

// Four claims (one per age category) + matching engagement_letter rows.
const CLAIM_FRESH = '00000000-0000-4000-8000-00000000e2a3';
const CLAIM_7D = '00000000-0000-4000-8000-00000000e2a4';
const CLAIM_14D = '00000000-0000-4000-8000-00000000e2a5';
const CLAIM_30D = '00000000-0000-4000-8000-00000000e2a6';
const LETTER_FRESH = '00000000-0000-4000-8000-00000000e2b3';
const LETTER_7D = '00000000-0000-4000-8000-00000000e2b4';
const LETTER_14D = '00000000-0000-4000-8000-00000000e2b5';
const LETTER_30D = '00000000-0000-4000-8000-00000000e2b6';

// Static stand-ins for the resolver outputs — kept short + readable.
const CLAIMANT_EMAIL = 'claimant@example.com';
const CONSULTANT_EMAIL = 'consultant@example.com';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface RecordedEmail extends ReminderEmailInput {
  /** Auto-incrementing send id from the fake sender. */
  id: string;
}

function makeRecordingSender(): {
  sender: ReminderEmailSender;
  sent: RecordedEmail[];
  reset: () => void;
} {
  let n = 0;
  const sent: RecordedEmail[] = [];
  const sender: ReminderEmailSender = {
    // Not `async` — the recorder is purely in-memory. Returning a
    // pre-resolved Promise keeps the interface contract without
    // tripping `require-await`.
    send(input) {
      const id = `fake-${++n}`;
      sent.push({ ...input, id });
      return Promise.resolve({ id });
    },
  };
  return {
    sender,
    sent,
    reset: () => {
      n = 0;
      sent.length = 0;
    },
  };
}

/**
 * Test resolver — returns the static fixture addresses for any letter id
 * the suite uses. Production-time resolution is exercised separately by
 * `createDefaultRecipientResolver`'s own integration path.
 */
const resolver: RecipientResolver = {
  // No real async work — keep the methods sync-returning a resolved
  // Promise so eslint's `require-await` doesn't trip while still
  // matching the interface's async contract.
  resolveClaimantEmail() {
    return Promise.resolve<string | null>(CLAIMANT_EMAIL);
  },
  resolveConsultantEmails() {
    return Promise.resolve([CONSULTANT_EMAIL]);
  },
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const cleanup = async (): Promise<void> => {
  await privilegedSql`
    DELETE FROM engagement_letter
     WHERE id IN (${LETTER_FRESH}, ${LETTER_7D}, ${LETTER_14D}, ${LETTER_30D})
  `;
  await privilegedSql`
    DELETE FROM claim
     WHERE id IN (${CLAIM_FRESH}, ${CLAIM_7D}, ${CLAIM_14D}, ${CLAIM_30D})
  `;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT}`;
  await privilegedSql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

const seedRows = async (): Promise<void> => {
  const now = Date.now();
  const ageMs = (days: number): string => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${TENANT}, 'Reminder Tick Firm', 'reminder-tick-firm', 'mixed')
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name, kind)
    VALUES (${SUBJECT}, ${TENANT}, 'Reminder Tick Claimant', 'claimant')
  `;
  // Four claims, each at the 'engagement' pipeline stage with
  // engagement_status='sent'. (subject_tenant_id, fiscal_year) is
  // UNIQUE so each claim row uses a distinct fiscal_year.
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage, engagement_status)
    VALUES (${CLAIM_FRESH}, ${TENANT}, ${SUBJECT}, 2025, 'engagement', 'sent'),
           (${CLAIM_7D},    ${TENANT}, ${SUBJECT}, 2024, 'engagement', 'sent'),
           (${CLAIM_14D},   ${TENANT}, ${SUBJECT}, 2023, 'engagement', 'sent'),
           (${CLAIM_30D},   ${TENANT}, ${SUBJECT}, 2022, 'engagement', 'sent')
  `;
  // Engagement letters at four distinct ages. The "send_token" is set
  // on the 30d row so we can assert it's nulled out on expire.
  await privilegedSql`
    INSERT INTO engagement_letter
      (id, tenant_id, claim_id, rendered_markdown, template_version, sent_to_claimant_at, send_token)
    VALUES
      (${LETTER_FRESH}, ${TENANT}, ${CLAIM_FRESH}, 'body', 'v1', ${ageMs(1)},  ${'tok-fresh'}),
      (${LETTER_7D},    ${TENANT}, ${CLAIM_7D},    'body', 'v1', ${ageMs(7)},  ${'tok-7d'}),
      (${LETTER_14D},   ${TENANT}, ${CLAIM_14D},   'body', 'v1', ${ageMs(14)}, ${'tok-14d'}),
      (${LETTER_30D},   ${TENANT}, ${CLAIM_30D},   'body', 'v1', ${ageMs(31)}, ${'tok-30d'})
  `;
};

before(async () => {
  await cleanup();
  await seedRows();
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// Re-seed before each test so order independence holds — the previous
// test's UPDATE…RETURNING stamps `reminded_*_at` etc. The most reliable
// way to get back to the canonical four-row state is a wipe + reinsert.
beforeEach(async () => {
  await privilegedSql`
    DELETE FROM engagement_letter
     WHERE id IN (${LETTER_FRESH}, ${LETTER_7D}, ${LETTER_14D}, ${LETTER_30D})
  `;
  await privilegedSql`
    UPDATE claim
       SET engagement_status = 'sent'
     WHERE id IN (${CLAIM_FRESH}, ${CLAIM_7D}, ${CLAIM_14D}, ${CLAIM_30D})
  `;
  const now = Date.now();
  const ageMs = (days: number): string => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  await privilegedSql`
    INSERT INTO engagement_letter
      (id, tenant_id, claim_id, rendered_markdown, template_version, sent_to_claimant_at, send_token)
    VALUES
      (${LETTER_FRESH}, ${TENANT}, ${CLAIM_FRESH}, 'body', 'v1', ${ageMs(1)},  ${'tok-fresh'}),
      (${LETTER_7D},    ${TENANT}, ${CLAIM_7D},    'body', 'v1', ${ageMs(7)},  ${'tok-7d'}),
      (${LETTER_14D},   ${TENANT}, ${CLAIM_14D},   'body', 'v1', ${ageMs(14)}, ${'tok-14d'}),
      (${LETTER_30D},   ${TENANT}, ${CLAIM_30D},   'body', 'v1', ${ageMs(31)}, ${'tok-30d'})
  `;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('engagement-reminder-tick: 7d row gets one claimant reminder; row stamped', async () => {
  const { sender, sent } = makeRecordingSender();
  const result = await runEngagementReminderTick(sender, resolver);

  // The 7d row must have produced exactly one reminder; the 14d row
  // gets the 14d branch (which also notifies the consultant, so that
  // adds extra sends), and the 30d row is silent (expire only).
  assert.equal(result.reminded_7d, 1, 'one row picks up the 7d branch');

  const sevenDayMail = sent.find((m) => m.subject.toLowerCase().includes('7 days'));
  assert.ok(sevenDayMail, '7-day reminder must have been queued');
  assert.equal(sevenDayMail.to, CLAIMANT_EMAIL);
  assert.match(sevenDayMail.text, /gentle reminder/i);

  const rows = await privilegedSql<{ reminded_7d_at: Date | null }[]>`
    SELECT reminded_7d_at FROM engagement_letter WHERE id = ${LETTER_7D}
  `;
  assert.ok(rows[0]?.reminded_7d_at, '7d row must be stamped');
});

test('engagement-reminder-tick: 14d row gets reminder + consultant notification', async () => {
  const { sender, sent } = makeRecordingSender();
  const result = await runEngagementReminderTick(sender, resolver);
  assert.equal(result.reminded_14d, 1, 'one row picks up the 14d branch');

  // Claimant reminder
  const claimantMail = sent.find(
    (m) => m.to === CLAIMANT_EMAIL && m.subject.toLowerCase().includes('14 days'),
  );
  assert.ok(claimantMail, '14-day claimant reminder must have been queued');

  // Consultant notification — the test resolver returns one consultant.
  const consultantMail = sent.find(
    (m) => m.to === CONSULTANT_EMAIL && m.subject.toLowerCase().includes('14 days'),
  );
  assert.ok(consultantMail, 'consultant notification must have been queued');

  const rows = await privilegedSql<{ reminded_14d_at: Date | null }[]>`
    SELECT reminded_14d_at FROM engagement_letter WHERE id = ${LETTER_14D}
  `;
  assert.ok(rows[0]?.reminded_14d_at, '14d row must be stamped');
});

test('engagement-reminder-tick: 30d row auto-expires; claim flipped; token nulled', async () => {
  const { sender } = makeRecordingSender();
  const result = await runEngagementReminderTick(sender, resolver);
  assert.equal(result.expired, 1, 'one row hits the expire branch');

  const letterRow = await privilegedSql<{ expired_at: Date | null; send_token: string | null }[]>`
    SELECT expired_at, send_token FROM engagement_letter WHERE id = ${LETTER_30D}
  `;
  assert.ok(letterRow[0]?.expired_at, 'expired_at must be set');
  assert.equal(letterRow[0]?.send_token, null, 'send_token must be invalidated');

  const claimRow = await privilegedSql<{ engagement_status: string }[]>`
    SELECT engagement_status FROM claim WHERE id = ${CLAIM_30D}
  `;
  assert.equal(claimRow[0]?.engagement_status, 'expired');
});

test('engagement-reminder-tick: fresh row (1d) does nothing', async () => {
  const { sender, sent } = makeRecordingSender();
  await runEngagementReminderTick(sender, resolver);

  // None of the recorded emails should reference the fresh row's
  // window — confirmed indirectly by checking the DB stamp is null.
  const rows = await privilegedSql<{ reminded_7d_at: Date | null; reminded_14d_at: Date | null }[]>`
    SELECT reminded_7d_at, reminded_14d_at
      FROM engagement_letter WHERE id = ${LETTER_FRESH}
  `;
  assert.equal(rows[0]?.reminded_7d_at, null);
  assert.equal(rows[0]?.reminded_14d_at, null);
  // Also: no email landed on the fresh row's claimant — the recording
  // sender captures all `to` values, and the fresh row shares the
  // CLAIMANT_EMAIL fixture, so this is a per-row negative we infer
  // from "the only 7d/14d emails relate to the 7d/14d ages".
  assert.ok(
    sent.every((m) => !m.subject.includes('1 day')),
    'no 1-day-age email exists',
  );
});

test('engagement-reminder-tick: re-running same day is a no-op (idempotency)', async () => {
  const first = makeRecordingSender();
  await runEngagementReminderTick(first.sender, resolver);
  const firstCount = first.sent.length;
  assert.ok(firstCount > 0, 'first run must have queued at least one email');

  const second = makeRecordingSender();
  const secondResult = await runEngagementReminderTick(second.sender, resolver);

  // Counters must show zero work on the second pass. The 30d expire
  // branch is naturally idempotent (claim.engagement_status has
  // already flipped, so the outer filter excludes the row); the 7d
  // and 14d branches gate on the IS NULL stamp.
  assert.equal(secondResult.reminded_7d, 0, '7d branch must not re-fire same-day');
  assert.equal(secondResult.reminded_14d, 0, '14d branch must not re-fire same-day');
  assert.equal(secondResult.expired, 0, 'expire branch must not re-fire same-day');
  assert.equal(second.sent.length, 0, 'no emails on the second run');
});
