import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canGeneratePr,
  formatRelativeTime,
  ISSUE_SUMMARY_MAX,
  ISSUE_SUMMARY_MIN,
  ISSUE_SUMMARY_PREVIEW_LIMIT,
  MERGE_SHA_BADGE_LENGTH,
  parseSourcePayload,
  prTrackingDisplayState,
  STATUS_BADGE_BASE,
  statusBadgeClasses,
  SUGGESTION_ID_BADGE_LENGTH,
  truncateIssueSummary,
  truncateMergeSha,
  truncateSuggestionId,
  validateIssueSummary,
} from './helpers.js';
import { SUGGESTION_STATUSES, type PromptSuggestionPr } from './types.js';

/**
 * P7 Theme B Task B.7 — pure-helper tests for the /suggestions surface.
 *
 * apps/web's test runner is `tsx --test` (Node, no jsdom). We test only
 * the pure helpers; DOM behaviour (modal mount, polling cycle, click
 * navigation) is exercised end-to-end via Playwright in a follow-up
 * swimlane. Same separation as `multi-cycle-timeline.test.tsx`.
 */

// =============================================================================
// truncateIssueSummary
// =============================================================================

test('truncateIssueSummary: short text passes through unchanged', () => {
  const text = 'Hypothesis section misses the cure rate claim';
  assert.equal(truncateIssueSummary(text), text);
});

test('truncateIssueSummary: text over the limit gets truncated + ellipsis', () => {
  const text = 'A'.repeat(ISSUE_SUMMARY_PREVIEW_LIMIT + 50);
  const out = truncateIssueSummary(text);
  assert.equal(out.length, ISSUE_SUMMARY_PREVIEW_LIMIT + 1);
  assert.ok(out.endsWith('…'));
});

test('truncateIssueSummary: text exactly at the limit is not truncated', () => {
  const text = 'X'.repeat(ISSUE_SUMMARY_PREVIEW_LIMIT);
  assert.equal(truncateIssueSummary(text), text);
  assert.ok(!truncateIssueSummary(text).endsWith('…'));
});

test('truncateIssueSummary: respects custom limit override', () => {
  assert.equal(truncateIssueSummary('hello world', 5), 'hello…');
});

// =============================================================================
// truncateSuggestionId / truncateMergeSha
// =============================================================================

test('truncateSuggestionId: returns first 8 chars of the id', () => {
  const id = '00000000-0000-4000-8000-aaaaaaaaaaaa';
  assert.equal(truncateSuggestionId(id), id.slice(0, SUGGESTION_ID_BADGE_LENGTH));
  assert.equal(truncateSuggestionId(id).length, SUGGESTION_ID_BADGE_LENGTH);
});

test('truncateSuggestionId: short ids pass through', () => {
  assert.equal(truncateSuggestionId('abc'), 'abc');
});

test('truncateMergeSha: returns first 8 chars of the sha', () => {
  const sha = 'a'.repeat(40);
  assert.equal(truncateMergeSha(sha).length, MERGE_SHA_BADGE_LENGTH);
  assert.equal(truncateMergeSha(sha), 'a'.repeat(MERGE_SHA_BADGE_LENGTH));
});

// =============================================================================
// formatRelativeTime — deterministic English output
// =============================================================================

const FIXED_NOW = Date.UTC(2026, 4, 4, 12, 0, 0); // 2026-05-04 12:00 UTC

function isoMinusMs(ms: number): string {
  return new Date(FIXED_NOW - ms).toISOString();
}

test('formatRelativeTime: < 30s → "just now"', () => {
  assert.equal(formatRelativeTime(isoMinusMs(15_000), FIXED_NOW), 'just now');
});

test('formatRelativeTime: 5 min → "5 min ago"', () => {
  assert.equal(formatRelativeTime(isoMinusMs(5 * 60_000), FIXED_NOW), '5 min ago');
});

