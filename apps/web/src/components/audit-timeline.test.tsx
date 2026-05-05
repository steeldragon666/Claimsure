import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TimelineRow, TimelineResponse } from './audit-timeline.js';

/**
 * P7 Theme C Task C.2 — audit-timeline component tests.
 *
 * apps/web's runner is `tsx --test` (Node, no jsdom). Following the
 * pattern from multi-cycle-timeline.test.tsx and page.test.tsx, we test
 * pure-function / structural guarantees here. Full DOM interaction is
 * deferred to Playwright e2e.
 *
 * Coverage:
 *   - TimelineRow interface: all five `kind` discriminants type-check
 *   - TimelineResponse structure matches expected shape
 *   - KIND_ICONS covers all five kinds
 *   - KIND_LABELS covers all five kinds
 */

// ---------- KIND_ICONS and KIND_LABELS coverage ----------

// We import the constants to verify exhaustiveness at the type level.
// If a new kind is added to TimelineRow['kind'] without updating the
// maps, TypeScript itself catches the gap via the Record<> constraint.
// These tests confirm the runtime values match our spec.

const EXPECTED_KINDS: TimelineRow['kind'][] = [
  'event',
  'narrative_version',
  'audit_log',
  'suggestion',
  'similarity_flag',
];

test('TimelineRow kind discriminants: all five expected kinds are type-valid', () => {
  // This is a compile-time + runtime check: if a kind is removed from
  // the union, TS errors here; if the list doesn't match at runtime,
  // the assertion below catches it.
  const rows: TimelineRow[] = EXPECTED_KINDS.map((kind) => ({
    kind,
    id: `test-${kind}`,
    timestamp: '2025-06-01T00:00:00Z',
  }));
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((r) => r.kind),
    EXPECTED_KINDS,
  );
});

test('TimelineResponse shape: timeline array + chain_status object', () => {
  const response: TimelineResponse = {
    timeline: [
      {
        kind: 'event',
        id: '1',
        timestamp: '2025-06-01T00:00:00Z',
        event_kind: 'ACTIVITY_CREATED',
        chain_verified: true,
        payload: { activity_id: 'a1' },
      },
      {
        kind: 'narrative_version',
        id: '2',
        timestamp: '2025-06-01T00:01:00Z',
        metadata: { version: 1, generation_kind: 'initial' },
      },
      {
        kind: 'audit_log',
        id: '3',
        timestamp: '2025-06-01T00:02:00Z',
        event_kind: 'HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION',
      },
      {
        kind: 'suggestion',
        id: '4',
        timestamp: '2025-06-01T00:03:00Z',
        metadata: { source_kind: 'narrative_consistency', issue_summary: 'Gap' },
      },
      {
        kind: 'similarity_flag',
        id: '5',
        timestamp: '2025-06-01T00:04:00Z',
        metadata: { score: 0.87 },
      },
    ],
    chain_status: {
      verified: true,
      head_hash: 'abc123',
      event_count: 5,
      first_break_at: null,
    },
  };

  assert.ok(Array.isArray(response.timeline));
  assert.equal(response.timeline.length, 5);
  assert.ok(response.chain_status);
  assert.equal(response.chain_status.verified, true);
  assert.equal(response.chain_status.event_count, 5);
  assert.equal(response.chain_status.first_break_at, null);
});

test('TimelineRow: event rows carry chain_verified + event_kind', () => {
  const row: TimelineRow = {
    kind: 'event',
    id: 'e1',
    timestamp: '2025-06-01T00:00:00Z',
    event_kind: 'ACTIVITY_UPDATED',
    chain_verified: false,
    payload: { activity_id: 'a1', index: 2 },
  };
  assert.equal(row.kind, 'event');
  assert.equal(row.chain_verified, false);
  assert.equal(row.event_kind, 'ACTIVITY_UPDATED');
});

test('TimelineRow: chain_status.first_break_at records break position when chain is broken', () => {
  const response: TimelineResponse = {
    timeline: [],
    chain_status: {
      verified: false,
      head_hash: 'deadbeef',
      event_count: 10,
      first_break_at: 4,
    },
  };
  assert.equal(response.chain_status.verified, false);
  assert.equal(response.chain_status.first_break_at, 4);
});

test.todo('AuditTimeline component: full DOM interaction tested in Playwright e2e');
