import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderApportionmentReportPdf,
  type ApportionmentReportInput,
} from './apportionment-report.js';

/**
 * Tests for renderApportionmentReportPdf — pure-function rendering.
 *
 * Same shape as `claim-summary.test.ts` and A8's
 * `activity-application.test.ts`: structural assertions over the opaque
 * PDF byte stream. We lock the externally-observable surface (returns a
 * non-empty Uint8Array, starts with %PDF-, exits with %%EOF) and exercise
 * every input branch the apportionment-report's mapping_state union
 * produces (unmapped / mapped / apportioned).
 *
 * The all-unmapped variant is today's universal reality (no events
 * exist; A-swimlane lands the EXPENDITURE_MAPPED + EXPENDITURE_APPORTIONED
 * event kinds). The other variants exercise the rendering paths that
 * unblock the moment those events arrive — they have to render correctly
 * NOW so the route layer can flip to live data without surfacing layout
 * regressions then.
 */

const PDF_MAGIC = Buffer.from('%PDF', 'ascii');

function assertIsPdf(bytes: Uint8Array): void {
  assert.ok(bytes.length > 0, 'PDF byte length must be positive');
  // PDF magic header: %PDF (then version, e.g. -1.4)
  const head = Buffer.from(bytes.slice(0, 4));
  assert.ok(head.equals(PDF_MAGIC), `Expected %PDF magic header, got ${head.toString('utf8')}`);
  // Every PDF ends with %%EOF (possibly followed by a newline).
  const trailer = Buffer.from(bytes.slice(bytes.length - 16)).toString('utf8');
  assert.ok(trailer.includes('%%EOF'), `trailer should contain %%EOF; got: ${trailer}`);
}

const baseInput: ApportionmentReportInput = {
  firm: { name: 'Carbon Project Australia', abn: '12 345 678 901' },
  subject_tenant: { name: 'Acme Pty Ltd', abn: '98 765 432 109' },
  project: {
    name: 'Soil-microbiome carbon-sink experiment',
    description: 'Investigate fungal-bacterial co-cultures for elevated SOC retention.',
  },
  claim: { fiscal_year: 2027, stage: 'narrative_drafting' },
  expenditures: [
    {
      id: 'exp-001',
      kind: 'INVOICE',
      date: '2026-08-12',
      payee: 'Bio Supplies Co',
      reference: 'INV-2026-0042',
      amount: 5000,
      currency: 'AUD',
      mapping_state: { type: 'unmapped' },
    },
    {
      id: 'exp-002',
      kind: 'INVOICE',
      date: '2026-09-03',
      payee: 'Lab Reagents Pty',
      reference: 'INV-2026-0099',
      amount: 8000,
      currency: 'AUD',
      mapping_state: {
        type: 'mapped',
        activity_code: 'CA-001',
        activity_title: 'Adaptive scaffolding algorithm',
      },
    },
    {
      id: 'exp-003',
      kind: 'BANK_TX',
      date: '2026-10-21',
      payee: 'Sensor Tech Ltd',
      reference: null,
      amount: 12000,
      currency: 'AUD',
      mapping_state: {
        type: 'apportioned',
        allocations: [
          {
            activity_code: 'CA-001',
            activity_title: 'Adaptive scaffolding algorithm',
            percentage: 60,
            amount: 7200,
          },
          {
            activity_code: 'CA-002',
            activity_title: 'Sensor calibration trial',
            percentage: 40,
            amount: 4800,
          },
        ],
      },
    },
  ],
  activity_rollup: [
    {
      code: 'CA-001',
      title: 'Adaptive scaffolding algorithm',
      kind: 'CORE',
      expenditure_count: 2,
      total_amount: 15200,
    },
    {
      code: 'CA-002',
      title: 'Sensor calibration trial',
      kind: 'CORE',
      expenditure_count: 1,
      total_amount: 4800,
    },
  ],
  totals: {
    total_expenditure: 25000,
    total_apportioned: 20000,
    total_unmapped: 5000,
    total_unmapped_count: 1,
    currency: 'AUD',
  },
  generated_at: '2027-04-29T10:00:00.000Z',
};

test('renderApportionmentReportPdf: complete input renders + magic bytes', async () => {
  const out = await renderApportionmentReportPdf(baseInput);
  assertIsPdf(out);
  // Sanity bound: this 3-expenditure / 2-activity report is well under
  // 50KB but well over 1KB. Tightens the regression net without locking
  // a brittle exact size.
  assert.ok(out.length > 1024, `expected >1KB, got ${out.length}`);
  assert.ok(out.length < 100_000, `expected <100KB, got ${out.length}`);
});

test("renderApportionmentReportPdf: all-unmapped (today's reality) renders correctly", async () => {
  // Mirror the route's pre-A-swimlane projection: every expenditure is
  // unmapped, no apportionment, totals collapse to total_unmapped ===
  // total_expenditure. This is the document a regulator will actually
  // see in the current build, so it must render without throwing.
  const allUnmapped: ApportionmentReportInput = {
    ...baseInput,
    expenditures: baseInput.expenditures.map((e) => ({
      ...e,
      mapping_state: { type: 'unmapped' as const },
    })),
    activity_rollup: [],
    totals: {
      total_expenditure: 25000,
      total_apportioned: 0,
      total_unmapped: 25000,
      total_unmapped_count: 3,
      currency: 'AUD',
    },
  };
  const out = await renderApportionmentReportPdf(allUnmapped);
  assertIsPdf(out);
});

