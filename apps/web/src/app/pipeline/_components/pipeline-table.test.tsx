import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Claim, ClaimStage } from '@cpa/schemas';
import { applySorting, DEFAULT_SORT, parseSort } from './url-params.js';
import { nextSelection, toggleAllSelection } from '../_lib/selection.js';
import { stageAtOffset } from './pipeline-bulk-toolbar.js';
import { runStageMutationsBatch } from '../_lib/use-pipeline-claims.js';
import { daysInStage } from '../_lib/format.js';

/**
 * C3 — pipeline table view. Pure-helper test pattern (same as kanban):
 * the workspace has no jsdom, so component-level rendering tests are
 * deferred to Playwright (Swimlane A's A10 spec). What we exercise here:
 *
 *   - parseSort (URL → typed Sort or null)
 *   - applySorting (deterministic sort by each column + direction)
 *   - nextSelection / toggleAllSelection (header-checkbox + shift-click)
 *   - stageAtOffset (bulk Advance/Revert per-card target derivation)
 *   - runStageMutationsBatch (allSettled + toast — moved here from kanban)
 *
 * Manual-QA scenarios that need a DOM:
 *   - Clicking a column header toggles dir asc↔desc and persists URL.
 *   - Clicking a row navigates; cmd-click toggles select; shift-click ranges.
 *   - Header checkbox indeterminate state reflects partial selection.
 *   - "0 claims" → renders empty-state copy not the table chrome.
 *   - View toggle preserves selection across kanban↔table.
 *
 * These are tracked by C3's e2e plan (deferred until Swimlane A's A2 + A10).
 */

function makeClaim(args: {
  id: string;
  stage: ClaimStage;
  fy?: number;
  subject?: string;
  updatedAt?: string;
}): Claim {
  return {
    id: args.id,
    tenant_id: '00000000-0000-0000-0000-000000000001',
    subject_tenant_id: args.subject ?? '00000000-0000-0000-0000-0000000000aa',
    fiscal_year: args.fy ?? 2026,
    stage: args.stage,
    delivery_kind: null,
    ausindustry_reference: null,
    submitted_at: null,
    submitted_by_user_id: null,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: args.updatedAt ?? '2026-04-01T00:00:00.000Z',
    is_wizard_claim: false,
  };
}

// --- parseSort -----------------------------------------------------------

test('parseSort: valid column + asc returns typed sort', () => {
  assert.deepEqual(parseSort('claimant', 'asc'), { column: 'claimant', dir: 'asc' });
});

test('parseSort: valid column + desc returns typed sort', () => {
  assert.deepEqual(parseSort('last_updated', 'desc'), { column: 'last_updated', dir: 'desc' });
});

test('parseSort: missing column returns null', () => {
  assert.equal(parseSort(null, 'asc'), null);
});

test('parseSort: missing dir returns null', () => {
  assert.equal(parseSort('fy', null), null);
});

test('parseSort: invalid column returns null', () => {
  assert.equal(parseSort('foo', 'asc'), null);
});

test('parseSort: invalid dir returns null', () => {
  assert.equal(parseSort('fy', 'foo'), null);
});

test('parseSort: caller can fall back to DEFAULT_SORT', () => {
  // The page applies `parseSort(...) ?? DEFAULT_SORT` so this asserts the
  // shape the table receives when the URL is empty.
  const out = parseSort(null, null) ?? DEFAULT_SORT;
  assert.deepEqual(out, { column: 'last_updated', dir: 'desc' });
});

// --- applySorting --------------------------------------------------------

test('applySorting: by fy ascending', () => {
  const claims = [
    makeClaim({ id: 'a', stage: 'engagement', fy: 2026 }),
    makeClaim({ id: 'b', stage: 'engagement', fy: 2024 }),
    makeClaim({ id: 'c', stage: 'engagement', fy: 2025 }),
  ];
  const out = applySorting(claims, { column: 'fy', dir: 'asc' });
  assert.deepEqual(
    out.map((c) => c.id),
    ['b', 'c', 'a'],
  );
});