test('formatRelativeTime: 3 hr → "3 hr ago"', () => {
  assert.equal(formatRelativeTime(isoMinusMs(3 * 60 * 60_000), FIXED_NOW), '3 hr ago');
});

test('formatRelativeTime: 2 d → "2 d ago"', () => {
  assert.equal(formatRelativeTime(isoMinusMs(2 * 24 * 60 * 60_000), FIXED_NOW), '2 d ago');
});

test('formatRelativeTime: 3 w → "3 w ago"', () => {
  // 3 weeks (21 days) is comfortably under the 30-day month threshold,
  // so the bucket is "weeks". 6 weeks (42 days) crosses MONTH_MS first
  // and reads as "1 mo ago" — that's fine for the bucket cascade we
  // want; we just pick a clean week-bucket sample for the test.
  assert.equal(formatRelativeTime(isoMinusMs(3 * 7 * 24 * 60 * 60_000), FIXED_NOW), '3 w ago');
});

test('formatRelativeTime: 3 mo → "3 mo ago"', () => {
  assert.equal(formatRelativeTime(isoMinusMs(3 * 30 * 24 * 60 * 60_000), FIXED_NOW), '3 mo ago');
});

test('formatRelativeTime: 1 y → "1 y ago"', () => {
  assert.equal(formatRelativeTime(isoMinusMs(1 * 365 * 24 * 60 * 60_000), FIXED_NOW), '1 y ago');
});

test('formatRelativeTime: invalid iso → "unknown"', () => {
  assert.equal(formatRelativeTime('not a date', FIXED_NOW), 'unknown');
  assert.equal(formatRelativeTime('', FIXED_NOW), 'unknown');
});

test('formatRelativeTime: future timestamp → "just now"', () => {
  // Clock skew defence — if the API ever returns a flagged_at in the
  // future relative to the client clock, we don't render "-3 min ago".
  assert.equal(
    formatRelativeTime(new Date(FIXED_NOW + 60_000).toISOString(), FIXED_NOW),
    'just now',
  );
});

// =============================================================================
// statusBadgeClasses — design-token mapping
// =============================================================================

test('statusBadgeClasses: open uses brand-accent-subtle', () => {
  const c = statusBadgeClasses('open');
  assert.match(c, /brand-accent-subtle/);
});

test('statusBadgeClasses: triaged uses slate', () => {
  const c = statusBadgeClasses('triaged');
  assert.match(c, /slate-100/);
});

test('statusBadgeClasses: pr_drafted uses brand-accent', () => {
  const c = statusBadgeClasses('pr_drafted');
  assert.match(c, /brand-accent/);
});

test('statusBadgeClasses: pr_merged uses emerald', () => {
  const c = statusBadgeClasses('pr_merged');
  assert.match(c, /emerald-100/);
});

test('statusBadgeClasses: dismissed uses muted', () => {
  const c = statusBadgeClasses('dismissed');
  assert.match(c, /muted/);
});

test('statusBadgeClasses: covers every status in SUGGESTION_STATUSES', () => {
  // Drift guard — adding a new status to the union without a colour
  // mapping fails this test instead of silently rendering as muted.
  for (const status of SUGGESTION_STATUSES) {
    const c = statusBadgeClasses(status);
    assert.ok(c.length > 0, `no class string for ${status}`);
  }
});

test('STATUS_BADGE_BASE: includes inline-flex + rounded-full', () => {
  assert.match(STATUS_BADGE_BASE, /inline-flex/);
  assert.match(STATUS_BADGE_BASE, /rounded-full/);
});

// =============================================================================
// prTrackingDisplayState — derives widget state from (status, pr)
// =============================================================================

const CREATED_AT = '2026-05-04T11:30:00.000Z';
const SUGGESTION_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_ID = '00000000-0000-4000-8000-000000000099';

