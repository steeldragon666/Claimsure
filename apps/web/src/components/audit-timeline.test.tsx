import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncateHash,
  type TimelineRow,
  type TimelineResponse,
  type ForensicMeta,
} from './audit-timeline.js';
import { truncateVersionHash, type NarrativeVersionEntry } from './narrative-version-diff.js';

/**
 * P7 Theme C Tasks C.2 + C.3 — audit-timeline + narrative-version-diff tests.
 *
 * apps/web's runner is `tsx --test` (Node, no jsdom). Following the
 * pattern from multi-cycle-timeline.test.tsx and page.test.tsx, we test
 * pure-function / structural guarantees here. Full DOM interaction is
 * deferred to Playwright e2e.
 *
 * Coverage:
 *   - TimelineRow interface: all five `kind` discriminants type-check
 *   - TimelineResponse structure matches expected shape
 *   - ForensicMeta fields present on event + narrative_version rows
 *   - truncateHash: long hashes → 8 chars; short hashes unchanged
 *   - truncateVersionHash: same behaviour for narrative versions
 */

// ---------- truncateHash ----------

test('truncateHash: returns first 8 chars of long hash', () => {
  const hash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  assert.equal(truncateHash(hash), 'abcdef12');
  assert.equal(truncateHash(hash).length, 8);
});

test('truncateHash: short hash returned as-is', () => {
  assert.equal(truncateHash('abc'), 'abc');
  assert.equal(truncateHash('12345678'), '12345678');
});

test('truncateHash: exactly 8 chars returns unchanged', () => {
  assert.equal(truncateHash('deadbeef'), 'deadbeef');
});

// ---------- truncateVersionHash ----------

test('truncateVersionHash: returns first 8 chars of long hash', () => {
  assert.equal(truncateVersionHash('hash_v1_abcdef1234567890'), 'hash_v1_');
});

test('truncateVersionHash: short hash returned as-is', () => {
  assert.equal(truncateVersionHash('abc'), 'abc');
});

// ---------- TimelineRow kind discriminants ----------

const EXPECTED_KINDS: TimelineRow['kind'][] = [
  'event',
  'narrative_version',
  'audit_log',
  'suggestion',
  'similarity_flag',
];

test('TimelineRow kind discriminants: all five expected kinds are type-valid', () => {
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

// ---------- ForensicMeta on event rows ----------

test('ForensicMeta: event row carries chain_position + content_hash + first_recorded_at', () => {
  const forensic: ForensicMeta = {
    first_recorded_at: '2025-06-01T00:00:01Z',
    content_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    chain_position: 3,
    prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
  };
  const row: TimelineRow = {
    kind: 'event',
    id: 'e1',
    timestamp: '2025-06-01T00:00:00Z',
    event_kind: 'ACTIVITY_UPDATED',
    chain_verified: true,
    forensic,
  };
  assert.equal(row.forensic?.chain_position, 3);
  assert.equal(truncateHash(forensic.content_hash ?? ''), 'abcdef12');
  assert.equal(row.forensic?.prev_hash?.slice(0, 8), '00000000');
});

test('ForensicMeta: narrative_version row carries edit_count + content_hash', () => {
  const forensic: ForensicMeta = {
    first_recorded_at: '2025-06-01T00:06:00Z',
    content_hash: 'hash_v2_content',
    edit_count: 2,
  };
  const row: TimelineRow = {
    kind: 'narrative_version',
    id: 'nv2',
    timestamp: '2025-06-01T00:06:00Z',
    forensic,
  };
  assert.equal(row.forensic?.edit_count, 2);
  assert.equal(row.forensic?.content_hash, 'hash_v2_content');
});

// ---------- TimelineResponse shape ----------

test('TimelineResponse shape: timeline array + chain_status + forensic fields', () => {
  const response: TimelineResponse = {
    timeline: [
      {
        kind: 'event',
        id: '1',
        timestamp: '2025-06-01T00:00:00Z',
        event_kind: 'ACTIVITY_CREATED',
        chain_verified: true,
        payload: { activity_id: 'a1' },
        forensic: {
          first_recorded_at: '2025-06-01T00:00:01Z',
          content_hash: 'abc123def456',
          chain_position: 1,
          prev_hash: null,
        },
      },
      {
        kind: 'narrative_version',
        id: '2',
        timestamp: '2025-06-01T00:01:00Z',
        metadata: { version: 1, generation_kind: 'initial' },
        forensic: {
          first_recorded_at: '2025-06-01T00:01:00Z',
          content_hash: 'hash_v1',
          edit_count: 1,
        },
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
  assert.equal(response.timeline.length, 2);
  assert.equal(response.timeline[0]!.forensic?.chain_position, 1);
  assert.equal(response.timeline[1]!.forensic?.edit_count, 1);
});

// ---------- NarrativeVersionEntry ----------

test('NarrativeVersionEntry: structure matches expected fields', () => {
  const entry: NarrativeVersionEntry = {
    id: 'v1',
    version: 1,
    generation_kind: 'initial',
    content_hash: 'abcdef1234567890',
    created_at: '2025-06-01T00:06:00Z',
  };
  assert.equal(entry.version, 1);
  assert.equal(truncateVersionHash(entry.content_hash), 'abcdef12');
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
test.todo('NarrativeVersionDiff component: full DOM interaction tested in Playwright e2e');