test('applySorting: by fy descending', () => {
  const claims = [
    makeClaim({ id: 'a', stage: 'engagement', fy: 2026 }),
    makeClaim({ id: 'b', stage: 'engagement', fy: 2024 }),
    makeClaim({ id: 'c', stage: 'engagement', fy: 2025 }),
  ];
  const out = applySorting(claims, { column: 'fy', dir: 'desc' });
  assert.deepEqual(
    out.map((c) => c.id),
    ['a', 'c', 'b'],
  );
});

test('applySorting: by stage uses canonical stage order, not alphabetical', () => {
  // Alphabetical would put 'audit_defence' first; canonical puts it last.
  const claims = [
    makeClaim({ id: 'rev', stage: 'review' }),
    makeClaim({ id: 'aud', stage: 'audit_defence' }),
    makeClaim({ id: 'eng', stage: 'engagement' }),
  ];
  const out = applySorting(claims, { column: 'stage', dir: 'asc' });
  assert.deepEqual(
    out.map((c) => c.id),
    ['eng', 'rev', 'aud'],
  );
});

test('applySorting: by claimant uses subjectTenantNames lookup, falls back to id', () => {
  const claims = [
    makeClaim({ id: 'a', stage: 'engagement', subject: 'subj-1' }),
    makeClaim({ id: 'b', stage: 'engagement', subject: 'subj-2' }),
    makeClaim({ id: 'c', stage: 'engagement', subject: 'subj-3' }),
  ];
  const out = applySorting(
    claims,
    { column: 'claimant', dir: 'asc' },
    {
      subjectTenantNames: { 'subj-1': 'Zenith Co', 'subj-2': 'Acme', 'subj-3': 'Mango Ltd' },
    },
  );
  assert.deepEqual(
    out.map((c) => c.id),
    ['b', 'c', 'a'], // Acme, Mango, Zenith
  );
});

test('applySorting: by last_updated descending (newest first — default)', () => {
  const claims = [
    makeClaim({ id: 'old', stage: 'engagement', updatedAt: '2026-01-01T00:00:00.000Z' }),
    makeClaim({ id: 'new', stage: 'engagement', updatedAt: '2026-04-29T12:00:00.000Z' }),
    makeClaim({ id: 'mid', stage: 'engagement', updatedAt: '2026-03-15T00:00:00.000Z' }),
  ];
  const out = applySorting(claims, { column: 'last_updated', dir: 'desc' });
  assert.deepEqual(
    out.map((c) => c.id),
    ['new', 'mid', 'old'],
  );
});

test('applySorting: by days_in_stage uses pinned now()', () => {
  const now = new Date('2026-04-29T12:00:00.000Z');
  const claims = [
    // 5 days
    makeClaim({ id: 'a', stage: 'engagement', updatedAt: '2026-04-24T12:00:00.000Z' }),
    // 1 day
    makeClaim({ id: 'b', stage: 'engagement', updatedAt: '2026-04-28T12:00:00.000Z' }),
    // 10 days
    makeClaim({ id: 'c', stage: 'engagement', updatedAt: '2026-04-19T12:00:00.000Z' }),
  ];
  const out = applySorting(claims, { column: 'days_in_stage', dir: 'asc' }, { now });
  assert.deepEqual(
    out.map((c) => c.id),
    ['b', 'a', 'c'],
  );
});

test('applySorting: returns a new array (does not mutate input)', () => {
  const claims = [
    makeClaim({ id: 'a', stage: 'engagement', fy: 2026 }),
    makeClaim({ id: 'b', stage: 'engagement', fy: 2024 }),
  ];
  const before = claims.map((c) => c.id);
  applySorting(claims, { column: 'fy', dir: 'desc' });
  assert.deepEqual(
    claims.map((c) => c.id),
    before,
  );
});

test('applySorting: empty list returns empty array', () => {
  const out = applySorting([], { column: 'fy', dir: 'asc' });
  assert.deepEqual(out, []);
});

