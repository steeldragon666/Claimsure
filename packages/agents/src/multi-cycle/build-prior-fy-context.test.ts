import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildPriorFyContext } from './build-prior-fy-context.js';
import type { ChainWalkExecutor } from './walk-proposed-id.js';

/**
 * Unit-test style — same DI executor pattern as
 * `walk-proposed-id.test.ts`. The executor is a stub that captures
 * captured tagged-template calls and returns canned rows. The helper
 * issues TWO queries:
 *   1. The chain-walker SELECT (issued by `walkProposedIdChain`).
 *   2. The segment-projection SELECT (joining narrative_segment and
 *      narrative_draft to surface verbatim text grouped by section_kind).
 * The stub serves both via a queued `responses` array — call N gets
 * `responses[N]`. This lets each test seed its own chain + segments
 * fixtures without polluting the others.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

interface CapturedCall {
  text: string;
  values: unknown[];
}

function makeQueuedExecutor(responses: unknown[][]): {
  executor: ChainWalkExecutor;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let i = 0;
  const executor = <T>(
    template: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<readonly T[]> => {
    const text = template.reduce(
      (acc, chunk, idx) => acc + chunk + (idx < values.length ? `?${idx + 1}` : ''),
      '',
    );
    calls.push({ text, values });
    const rows = responses[i] ?? [];
    i += 1;
    return Promise.resolve(rows as readonly T[]);
  };
  return { executor, calls };
}

interface ChainRowFixture {
  activity_id: string;
  fy_label: string;
  hypothesis_formed_at: Date;
  proposed_id: string;
  narrative_draft_id: string;
  content_hash: string;
}

function chainRow(overrides: Partial<ChainRowFixture> = {}): ChainRowFixture {
  return {
    activity_id: randomUUID(),
    fy_label: 'FY25',
    hypothesis_formed_at: new Date('2025-08-01T00:00:00Z'),
    proposed_id: randomUUID(),
    narrative_draft_id: randomUUID(),
    content_hash: 'a'.repeat(64),
    ...overrides,
  };
}

interface SegmentRowFixture {
  fy_label: string;
  section_kind: string;
  segment_index: number;
  text: string;
}

/* ------------------------------------------------------------------ */
/* Test 1 — empty chain returns null                                   */
/* ------------------------------------------------------------------ */

test('buildPriorFyContext returns null when the chain is empty', async () => {
  const { executor } = makeQueuedExecutor([[]]);
  const result = await buildPriorFyContext({
    rootProposedId: randomUUID(),
    tenantId: TENANT_A,
    excludeFyLabel: 'FY26',
    executor,
  });
  assert.equal(result, null);
});

/* ------------------------------------------------------------------ */
/* Test 2 — single-FY chain (only the current FY) returns null         */
/* ------------------------------------------------------------------ */

test('buildPriorFyContext returns null when only the current FY is in the chain', async () => {
  const proposedId = randomUUID();
  // Chain has exactly one row, and we're excluding that FY (it IS the
  // current FY). Default-on logic per Q5: < 1 prior FY -> no context.
  const { executor } = makeQueuedExecutor([
    [chainRow({ proposed_id: proposedId, fy_label: 'FY26' })],
  ]);

  const result = await buildPriorFyContext({
    rootProposedId: proposedId,
    tenantId: TENANT_A,
    excludeFyLabel: 'FY26',
    executor,
  });

  assert.equal(result, null);
});

/* ------------------------------------------------------------------ */
/* Test 3 — multi-FY chain returns block sorted by fy_label ASC        */
/* ------------------------------------------------------------------ */

test('buildPriorFyContext returns a block with prior_fys.length === 2 when the chain has 3 FYs and current is excluded', async () => {
  const proposedId = randomUUID();
  const fy24DraftId = randomUUID();
  const fy25DraftId = randomUUID();
  const fy26DraftId = randomUUID();

  const chainResponse = [
    chainRow({
      proposed_id: proposedId,
      fy_label: 'FY24',
      narrative_draft_id: fy24DraftId,
    }),
    chainRow({
      proposed_id: proposedId,
      fy_label: 'FY25',
      narrative_draft_id: fy25DraftId,
    }),
    chainRow({
      proposed_id: proposedId,
      fy_label: 'FY26',
      narrative_draft_id: fy26DraftId,
    }),
  ];
  const segmentResponse: SegmentRowFixture[] = [];
  const { executor } = makeQueuedExecutor([chainResponse, segmentResponse]);

  const result = await buildPriorFyContext({
    rootProposedId: proposedId,
    tenantId: TENANT_A,
    excludeFyLabel: 'FY26',
    executor,
  });

  assert.notEqual(result, null);
  assert.equal(result!.proposed_id, proposedId);
  assert.equal(result!.prior_fys.length, 2);
  // Sorted ASC by fy_label.
  assert.equal(result!.prior_fys[0]!.fy_label, 'FY24');
  assert.equal(result!.prior_fys[1]!.fy_label, 'FY25');
  // transition_classification is null in the structural helper —
  // the multi-cycle summariser populates it later.
  assert.equal(result!.prior_fys[0]!.transition_classification, null);
  assert.equal(result!.prior_fys[1]!.transition_classification, null);
});

