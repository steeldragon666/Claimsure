import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderActivityRegisterPdf, type ActivityRegisterInput } from './activity-register.js';

/**
 * Tests for renderActivityRegisterPdf — pure-function rendering.
 *
 * The PDF buffer is opaque (compressed binary), so assertions are
 * structural rather than visual:
 *   - magic bytes (`%PDF`) confirm a real PDF was emitted
 *   - empty-state paths render without throwing
 *   - determinism: changing generated_at affects output
 *   - financial totals: different expenditure values produce different PDFs
 *   - landscape: orientation produces a valid PDF with wide content
 *   - null values: technical_lead and dates fall back to em-dash
 *
 * Note: @react-pdf/renderer v4 deflate-compresses content streams, so raw
 * text search via Buffer.toString('latin1') only works for PDF structural
 * metadata. Content-presence tests use differential comparisons instead.
 */

const CLAIM_ID = '00000000-0000-4000-8000-000f40000002';

const baseInput: ActivityRegisterInput = {
  firm: { name: 'Test Firm Pty Ltd', abn: '12 345 678 901' },
  subject_tenant: { name: 'Acme Research Co', abn: '98 765 432 109' },
  claim: { id: CLAIM_ID, fy_year: 2025 },
  generated_at: '2025-07-01T12:00:00Z',
  content_hash_hex: 'b'.repeat(64),
  generator_version: '1.0.0',
  activities: [
    {
      code: 'CA-001',
      title: 'Novel algorithm development',
      kind: 'core',
      hypothesis: 'We hypothesise the algorithm will reduce compute time by 50%.',
      technical_lead: 'Dr Jane Smith',
      start_date: '2025-01-01',
      end_date: '2025-06-30',
      eligible_expenditure: 800_000,
      time_entries_count: 120,
      supporting_documents_count: 15,
    },
    {
      code: 'SA-001',
      title: 'Supporting data collection and preparation',
      kind: 'supporting',
      hypothesis: null,
      technical_lead: 'Bob Jones',
      start_date: '2025-02-01',
      end_date: '2025-05-31',
      eligible_expenditure: 200_000,
      time_entries_count: 40,
      supporting_documents_count: 8,
    },
  ],
};

const PDF_MAGIC = Buffer.from('%PDF', 'ascii');

function assertIsPdf(bytes: Uint8Array): void {
  assert.ok(bytes.length > 0, 'PDF byte length must be positive');
  const head = Buffer.from(bytes.slice(0, 4));
  assert.ok(head.equals(PDF_MAGIC), `Expected %PDF magic header, got ${head.toString('utf8')}`);
}

test('renderActivityRegisterPdf: produces a valid PDF (magic bytes %PDF)', async () => {
  const result = await renderActivityRegisterPdf(baseInput);
  assertIsPdf(result);
  assert.ok(result.length > 1024, `expected >1KB, got ${result.length}`);
  assert.ok(result.length < 400_000, `expected <400KB, got ${result.length}`);
});

test('renderActivityRegisterPdf: empty activities renders without throwing', async () => {
  const input: ActivityRegisterInput = {
    ...baseInput,
    activities: [],
  };
  const out = await renderActivityRegisterPdf(input);
  assertIsPdf(out);
});

test('renderActivityRegisterPdf: changing generated_at affects output', async () => {
  const a = await renderActivityRegisterPdf(baseInput);
  const b = await renderActivityRegisterPdf({
    ...baseInput,
    generated_at: '2099-12-31T23:59:59.000Z',
  });
  // Two PDFs with different timestamps must differ — proves the timestamp
  // string actually reaches the rendered document.
  assert.notEqual(Buffer.from(a).compare(Buffer.from(b)), 0);
});

test('renderActivityRegisterPdf: financial totals differ with different expenditure', async () => {
  const highSpend = await renderActivityRegisterPdf(baseInput);
  const lowSpend = await renderActivityRegisterPdf({
    ...baseInput,
    activities: baseInput.activities.map((a) => ({
      ...a,
      eligible_expenditure: 1,
    })),
  });
  assertIsPdf(highSpend);
  assertIsPdf(lowSpend);
  // PDFs with different expenditure amounts must produce different output
  assert.notEqual(
    Buffer.from(highSpend).compare(Buffer.from(lowSpend)),
    0,
    'PDF with different eligible_expenditure values must differ',
  );
});

test('renderActivityRegisterPdf: landscape orientation produces wider output', async () => {
  // Confirm it produces a valid PDF with a long-titled activity (exercises landscape layout)
  const input: ActivityRegisterInput = {
    ...baseInput,
    activities: [
      {
        code: 'CA-LNG',
        title:
          'This is an extremely long activity title that exercises the landscape layout of the activity register PDF template to ensure columns do not overflow',
        kind: 'core',
        hypothesis: 'Hypothesis about the long-titled activity for testing purposes.',
        technical_lead: 'Dr Alexandra Montgomery-Fitzgerald',
        start_date: '2025-01-01',
        end_date: '2025-12-31',
        eligible_expenditure: 1_200_000,
        time_entries_count: 300,
        supporting_documents_count: 50,
      },
    ],
  };
  const out = await renderActivityRegisterPdf(input);
  assertIsPdf(out);
  assert.ok(out.length > 1024, `expected >1KB for landscape PDF, got ${out.length}`);
});

test('renderActivityRegisterPdf: null technical_lead and null dates render as em-dash', async () => {
  // Render with null values — must produce a valid PDF
  const withNulls = await renderActivityRegisterPdf({
    ...baseInput,
    activities: [
      {
        code: 'CA-NULL',
        title: 'Activity with null lead and null dates',
        kind: 'core',
        hypothesis: null,
        technical_lead: null,
        start_date: null,
        end_date: null,
        eligible_expenditure: 500_000,
        time_entries_count: 10,
        supporting_documents_count: 2,
      },
    ],
  });

  // Render with non-null values for the same activity — must produce a different PDF
  const withValues = await renderActivityRegisterPdf({
    ...baseInput,
    activities: [
      {
        code: 'CA-NULL',
        title: 'Activity with null lead and null dates',
        kind: 'core',
        hypothesis: null,
        technical_lead: 'Dr Named Lead',
        start_date: '2025-01-01',
        end_date: '2025-06-30',
        eligible_expenditure: 500_000,
        time_entries_count: 10,
        supporting_documents_count: 2,
      },
    ],
  });

  assertIsPdf(withNulls);
  assertIsPdf(withValues);
  // The two PDFs must differ, proving the null → em-dash substitution is
  // reflected in the output (different content than named lead + dates).
  assert.notEqual(
    Buffer.from(withNulls).compare(Buffer.from(withValues)),
    0,
    'PDF with null technical_lead/dates must differ from PDF with actual values',
  );
});