// --- daysInStage ---------------------------------------------------------

test('daysInStage: same-day update returns 0', () => {
  const now = new Date('2026-04-29T12:00:00.000Z');
  assert.equal(daysInStage('2026-04-29T08:00:00.000Z', now), 0);
});

test('daysInStage: future date returns 0 (defensive against clock skew)', () => {
  const now = new Date('2026-04-29T12:00:00.000Z');
  assert.equal(daysInStage('2026-05-01T00:00:00.000Z', now), 0);
});

test('daysInStage: 5 days ago returns 5', () => {
  const now = new Date('2026-04-29T12:00:00.000Z');
  assert.equal(daysInStage('2026-04-24T12:00:00.000Z', now), 5);
});

// --- toggleAllSelection --------------------------------------------------

test('toggleAllSelection: empty selection → select all', () => {
  const r = toggleAllSelection({ current: new Set(), allIds: ['a', 'b', 'c'] });
  assert.deepEqual([...r.selection].sort(), ['a', 'b', 'c']);
  assert.equal(r.anchor, null);
});

test('toggleAllSelection: partial selection → select all', () => {
  const r = toggleAllSelection({ current: new Set(['a']), allIds: ['a', 'b', 'c'] });
  assert.deepEqual([...r.selection].sort(), ['a', 'b', 'c']);
});

test('toggleAllSelection: all selected → clear', () => {
  const r = toggleAllSelection({
    current: new Set(['a', 'b', 'c']),
    allIds: ['a', 'b', 'c'],
  });
  assert.equal(r.selection.size, 0);
});

test('toggleAllSelection: empty list → clear (idempotent)', () => {
  const r = toggleAllSelection({ current: new Set(['stale']), allIds: [] });
  assert.equal(r.selection.size, 0);
});

// --- nextSelection: range across the table sort order --------------------

test('nextSelection range: works against the sorted-row order in the table', () => {
  // After applySorting the row order may differ from the source list.
  // shift-click ranges are computed against the *visible* order, which
  // means callers must pass `sortedClaims.map(c => c.id)` not the input.
  const sortedIds = ['c', 'a', 'b'];
  const r = nextSelection({
    current: new Set(),
    anchor: 'c',
    targetId: 'b',
    orderedIds: sortedIds,
    mode: 'range',
  });
  // Order in the resulting Set is irrelevant; the row indices 0..2 are
  // included regardless of the ids' lexicographic relationship.
  assert.deepEqual([...r.selection].sort(), ['a', 'b', 'c']);
});

// --- stageAtOffset (bulk Advance / Revert per-card target) ---------------

test('stageAtOffset: +1 from engagement = activity_capture', () => {
  assert.equal(stageAtOffset('engagement', 1), 'activity_capture');
});

test('stageAtOffset: +1 from audit_defence = null (terminal)', () => {
  assert.equal(stageAtOffset('audit_defence', 1), null);
});

test('stageAtOffset: -1 from engagement = null (initial)', () => {
  assert.equal(stageAtOffset('engagement', -1), null);
});

test('stageAtOffset: -1 from review = expenditure_schedule', () => {
  assert.equal(stageAtOffset('review', -1), 'expenditure_schedule');
});

// --- runStageMutationsBatch (allSettled + toast) -------------------------
// Migrated from pipeline-kanban.test.tsx — the helper now lives in
// `_lib/use-pipeline-claims.ts` and takes a moves[] array (not separate
// id + toStage). Same Promise.allSettled invariant + same toast cases.

interface ToastCall {
  title?: unknown;
  description?: unknown;
  variant?: unknown;
}

function makeToastSpy(): {
  toast: (t: ToastCall) => unknown;
  calls: ToastCall[];
} {
  const calls: ToastCall[] = [];
  return {
    toast: (t: ToastCall): unknown => {
      calls.push(t);
      return { id: 'spy', dismiss: (): void => undefined, update: (): void => undefined };
    },
    calls,
  };
}