const PR_OPEN: PromptSuggestionPr = {
  id: '00000000-0000-4000-8000-000000000010',
  tenant_id: TENANT_ID,
  suggestion_id: SUGGESTION_ID,
  github_pr_number: 42,
  github_pr_url: 'https://github.com/example/repo/pull/42',
  branch_name: 'p7-suggestion-fix-42',
  changed_files: ['packages/agents/src/foo.ts'],
  created_at: CREATED_AT,
  merged_at: null,
  merge_commit_sha: null,
};

const PR_MERGED: PromptSuggestionPr = {
  ...PR_OPEN,
  merged_at: '2026-05-04T11:45:00.000Z',
  merge_commit_sha: 'b'.repeat(40),
};

test('prTrackingDisplayState: open + no pr → no_pr_yet, polling on', () => {
  const got = prTrackingDisplayState('open', null);
  assert.equal(got.kind, 'no_pr_yet');
  assert.equal(got.shouldPoll, true);
  assert.equal(got.isInFlight, false);
});

test('prTrackingDisplayState: triaged + no pr → no_pr_yet, polling on', () => {
  const got = prTrackingDisplayState('triaged', null);
  assert.equal(got.kind, 'no_pr_yet');
  assert.equal(got.shouldPoll, true);
});

test('prTrackingDisplayState: pr_drafted + open pr → drafted, polling + in-flight', () => {
  const got = prTrackingDisplayState('pr_drafted', PR_OPEN);
  assert.equal(got.kind, 'drafted');
  assert.equal(got.shouldPoll, true);
  assert.equal(got.isInFlight, true);
});

test('prTrackingDisplayState: pr_drafted + null pr (race) → unknown, in-flight', () => {
  const got = prTrackingDisplayState('pr_drafted', null);
  assert.equal(got.kind, 'unknown');
  assert.equal(got.shouldPoll, true);
  assert.equal(got.isInFlight, true);
});

test('prTrackingDisplayState: pr_drafted + merged pr (webhook lag) → merged, polling on', () => {
  // The pr row says merged but suggestion.status hasn't caught up.
  // We render as merged but keep polling so the next fetch flips
  // suggestion.status and the poll stops.
  const got = prTrackingDisplayState('pr_drafted', PR_MERGED);
  assert.equal(got.kind, 'merged');
  assert.equal(got.shouldPoll, true);
  assert.equal(got.isInFlight, true);
});

test('prTrackingDisplayState: pr_merged → merged, polling off', () => {
  const got = prTrackingDisplayState('pr_merged', PR_MERGED);
  assert.equal(got.kind, 'merged');
  assert.equal(got.shouldPoll, false);
  assert.equal(got.isInFlight, false);
});

test('prTrackingDisplayState: dismissed → dismissed, polling off', () => {
  const got = prTrackingDisplayState('dismissed', null);
  assert.equal(got.kind, 'dismissed');
  assert.equal(got.shouldPoll, false);
  assert.equal(got.isInFlight, false);
});

test('prTrackingDisplayState: every status produces a defined display kind', () => {
  for (const status of SUGGESTION_STATUSES) {
    const withPr = prTrackingDisplayState(status, PR_OPEN);
    const withoutPr = prTrackingDisplayState(status, null);
    assert.ok(withPr.kind, `display kind must be defined for status=${status} with pr`);
    assert.ok(withoutPr.kind, `display kind must be defined for status=${status} without pr`);
    // Polling must be off iff the status is terminal.
    const isTerminal = status === 'pr_merged' || status === 'dismissed';
    assert.equal(
      withPr.shouldPoll,
      !isTerminal,
      `polling for ${status} (with pr) should match terminal=${isTerminal}`,
    );
  }
});

// =============================================================================
// validateIssueSummary
// =============================================================================

test('validateIssueSummary: empty → invalid', () => {
  const got = validateIssueSummary('');
  assert.equal(got.valid, false);
  assert.match(got.error ?? '', /at least/);
});