/* ------------------------------------------------------------------ */
/* Test 4 — hypothesis segments project into hypothesis_segment_excerpts */
/* ------------------------------------------------------------------ */

test('buildPriorFyContext projects hypothesis segments into hypothesis_segment_excerpts', async () => {
  const proposedId = randomUUID();
  const fy24DraftId = randomUUID();

  const chainResponse = [
    chainRow({
      proposed_id: proposedId,
      fy_label: 'FY24',
      narrative_draft_id: fy24DraftId,
    }),
    chainRow({ proposed_id: proposedId, fy_label: 'FY25' }),
  ];
  const segmentResponse: SegmentRowFixture[] = [
    {
      fy_label: 'FY24',
      section_kind: 'hypothesis',
      segment_index: 0,
      text: 'FY24 hypothesis segment 0 verbatim text.',
    },
    {
      fy_label: 'FY24',
      section_kind: 'hypothesis',
      segment_index: 1,
      text: 'FY24 hypothesis segment 1 verbatim text.',
    },
  ];
  const { executor } = makeQueuedExecutor([chainResponse, segmentResponse]);

  const result = await buildPriorFyContext({
    rootProposedId: proposedId,
    tenantId: TENANT_A,
    excludeFyLabel: 'FY25',
    executor,
  });

  assert.notEqual(result, null);
  const fy24 = result!.prior_fys.find((f) => f.fy_label === 'FY24');
  assert.ok(fy24, 'FY24 entry must be present');
  assert.deepEqual(fy24.hypothesis_segment_excerpts, [
    'FY24 hypothesis segment 0 verbatim text.',
    'FY24 hypothesis segment 1 verbatim text.',
  ]);
  assert.deepEqual(fy24.design_segment_excerpts, []);
});

/* ------------------------------------------------------------------ */
/* Test 5 — Q-Map=A binding: experiments_and_results -> design_*       */
/* ------------------------------------------------------------------ */

test('buildPriorFyContext projects experiments_and_results segments into design_segment_excerpts (Q-Map=A binding)', async () => {
  const proposedId = randomUUID();
  const fy24DraftId = randomUUID();

  const chainResponse = [
    chainRow({
      proposed_id: proposedId,
      fy_label: 'FY24',
      narrative_draft_id: fy24DraftId,
    }),
    chainRow({ proposed_id: proposedId, fy_label: 'FY25' }),
  ];
  // Critical: the SQL projects nd.section_kind directly. The helper
  // must map section_kind = 'experiments_and_results' -> design_*.
  const segmentResponse: SegmentRowFixture[] = [
    {
      fy_label: 'FY24',
      section_kind: 'experiments_and_results',
      segment_index: 0,
      text: 'FY24 experiments_and_results segment 0 verbatim.',
    },
    {
      fy_label: 'FY24',
      section_kind: 'experiments_and_results',
      segment_index: 1,
      text: 'FY24 experiments_and_results segment 1 verbatim.',
    },
  ];
  const { executor } = makeQueuedExecutor([chainResponse, segmentResponse]);

  const result = await buildPriorFyContext({
    rootProposedId: proposedId,
    tenantId: TENANT_A,
    excludeFyLabel: 'FY25',
    executor,
  });

  assert.notEqual(result, null);
  const fy24 = result!.prior_fys.find((f) => f.fy_label === 'FY24');
  assert.ok(fy24, 'FY24 entry must be present');
  // Q-Map=A binding: design_segment_excerpts (design-doc-stable name)
  // is sourced from section_kind = 'experiments_and_results' rows.
  assert.deepEqual(fy24.design_segment_excerpts, [
    'FY24 experiments_and_results segment 0 verbatim.',
    'FY24 experiments_and_results segment 1 verbatim.',
  ]);
  assert.deepEqual(fy24.hypothesis_segment_excerpts, []);
});

/* ------------------------------------------------------------------ */
/* Test 6 — tenant isolation (tenantId reaches both queries)           */
/* ------------------------------------------------------------------ */

