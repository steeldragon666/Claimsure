import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicaliseSections,
  hashSections,
  type NarrativeSections,
} from './narrative-canonical.js';

/**
 * P6 Task 5.3 — narrative content-hash canonicaliser tests.
 *
 * Pure helper, no DB. Mirrors the discrimination-test pattern from
 * `chain.canonical.test.ts`: each test isolates a single property
 * of the canonicaliser (top-level reorder, citing_events reorder,
 * mutation safety, snapshot lock, …) so a regression in one
 * property fails one specific test rather than smearing across
 * the suite.
 */

const E1 = '00000000-0000-4000-8000-000000000001';
const E2 = '00000000-0000-4000-8000-000000000002';
const E3 = '00000000-0000-4000-8000-000000000003';
const E4 = '00000000-0000-4000-8000-000000000004';

function fixture(): NarrativeSections {
  return {
    new_knowledge: [
      { type: 'prose', text: 'Section intro prose.' },
      { type: 'claim', text: 'We discovered X.', citing_events: [E2, E1] },
    ],
    hypothesis: [{ type: 'claim', text: 'We hypothesised Y.', citing_events: [E3] }],
    uncertainty: [{ type: 'prose', text: 'The uncertainty was Z.' }],
    experiments_and_results: [{ type: 'claim', text: 'Result was W.', citing_events: [E4] }],
  };
}

test('determinism — same input twice produces identical hash', () => {
  const a = hashSections(fixture());
  const b = hashSections(fixture());
  assert.equal(a, b);
});

test('section_kind reorder produces identical hash', () => {
  const a = fixture();
  const b: NarrativeSections = {
    // intentionally reverse-ordered top-level keys
    experiments_and_results: a.experiments_and_results,
    uncertainty: a.uncertainty,
    hypothesis: a.hypothesis,
    new_knowledge: a.new_knowledge,
  };
  assert.equal(hashSections(a), hashSections(b));
});

test('citing_events reorder produces identical hash', () => {
  const a: NarrativeSections = {
    new_knowledge: [{ type: 'claim', text: 'c', citing_events: [E1, E2, E3] }],
    hypothesis: [],
    uncertainty: [],
    experiments_and_results: [],
  };
  const b: NarrativeSections = {
    new_knowledge: [{ type: 'claim', text: 'c', citing_events: [E3, E1, E2] }],
    hypothesis: [],
    uncertainty: [],
    experiments_and_results: [],
  };
  assert.equal(hashSections(a), hashSections(b));
});

test('segment text change produces different hash', () => {
  const a = fixture();
  const b = fixture();
  // mutate the prose segment text on b's copy
  b.new_knowledge = [
    { type: 'prose', text: 'Different intro prose.' },
    ...b.new_knowledge.slice(1),
  ];
  assert.notEqual(hashSections(a), hashSections(b));
});

test('citing_events change (different UUID) produces different hash', () => {
  const a = fixture();
  const b = fixture();
  b.hypothesis = [{ type: 'claim', text: 'We hypothesised Y.', citing_events: [E4] }];
  assert.notEqual(hashSections(a), hashSections(b));
});

test('citing_events SET change (extra UUID) produces different hash', () => {
  const a: NarrativeSections = {
    new_knowledge: [{ type: 'claim', text: 'c', citing_events: [E1, E2] }],
    hypothesis: [],
    uncertainty: [],
    experiments_and_results: [],
  };
  const b: NarrativeSections = {
    new_knowledge: [{ type: 'claim', text: 'c', citing_events: [E1, E2, E3] }],
    hypothesis: [],
    uncertainty: [],
    experiments_and_results: [],
  };
  assert.notEqual(hashSections(a), hashSections(b));
});

test('segment count change (extra segment) produces different hash', () => {
  const a = fixture();
  const b = fixture();
  b.uncertainty = [...b.uncertainty, { type: 'prose', text: 'Extra uncertainty prose.' }];
  assert.notEqual(hashSections(a), hashSections(b));
});