test('renderApportionmentReportPdf: multi-activity rollup renders correctly', async () => {
  // Six activities exercise the rollup table's pagination + share-of-
  // total computation. The activities sum to less than total_expenditure
  // (some unmapped spend remains) — the rollup share column should
  // reflect that gap without errors.
  const multiActivity: ApportionmentReportInput = {
    ...baseInput,
    activity_rollup: Array.from({ length: 6 }, (_, i) => ({
      code: `CA-${String(i + 1).padStart(3, '0')}`,
      title: `Activity ${i + 1}`,
      kind: i % 2 === 0 ? ('CORE' as const) : ('SUPPORTING' as const),
      expenditure_count: i + 1,
      total_amount: 1000 + i * 250,
    })),
  };
  const out = await renderApportionmentReportPdf(multiActivity);
  assertIsPdf(out);
});

test('renderApportionmentReportPdf: apportioned expenditure renders multi-line breakdown', async () => {
  // Single expenditure, 3-way split. The mapping cell should render
  // three lines (33.3% / 33.3% / 33.4%) without blowing the row.
  const apportioned: ApportionmentReportInput = {
    ...baseInput,
    expenditures: [
      {
        id: 'exp-tri',
        kind: 'INVOICE',
        date: '2026-11-15',
        payee: 'Multi-activity vendor',
        reference: 'INV-X',
        amount: 9000,
        currency: 'AUD',
        mapping_state: {
          type: 'apportioned',
          allocations: [
            {
              activity_code: 'CA-001',
              activity_title: 'Activity 1',
              percentage: 33.3,
              amount: 2997,
            },
            {
              activity_code: 'CA-002',
              activity_title: 'Activity 2',
              percentage: 33.3,
              amount: 2997,
            },
            {
              activity_code: 'CA-003',
              activity_title: 'Activity 3',
              percentage: 33.4,
              amount: 3006,
            },
          ],
        },
      },
    ],
    activity_rollup: [
      {
        code: 'CA-001',
        title: 'Activity 1',
        kind: 'CORE',
        expenditure_count: 1,
        total_amount: 2997,
      },
      {
        code: 'CA-002',
        title: 'Activity 2',
        kind: 'CORE',
        expenditure_count: 1,
        total_amount: 2997,
      },
      {
        code: 'CA-003',
        title: 'Activity 3',
        kind: 'SUPPORTING',
        expenditure_count: 1,
        total_amount: 3006,
      },
    ],
    totals: {
      total_expenditure: 9000,
      total_apportioned: 9000,
      total_unmapped: 0,
      total_unmapped_count: 0,
      currency: 'AUD',
    },
  };
  const out = await renderApportionmentReportPdf(apportioned);
  assertIsPdf(out);
});

test('renderApportionmentReportPdf: multi-page (100+ expenditures) renders', async () => {
  // 150 expenditures — busy claim. The detail table must paginate; we
  // assert a larger output than the baseline + a reasonable upper bound
  // so a future cell-rendering regression that explodes byte size lands
  // visibly in CI.
  const many: ApportionmentReportInput = {
    ...baseInput,
    expenditures: Array.from({ length: 150 }, (_, i) => ({
      id: `exp-${String(i + 1).padStart(4, '0')}`,
      kind:
        i % 3 === 0
          ? ('INVOICE' as const)
          : i % 3 === 1
            ? ('BANK_TX' as const)
            : ('RECEIPT' as const),
      date: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`,
      payee: `Vendor ${i + 1}`,
      reference: `REF-${i + 1}`,
      amount: 100 + i * 7,
      currency: 'AUD',
      mapping_state: { type: 'unmapped' as const },
    })),
  };
  const out = await renderApportionmentReportPdf(many);
  assertIsPdf(out);
  const baseline = await renderApportionmentReportPdf(baseInput);
  assert.ok(
    out.length > baseline.length,
    `multi-page (${out.length}) should exceed baseline (${baseline.length})`,
  );
  // Multi-page sanity: 150 rows is comfortably more than 1 page worth,
  // so the buffer should be at least 2x the 3-row baseline. (We don't
  // assert exact page count — @react-pdf doesn't surface it via the
  // public API.)
  assert.ok(
    out.length > baseline.length * 2,
    `expected multi-page output (${out.length}) > 2x baseline (${baseline.length})`,
  );
});

test('renderApportionmentReportPdf: generated_at timestamp affects buffer', async () => {
  // Two PDFs with different timestamps must differ — proves the
  // timestamp string actually reaches the rendered document. Mirrors the
  // claim-summary determinism test.
  const a = await renderApportionmentReportPdf(baseInput);
  const b = await renderApportionmentReportPdf({
    ...baseInput,
    generated_at: '2099-12-31T23:59:59.000Z',
  });
  if (a.length === b.length) {
    assert.notEqual(Buffer.from(a).compare(Buffer.from(b)), 0);
  } else {
    assert.notEqual(a.length, b.length);
  }
});

test('renderApportionmentReportPdf: empty expenditures + null abn renders', async () => {
  // Sparse input — exercises the null-abn header branch and both
  // empty-state paths (rollup + detail).
  const sparse: ApportionmentReportInput = {
    firm: { name: 'NoABN Firm', abn: null },
    subject_tenant: { name: 'NoABN Claimant', abn: null },
    project: { name: 'No-description project', description: null },
    claim: { fiscal_year: 2027, stage: 'discovery' },
    expenditures: [],
    activity_rollup: [],
    totals: {
      total_expenditure: 0,
      total_apportioned: 0,
      total_unmapped: 0,
      total_unmapped_count: 0,
      currency: 'AUD',
    },
    generated_at: '2027-04-29T10:00:00.000Z',
  };
  const out = await renderApportionmentReportPdf(sparse);
  assertIsPdf(out);
});