test('validateIssueSummary: too short → invalid', () => {
  assert.equal(validateIssueSummary('short').valid, false);
});

test('validateIssueSummary: at min length → valid', () => {
  const text = 'X'.repeat(ISSUE_SUMMARY_MIN);
  assert.equal(validateIssueSummary(text).valid, true);
});

test('validateIssueSummary: at max length → valid', () => {
  const text = 'X'.repeat(ISSUE_SUMMARY_MAX);
  assert.equal(validateIssueSummary(text).valid, true);
});

test('validateIssueSummary: too long → invalid', () => {
  const text = 'X'.repeat(ISSUE_SUMMARY_MAX + 1);
  const got = validateIssueSummary(text);
  assert.equal(got.valid, false);
  assert.match(got.error ?? '', /at most/);
});

test('validateIssueSummary: trims before length check', () => {
  // 10-char content + 5 spaces around → trims to 10 → valid
  const text = '     ' + 'X'.repeat(10) + '     ';
  assert.equal(validateIssueSummary(text).valid, true);
  // 5-char content + lots of whitespace → trims to 5 → invalid
  assert.equal(validateIssueSummary('     short     ').valid, false);
});

// =============================================================================
// parseSourcePayload
// =============================================================================

test('parseSourcePayload: empty → empty object', () => {
  assert.deepEqual(parseSourcePayload(''), {});
  assert.deepEqual(parseSourcePayload('   '), {});
});

test('parseSourcePayload: valid object → parsed object', () => {
  assert.deepEqual(parseSourcePayload('{"reason":"x"}'), { reason: 'x' });
});

test('parseSourcePayload: nested object → parsed object', () => {
  const parsed = parseSourcePayload('{"event_id":"abc","detail":{"k":1}}');
  assert.deepEqual(parsed, { event_id: 'abc', detail: { k: 1 } });
});

test('parseSourcePayload: array → throws', () => {
  assert.throws(() => parseSourcePayload('[1,2,3]'), /JSON object/);
});

test('parseSourcePayload: scalar → throws', () => {
  assert.throws(() => parseSourcePayload('"just a string"'), /JSON object/);
  assert.throws(() => parseSourcePayload('42'), /JSON object/);
  assert.throws(() => parseSourcePayload('null'), /JSON object/);
});

test('parseSourcePayload: malformed JSON → throws with parse error', () => {
  assert.throws(() => parseSourcePayload('{not valid'), /must be valid JSON/);
});

// =============================================================================
// canGeneratePr — Generate-PR button visibility gate.
//
// The button must be visible only when status === 'triaged'. Drift between
// the UI gate and the API state-machine in `prompt-suggestions.ts` would
// either:
//   (a) show a button that 409s on click (bad UX), or
//   (b) hide a button when the API would accept the request (workflow gap —
//       the very Concern this fix closes).
// =============================================================================

test('canGeneratePr: returns true only for triaged', () => {
  assert.equal(canGeneratePr('triaged'), true);
});

test('canGeneratePr: hides on every non-triaged status', () => {
  // Exhaustively check every status in the union except `triaged`.
  // If a future status is added to SUGGESTION_STATUSES, this test fails
  // until the author decides whether the button should appear there.
  const nonTriaged = SUGGESTION_STATUSES.filter((s) => s !== 'triaged');
  for (const status of nonTriaged) {
    assert.equal(
      canGeneratePr(status),
      false,
      `Generate-PR button must be hidden for status=${status}`,
    );
  }
});

test('canGeneratePr: matches API state-machine preflight (drift guard)', () => {
  // The API's POST /v1/suggestions/:id/generate-pr returns 409 unless
  // suggestion.status === 'triaged' (see prompt-suggestions.ts ~line 789).
  // The set of statuses the UI shows the button for must equal the set
  // the API accepts.
  const uiAccepts = SUGGESTION_STATUSES.filter(canGeneratePr);
  assert.deepEqual(uiAccepts, ['triaged']);
});
