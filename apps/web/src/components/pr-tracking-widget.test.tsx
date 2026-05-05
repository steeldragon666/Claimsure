import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prTrackingDisplayState,
  truncateMergeSha,
  MERGE_SHA_BADGE_LENGTH,
} from '@/app/suggestions/_lib/helpers.js';
import {
  TERMINAL_SUGGESTION_STATUSES,
  type PromptSuggestionPr,
  type SuggestionStatus,
} from '@/app/suggestions/_lib/types.js';

/**
 * P7 Theme B Task B.7 — pure-helper tests for <PrTrackingWidget>.
 *
 * The widget itself is JSX + TanStack Query; the polling cycle and DOM
 * mount are exercised via Playwright in a follow-up swimlane (apps/web
 * runs `tsx --test`, no jsdom). Here we test the underlying state
 * derivation and the formatting helpers the widget relies on, plus
 * the polling-decision invariant: every non-terminal status must keep
 * polling, every terminal status must stop.
 */

const SUGGESTION_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_ID = '00000000-0000-4000-8000-000000000099';
const FORTY_CHAR_SHA = 'cd41d42a1b2c3d4e5f6789012345678901234567'; // 40 chars

const PR_OPEN: PromptSuggestionPr = {
  id: '00000000-0000-4000-8000-000000000010',
  tenant_id: TENANT_ID,
  suggestion_id: SUGGESTION_ID,
  github_pr_number: 42,
  github_pr_url: 'https://github.com/example/repo/pull/42',
  branch_name: 'p7-suggestion-fix-42',
  changed_files: ['packages/agents/src/foo.ts'],
  created_at: '2026-05-04T11:30:00.000Z',
  merged_at: null,
  merge_commit_sha: null,
};

const PR_MERGED: PromptSuggestionPr = {
  ...PR_OPEN,
  merged_at: '2026-05-04T11:45:00.000Z',
  merge_commit_sha: FORTY_CHAR_SHA,
};

// =============================================================================
// Polling invariant — the load-bearing test for the widget. If polling
// stops on a non-terminal status, a real PR merge could be silently
// invisible to the reviewer; if polling continues on a terminal status,
// we burn API requests indefinitely on resolved rows.
// =============================================================================

test('PrTrackingWidget polling: non-terminal statuses must keep polling', () => {
  const nonTerminal: SuggestionStatus[] = ['open', 'triaged', 'pr_drafted'];
  for (const status of nonTerminal) {
    const got = prTrackingDisplayState(status, status === 'pr_drafted' ? PR_OPEN : null);
    assert.equal(got.shouldPoll, true, `polling should be on for non-terminal status=${status}`);
  }
});

test('PrTrackingWidget polling: terminal statuses must stop polling', () => {
  for (const status of TERMINAL_SUGGESTION_STATUSES) {
    const got = prTrackingDisplayState(status, PR_MERGED);
    assert.equal(got.shouldPoll, false, `polling should be off for terminal status=${status}`);
  }
});

test('PrTrackingWidget polling: TERMINAL_SUGGESTION_STATUSES is correct', () => {
  // Defensive — pin the terminal set against the spec.
  assert.ok(TERMINAL_SUGGESTION_STATUSES.has('pr_merged'));
  assert.ok(TERMINAL_SUGGESTION_STATUSES.has('dismissed'));
  assert.ok(!TERMINAL_SUGGESTION_STATUSES.has('open'));
  assert.ok(!TERMINAL_SUGGESTION_STATUSES.has('triaged'));
  assert.ok(!TERMINAL_SUGGESTION_STATUSES.has('pr_drafted'));
});

// =============================================================================
// In-flight (verify-pulse) invariant — drafted is the only "we're waiting
// on GitHub" state where the chip pulses; merged + dismissed are terminal
// (animation off) and `no_pr_yet` is the calm wait state (no animation).
// =============================================================================

test('PrTrackingWidget pulse: drafted is in-flight', () => {
  assert.equal(prTrackingDisplayState('pr_drafted', PR_OPEN).isInFlight, true);
});

test('PrTrackingWidget pulse: merged is NOT in-flight (terminal)', () => {
  assert.equal(prTrackingDisplayState('pr_merged', PR_MERGED).isInFlight, false);
});

test('PrTrackingWidget pulse: dismissed is NOT in-flight', () => {
  assert.equal(prTrackingDisplayState('dismissed', null).isInFlight, false);
});

test('PrTrackingWidget pulse: open / triaged (no PR yet) are NOT in-flight', () => {
  assert.equal(prTrackingDisplayState('open', null).isInFlight, false);
  assert.equal(prTrackingDisplayState('triaged', null).isInFlight, false);
});

// =============================================================================
// Sha truncation — the click-to-expand badge displays 8 chars by default
// and the full 40-char sha when expanded. The pure helper guarantees the
// shape; the toggle is rendered inline by the widget.
// =============================================================================

test('PrTrackingWidget sha: 40-char sha truncates to 8 chars', () => {
  assert.equal(truncateMergeSha(FORTY_CHAR_SHA).length, MERGE_SHA_BADGE_LENGTH);
  assert.equal(truncateMergeSha(FORTY_CHAR_SHA), FORTY_CHAR_SHA.slice(0, 8));
});

test('PrTrackingWidget sha: short sha (test fixture) passes through', () => {
  assert.equal(truncateMergeSha('abc123'), 'abc123');
});

// =============================================================================
// Display kind invariants
// =============================================================================

test('PrTrackingWidget kind: pr_drafted with merged_at populated → merged', () => {
  // Webhook lag scenario: pr.merged_at is true but suggestion.status
  // hasn't caught up yet. Render as merged but keep polling (the next
  // fetch flips suggestion.status → pr_merged and the poll terminates).
  const got = prTrackingDisplayState('pr_drafted', PR_MERGED);
  assert.equal(got.kind, 'merged');
  assert.equal(got.shouldPoll, true);
});

test('PrTrackingWidget kind: pr_drafted with no pr row → unknown (race)', () => {
  // Defensive: suggestion claims pr_drafted but no pr row visible yet.
  // Continue polling; render the "syncing" state.
  const got = prTrackingDisplayState('pr_drafted', null);
  assert.equal(got.kind, 'unknown');
  assert.equal(got.shouldPoll, true);
});

test('PrTrackingWidget kind: open/triaged → no_pr_yet', () => {
  assert.equal(prTrackingDisplayState('open', null).kind, 'no_pr_yet');
  assert.equal(prTrackingDisplayState('triaged', null).kind, 'no_pr_yet');
});
