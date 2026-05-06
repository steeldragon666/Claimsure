import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderExecutiveSummaryPdf, type ExecutiveSummaryInput } from './executive-summary.js';

/**
 * Tests for renderExecutiveSummaryPdf — pure-function rendering.
 *
 * The PDF buffer is opaque (compressed binary), so assertions are
 * structural rather than visual:
 *   - magic bytes (`%PDF`) confirm a real PDF was emitted
 *   - empty-state paths render without throwing
 *   - determinism: changing generated_at affects output (proves timestamp reaches the document)
 *   - activity kind chips: render with activities differs from render without
 *
 * Note: @react-pdf/renderer v4 deflate-compresses content streams, so raw
 * text search via Buffer.toString('latin1') only works for PDF structural
 * metadata (object headers, font names), not for rendered text content.
 * Content-presence tests use differential comparisons instead.
 */

const CLAIM_ID = '00000000-0000-4000-8000-000f40000001';

const baseInput: ExecutiveSummaryInput = {
  firm: { name: 'Test Firm Pty Ltd', abn: '12 345 678 901' },
  subject_tenant: { name: 'Acme Research Co', abn: '98 765 432 109' },
  claim: {
    id: CLAIM_ID,
    fy_year: 2025,
    eligible_expenditure: 1_500_000,
    tax_offset_estimate: 225_000,
    activity_count: 3,
    core_activity_count: 2,
    supporting_activity_count: 1,
  },
  generated_at: '2025-07-01T12:00:00Z',
  content_hash_hex: 'a'.repeat(64),
  generator_version: '1.0.0',
  activities: [
    {
      code: 'CA-001',
      title: 'Novel algorithm development',
      kind: 'core',
      hypothesis: 'We hypothesise that the algorithm will reduce compute time by 50%.',
    },
    {
      code: 'CA-002',
      title: 'Sensor calibration research',
      kind: 'core',
      hypothesis: null,
    },
    {
      code: 'SA-001',
      title: 'Supporting data collection',
      kind: 'supporting',
      hypothesis: null,
    },
  ],
  key_risks: [
    { description: 'Insufficient documented uncertainty', severity: 'high' },
    { description: 'Missing nexus between spend and activities', severity: 'medium' },
    { description: 'Minor formatting inconsistency in reports', severity: 'low' },
  ],
  preparer_notes: 'Review required before submission. Contact partner for sign-off.',
};

const PDF_MAGIC = Buffer.from('%PDF', 'ascii');

function assertIsPdf(bytes: Uint8Array): void {
  assert.ok(bytes.length > 0, 'PDF byte length must be positive');
  const head = Buffer.from(bytes.slice(0, 4));
  assert.ok(head.equals(PDF_MAGIC), `Expected %PDF magic header, got ${head.toString('utf8')}`);
}

test('renderExecutiveSummaryPdf: produces a valid PDF (magic bytes %PDF)', async () => {
  const pdf = await renderExecutiveSummaryPdf(baseInput);
  assertIsPdf(pdf);
  assert.ok(pdf.length > 1024, `expected >1KB, got ${pdf.length}`);
  assert.ok(pdf.length < 200_000, `expected <200KB, got ${pdf.length}`);
});

test('renderExecutiveSummaryPdf: empty activities renders without throwing', async () => {
  const input: ExecutiveSummaryInput = {
    ...baseInput,
    activities: [],
    claim: {
      ...baseInput.claim,
      activity_count: 0,
      core_activity_count: 0,
      supporting_activity_count: 0,
    },
  };
  const out = await renderExecutiveSummaryPdf(input);
  assertIsPdf(out);
});

test('renderExecutiveSummaryPdf: empty key_risks renders without throwing', async () => {
  const input: ExecutiveSummaryInput = {
    ...baseInput,
    key_risks: [],
  };
  const out = await renderExecutiveSummaryPdf(input);
  assertIsPdf(out);
});

test('renderExecutiveSummaryPdf: null preparer_notes omits section without throwing', async () => {
  const input: ExecutiveSummaryInput = {
    ...baseInput,
    preparer_notes: null,
  };
  const out = await renderExecutiveSummaryPdf(input);
  assertIsPdf(out);
});

test('renderExecutiveSummaryPdf: changing generated_at affects output', async () => {
  const a = await renderExecutiveSummaryPdf(baseInput);
  const b = await renderExecutiveSummaryPdf({
    ...baseInput,
    generated_at: '2099-12-31T23:59:59.000Z',
  });
  // Two PDFs with different timestamps must differ — proves the timestamp
  // string actually reaches the rendered document.
  if (a.length === b.length) {
    assert.notEqual(Buffer.from(a).compare(Buffer.from(b)), 0);
  } else {
    assert.notEqual(a.length, b.length);
  }
});

test('renderExecutiveSummaryPdf: activity kind chips render (core and supporting)', async () => {
  // Render with both core and supporting activities. The resulting PDF must
  // differ from a render with empty activities, proving activity data reaches the document.
  const withActivities = await renderExecutiveSummaryPdf(baseInput);
  const withoutActivities = await renderExecutiveSummaryPdf({
    ...baseInput,
    activities: [],
    claim: {
      ...baseInput.claim,
      activity_count: 0,
      core_activity_count: 0,
      supporting_activity_count: 0,
    },
  });
  assertIsPdf(withActivities);
  assertIsPdf(withoutActivities);
  // PDFs with activity rows must differ from the empty-activities PDF
  assert.notEqual(
    Buffer.from(withActivities).compare(Buffer.from(withoutActivities)),
    0,
    'PDF with core/supporting activity rows must differ from empty activities PDF',
  );
});