test('buildPriorFyContext threads tenantId through both queries (chain walk + segment projection)', async () => {
  const proposedId = randomUUID();
  const fy24DraftId = randomUUID();

  const chainResponse = [
    chainRow({
      proposed_id: proposedId,
      fy_label: 'FY24',
      narrative_draft_id: fy24DraftId,
    }),
    chainRow({ proposed_id: proposedId, fy_label: 'FY25' }),
  ];
  const segmentResponse: SegmentRowFixture[] = [];
  const { executor, calls } = makeQueuedExecutor([chainResponse, segmentResponse]);

  await buildPriorFyContext({
    rootProposedId: proposedId,
    tenantId: TENANT_A,
    excludeFyLabel: 'FY25',
    executor,
  });

  // Two queries issued in order: chain walk, then segment projection.
  assert.equal(calls.length, 2);

  // Query 1 (chain walk): tenantId is parameter #1.
  assert.equal(calls[0]!.values[0], TENANT_A);
  assert.notEqual(calls[0]!.values[0], TENANT_B);
  assert.match(calls[0]!.text, /WHERE\s+a\.tenant_id\s*=\s*\?1/);

  // Query 2 (segment projection): tenantId is parameter #1 AGAIN
  // (the helper passes it explicitly to the segment query).
  assert.equal(calls[1]!.values[0], TENANT_A);
  assert.match(calls[1]!.text, /nd\.tenant_id\s*=\s*\?1/);
  // Defensive: the segment query must also restrict to the prior-FY
  // draft IDs (not all narrative_segment rows in the tenant).
  assert.match(calls[1]!.text, /ns\.narrative_draft_id\s*=\s*ANY\(\?2\)/);
});

/* ------------------------------------------------------------------ */
/* Test 7 — verbatim guarantee: text passes through byte-for-byte      */
/* ------------------------------------------------------------------ */

test('buildPriorFyContext preserves segment text verbatim (no LLM transformation)', async () => {
  const proposedId = randomUUID();
  const fy24DraftId = randomUUID();
  // Deliberately includes punctuation, whitespace, and a UTF-8
  // character to verify byte-for-byte passthrough.
  const seededText =
    '  The team hypothesised — at FY24 outset — that ε-greedy exploration\n  would not suffice.  ';

  const chainResponse = [
    chainRow({
      proposed_id: proposedId,
      fy_label: 'FY24',
      narrative_draft_id: fy24DraftId,
    }),
    chainRow({ proposed_id: proposedId, fy_label: 'FY25' }),
  ];
  const segmentResponse: SegmentRowFixture[] = [
    {
      fy_label: 'FY24',
      section_kind: 'hypothesis',
      segment_index: 0,
      text: seededText,
    },
  ];
  const { executor } = makeQueuedExecutor([chainResponse, segmentResponse]);

  const result = await buildPriorFyContext({
    rootProposedId: proposedId,
    tenantId: TENANT_A,
    excludeFyLabel: 'FY25',
    executor,
  });

  assert.notEqual(result, null);
  const fy24 = result!.prior_fys.find((f) => f.fy_label === 'FY24');
  assert.ok(fy24);
  // Byte-for-byte equality with the seeded text — no trim, no
  // normalisation, no paraphrase.
  assert.equal(fy24.hypothesis_segment_excerpts[0], seededText);
});

/* ------------------------------------------------------------------ */
/* Test 8 — duplicate fy_label in the chain throws (data corruption)   */
/* ------------------------------------------------------------------ */

test('buildPriorFyContext throws when two chain rows share an fy_label (data corruption)', async () => {
  const proposedId = randomUUID();
  // Seed two prior-FY chain rows that BOTH claim FY24. A real chain
  // should have at most one activity per fiscal year — silently merging
  // these into a single bucket (Map keyed on fy_label) would mask data
  // corruption, so the helper must throw a clear error instead.
  const chainResponse = [
    chainRow({ proposed_id: proposedId, fy_label: 'FY24' }),
    chainRow({ proposed_id: proposedId, fy_label: 'FY24' }),
    chainRow({ proposed_id: proposedId, fy_label: 'FY26' }),
  ];
  const { executor } = makeQueuedExecutor([chainResponse]);

  await assert.rejects(
    () =>
      buildPriorFyContext({
        rootProposedId: proposedId,
        tenantId: TENANT_A,
        excludeFyLabel: 'FY26',
        executor,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /duplicate fy_label 'FY24'/);
      assert.match(err.message, /data corruption/);
      return true;
    },
  );
});
