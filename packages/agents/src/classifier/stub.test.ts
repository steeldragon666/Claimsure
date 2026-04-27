import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StubClassifier } from './stub.js';

const c = new StubClassifier();

const cases: Array<{ input: string; expected_kind: string; expected_anchor: string | null }> = [
  {
    input: 'Spent 4 hours debugging the regulator.',
    expected_kind: 'TIME_LOG',
    expected_anchor: null,
  },
  {
    input: "Director's spouse provided contractor services.",
    expected_kind: 'ASSOCIATE_FLAG',
    expected_anchor: null,
  },
  {
    input: 'Invoice #123 paid $4,500 to vendor.',
    expected_kind: 'EXPENDITURE_NOTE',
    expected_anchor: null,
  },
  {
    input: 'This is just our normal business as usual maintenance.',
    expected_kind: 'INELIGIBLE',
    expected_anchor: '§355-25(2)(a)',
  },
  {
    input: 'We hypothesised the catalyst would last 200 hours.',
    expected_kind: 'HYPOTHESIS',
    expected_anchor: '§355-25(1)(a)',
  },
  {
    input: 'Ran the test rig at 50C for 12 hours and measured throughput.',
    expected_kind: 'EXPERIMENT',
    expected_anchor: '§355-25(1)(a)',
  },
  {
    input: 'We observed throughput dropped after iteration 3.',
    expected_kind: 'OBSERVATION',
    expected_anchor: '§355-25(1)(a)',
  },
  {
    input: 'Refined the algorithm based on the prior run.',
    expected_kind: 'ITERATION',
    expected_anchor: '§355-25(1)(a)',
  },
  {
    input: 'It is unclear whether this approach will scale.',
    expected_kind: 'UNCERTAINTY',
    expected_anchor: '§355-25(1)(a)',
  },
  {
    input: 'We discovered that the failure mode was thermal.',
    expected_kind: 'NEW_KNOWLEDGE',
    expected_anchor: '§355-25(1)(a)',
  },
  {
    input: 'New design schematic for the reactor.',
    expected_kind: 'DESIGN',
    expected_anchor: null,
  },
  {
    input: 'Random unrelated sentence with no R&D vocabulary.',
    expected_kind: 'SUPPORTING',
    expected_anchor: '§355-30',
  },
];

for (const tc of cases) {
  test(`StubClassifier: "${tc.input.slice(0, 40)}..." → ${tc.expected_kind}`, async () => {
    const out = await c.classify({ raw_text: tc.input });
    assert.equal(out.kind, tc.expected_kind);
    assert.equal(out.statutory_anchor, tc.expected_anchor);
    assert.equal(out.model, 'stub-v1.0.0');
    assert.equal(out.prompt_version, 'classify@1.0.0');
    assert.ok(out.confidence > 0 && out.confidence <= 1);
  });
}