test('segment-order change (real semantic reorder) produces different hash', () => {
  // segments are an ORDERED list — segment_index is preserved by array
  // position. Reordering the segments is a semantic change and MUST
  // change the hash (otherwise the auditor's drill-through breaks).
  const a: NarrativeSections = {
    new_knowledge: [
      { type: 'prose', text: 'first' },
      { type: 'prose', text: 'second' },
    ],
    hypothesis: [],
    uncertainty: [],
    experiments_and_results: [],
  };
  const b: NarrativeSections = {
    new_knowledge: [
      { type: 'prose', text: 'second' },
      { type: 'prose', text: 'first' },
    ],
    hypothesis: [],
    uncertainty: [],
    experiments_and_results: [],
  };
  assert.notEqual(hashSections(a), hashSections(b));
});

test('hash format matches narrative_draft.content_hash constraint', () => {
  const h = hashSections(fixture());
  assert.match(h, /^[a-f0-9]{64}$/);
});

test('snapshot lock — fixture hash is byte-stable', () => {
  // Hardcoded snapshot of `hashSections(fixture())`. If this test
  // ever fails, the canonicaliser's contract has drifted: any
  // existing `narrative_draft.content_hash` and `NARRATIVE_DRAFTED`
  // chain event in production would re-hash differently and break
  // chain verification. Treat this test as a deploy-blocker.
  assert.equal(
    hashSections(fixture()),
    'dcd3f14ae6c09588fe387fd5b92795b9377657640841e989ff55d49ce65dd323',
  );
});

test('all-empty sections produces a stable hash distinct from non-empty', () => {
  const empty: NarrativeSections = {
    new_knowledge: [],
    hypothesis: [],
    uncertainty: [],
    experiments_and_results: [],
  };
  const a = hashSections(empty);
  const b = hashSections(empty);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, hashSections(fixture()));
});

test('mutation safety — input citing_events is not mutated by the canonicaliser', () => {
  const original: NarrativeSections = {
    new_knowledge: [{ type: 'claim', text: 'c', citing_events: [E2, E1] }],
    hypothesis: [],
    uncertainty: [],
    experiments_and_results: [],
  };
  // capture pre-call array identity + contents
  const seg = original.new_knowledge[0];
  if (seg === undefined || seg.type !== 'claim') {
    throw new Error('test fixture invariant: new_knowledge[0] must be a claim segment');
  }
  const citingRef = seg.citing_events;
  const citingSnapshot: string[] = [...citingRef];

  hashSections(original);

  // The original array reference must be the same instance and
  // contain the same elements in the same order — i.e. the
  // canonicaliser sorted on a copy.
  assert.equal(seg.citing_events, citingRef);
  assert.deepEqual<readonly string[]>([...seg.citing_events], citingSnapshot);
  // sanity: the snapshot was the unsorted input order
  assert.deepEqual(citingSnapshot, [E2, E1]);
});

test('missing section_kind throws (defensive)', () => {
  // Casting through `unknown` to bypass the type-level guarantee —
  // we want to verify the runtime check fires when callers (e.g.
  // future API code, tests, scripts) accidentally pass a partial
  // record, since a missing section would otherwise hash as if
  // the section were the literal value `undefined`.
  const partial = {
    new_knowledge: [],
    hypothesis: [],
    // uncertainty intentionally missing
    experiments_and_results: [],
  } as unknown as NarrativeSections;
  assert.throws(() => hashSections(partial), /missing section_kind "uncertainty"/);
});

test('canonicaliseSections produces sorted top-level keys regardless of input order', () => {
  // Verifies the canonical-JSON serialiser is in fact sorting keys.
  // Belt-and-braces: the chain canonicaliser already enforces this,
  // but the narrative helper's contract depends on it, so we lock
  // it in at this layer too.
  const a = fixture();
  const reordered: NarrativeSections = {
    experiments_and_results: a.experiments_and_results,
    uncertainty: a.uncertainty,
    hypothesis: a.hypothesis,
    new_knowledge: a.new_knowledge,
  };
  const json = canonicaliseSections(reordered);
  // Top-level keys must appear in lex order in the canonical bytes.
  const keyOrder = [
    json.indexOf('"experiments_and_results"'),
    json.indexOf('"hypothesis"'),
    json.indexOf('"new_knowledge"'),
    json.indexOf('"uncertainty"'),
  ];
  assert.deepEqual(
    keyOrder,
    [...keyOrder].sort((x, y) => x - y),
    `expected lex-sorted top-level keys, got positions ${JSON.stringify(keyOrder)}`,
  );
});