test('runStageMutationsBatch: all-success emits no toast', async () => {
  const patches: Array<{ id: string; toStage: ClaimStage }> = [];
  const patchStage = async (input: { id: string; toStage: ClaimStage }): Promise<void> => {
    patches.push(input);
    return Promise.resolve();
  };
  const spy = makeToastSpy();

  const result = await runStageMutationsBatch(
    [
      { id: 'c1', toStage: 'review' },
      { id: 'c2', toStage: 'review' },
      { id: 'c3', toStage: 'review' },
    ],
    patchStage,
    spy.toast,
  );

  assert.equal(result.ok, 3);
  assert.equal(result.failed, 0);
  assert.equal(spy.calls.length, 0); // success-only is silent
  assert.equal(patches.length, 3);
});

test('runStageMutationsBatch: partial failure emits "Partial success" toast', async () => {
  let n = 0;
  const patchStage = async (_input: { id: string; toStage: ClaimStage }): Promise<void> => {
    n += 1;
    if (n === 2) throw new Error('simulated network 500');
    return Promise.resolve();
  };
  const spy = makeToastSpy();

  const origErr = console.error;
  console.error = (): void => undefined;
  try {
    const result = await runStageMutationsBatch(
      [
        { id: 'c1', toStage: 'review' },
        { id: 'c2', toStage: 'review' },
        { id: 'c3', toStage: 'review' },
      ],
      patchStage,
      spy.toast,
    );
    assert.equal(result.ok, 2);
    assert.equal(result.failed, 1);
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0]?.title, 'Partial success');
    assert.equal(spy.calls[0]?.description, '2 of 3 advanced; 1 failed');
    assert.equal(spy.calls[0]?.variant, 'default');
  } finally {
    console.error = origErr;
  }
});

test('runStageMutationsBatch: all-fail emits destructive toast', async () => {
  const patchStage = (_input: { id: string; toStage: ClaimStage }): Promise<void> =>
    Promise.reject(new Error('simulated 500'));
  const spy = makeToastSpy();

  const origErr = console.error;
  console.error = (): void => undefined;
  try {
    const result = await runStageMutationsBatch(
      [
        { id: 'c1', toStage: 'review' },
        { id: 'c2', toStage: 'review' },
      ],
      patchStage,
      spy.toast,
    );
    assert.equal(result.ok, 0);
    assert.equal(result.failed, 2);
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0]?.title, 'Stage advance failed');
    assert.equal(spy.calls[0]?.description, 'All 2 attempts failed');
    assert.equal(spy.calls[0]?.variant, 'destructive');
  } finally {
    console.error = origErr;
  }
});

test('runStageMutationsBatch: empty moves resolves without PATCH or toast', async () => {
  let calls = 0;
  const patchStage = async (): Promise<void> => {
    calls += 1;
    return Promise.resolve();
  };
  const spy = makeToastSpy();

  const result = await runStageMutationsBatch([], patchStage, spy.toast);

  assert.equal(result.ok, 0);
  assert.equal(result.failed, 0);
  assert.equal(calls, 0);
  assert.equal(spy.calls.length, 0);
});

test('runStageMutationsBatch: one rejection does NOT throw away the other resolves', async () => {
  let succeeded = 0;
  const patchStage = async (input: { id: string; toStage: ClaimStage }): Promise<void> => {
    if (input.id === 'bad') throw new Error('boom');
    succeeded += 1;
    return Promise.resolve();
  };
  const spy = makeToastSpy();

  const origErr = console.error;
  console.error = (): void => undefined;
  try {
    const result = await runStageMutationsBatch(
      [
        { id: 'ok1', toStage: 'review' },
        { id: 'bad', toStage: 'review' },
        { id: 'ok2', toStage: 'review' },
        { id: 'ok3', toStage: 'review' },
      ],
      patchStage,
      spy.toast,
    );
    assert.equal(succeeded, 3);
    assert.equal(result.ok, 3);
    assert.equal(result.failed, 1);
  } finally {
    console.error = origErr;
  }
});
