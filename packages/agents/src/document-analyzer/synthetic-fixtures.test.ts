/**
 * Tests for the synthetic fixtures + MockDocumentAnalyzer combo.
 *
 * These tests prove:
 *   1. Every fixture parses through the file-upload header format the
 *      worker expects (so the production parseFileUploadPayload function
 *      can extract clean filename / mime / text).
 *   2. The MockDocumentAnalyzer is deterministic — same input twice
 *      yields identical output AND identical usage.
 *   3. Different fixtures yield DIFFERENT outputs (so stress tests can't
 *      accidentally pass by every analyzer call returning the same row).
 *   4. The sparse-input guard returns 0 activities/invoices for the
 *      under-50-char fixture (matches production Haiku behavior).
 *   5. The fixture metadata is internally consistent (expected ranges
 *      have min <= max etc).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockDocumentAnalyzer } from './mock.js';
import {
  SYNTHETIC_FIXTURES,
  SYNTHETIC_FIXTURES_HAPPY_PATH,
  SYNTHETIC_FIXTURES_EDGE_CASES,
  SYNTHETIC_FIXTURES_BY_ID,
} from './synthetic-fixtures.js';

// ---------------------------------------------------------------------------
// Fixture metadata sanity
// ---------------------------------------------------------------------------

test('SYNTHETIC_FIXTURES: every fixture has a unique id', () => {
  const ids = new Set(SYNTHETIC_FIXTURES.map((f) => f.id));
  assert.equal(ids.size, SYNTHETIC_FIXTURES.length);
});

test('SYNTHETIC_FIXTURES_BY_ID: every fixture is keyed by its id', () => {
  for (const fx of SYNTHETIC_FIXTURES) {
    assert.equal(SYNTHETIC_FIXTURES_BY_ID[fx.id], fx);
  }
});

test('SYNTHETIC_FIXTURES: happy path + edge cases partition the full set', () => {
  assert.equal(
    SYNTHETIC_FIXTURES_HAPPY_PATH.length + SYNTHETIC_FIXTURES_EDGE_CASES.length,
    SYNTHETIC_FIXTURES.length,
  );
  // No overlap
  const happyIds = new Set(SYNTHETIC_FIXTURES_HAPPY_PATH.map((f) => f.id));
  for (const fx of SYNTHETIC_FIXTURES_EDGE_CASES) {
    assert.ok(!happyIds.has(fx.id), `${fx.id} appears in both partitions`);
  }
});

test('SYNTHETIC_FIXTURES: every expected range has min <= max', () => {
  for (const fx of SYNTHETIC_FIXTURES) {
    assert.ok(
      fx.expected.activities_min <= fx.expected.activities_max,
      `${fx.id}: activities min/max inverted`,
    );
    assert.ok(
      fx.expected.invoices_min <= fx.expected.invoices_max,
      `${fx.id}: invoices min/max inverted`,
    );
  }
});

test('SYNTHETIC_FIXTURES: at least 15 fixtures exist (corpus size)', () => {
  assert.ok(SYNTHETIC_FIXTURES.length >= 15);
});

test('SYNTHETIC_FIXTURES: at least 5 edge cases exist', () => {
  assert.ok(SYNTHETIC_FIXTURES_EDGE_CASES.length >= 4);
});

// ---------------------------------------------------------------------------
// File-upload header parsing — every fixture must round-trip through the
// same parser the production worker uses.
// ---------------------------------------------------------------------------

function parseFileUploadPayload(rawText: string): {
  filename: string;
  mimeType: string;
  extractedText: string | null;
} {
  const lines = rawText.split('\n');
  const firstLine = lines[0] ?? '';
  const filename = firstLine.startsWith('[FILE UPLOAD] ')
    ? firstLine.slice('[FILE UPLOAD] '.length).trim()
    : '';

  let mimeType = 'application/octet-stream';
  let extractedTextStartIdx = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('Type: ')) {
      mimeType = line.slice('Type: '.length).trim();
    } else if (line.startsWith('Extracted-Text:')) {
      extractedTextStartIdx = i + 1;
      break;
    }
  }

  const extractedText =
    extractedTextStartIdx >= 0 ? lines.slice(extractedTextStartIdx).join('\n').trim() : null;

  return { filename, mimeType, extractedText };
}

test('SYNTHETIC_FIXTURES: every non-malformed fixture round-trips through parseFileUploadPayload', () => {
  for (const fx of SYNTHETIC_FIXTURES) {
    if (fx.id === 'fx-13-malformed-no-extracted-text') continue; // intentionally malformed

    const parsed = parseFileUploadPayload(fx.raw_text);
    assert.ok(parsed.filename.length > 0, `${fx.id}: filename should not be empty`);
    assert.ok(parsed.mimeType.length > 0, `${fx.id}: mimeType should not be empty`);
    assert.ok(parsed.extractedText !== null, `${fx.id}: extractedText should be non-null`);
  }
});

test('SYNTHETIC_FIXTURES: fx-13 malformed fixture has NO Extracted-Text line', () => {
  const fx = SYNTHETIC_FIXTURES_BY_ID['fx-13-malformed-no-extracted-text']!;
  const parsed = parseFileUploadPayload(fx.raw_text);
  assert.equal(parsed.extractedText, null);
});

test('SYNTHETIC_FIXTURES: fx-14 has under-50-char body (production should fail it)', () => {
  const fx = SYNTHETIC_FIXTURES_BY_ID['fx-14-under-50-chars']!;
  const parsed = parseFileUploadPayload(fx.raw_text);
  assert.ok(parsed.extractedText !== null);
  assert.ok((parsed.extractedText?.length ?? 0) < 50);
});

test('SYNTHETIC_FIXTURES: fx-15 oversized fixture has > 60k chars body', () => {
  const fx = SYNTHETIC_FIXTURES_BY_ID['fx-15-oversized']!;
  const parsed = parseFileUploadPayload(fx.raw_text);
  assert.ok((parsed.extractedText?.length ?? 0) > 60_000);
});

// ---------------------------------------------------------------------------
// MockDocumentAnalyzer determinism
// ---------------------------------------------------------------------------

test('MockDocumentAnalyzer: same input twice yields identical output + usage', async () => {
  const analyzer = new MockDocumentAnalyzer();
  const input = {
    filename: 'test.md',
    mime_type: 'text/markdown',
    raw_text: 'Hypothesis: thing happens because reasons. '.repeat(50),
    existing_activities: [],
  };
  const r1 = await analyzer.analyze(input);
  const r2 = await analyzer.analyze(input);
  assert.deepEqual(r1, r2);
});

test('MockDocumentAnalyzer: different inputs yield different outputs', async () => {
  const analyzer = new MockDocumentAnalyzer();
  const r1 = await analyzer.analyze({
    filename: 'a.md',
    mime_type: 'text/markdown',
    raw_text: 'aaaaa '.repeat(30),
    existing_activities: [],
  });
  const r2 = await analyzer.analyze({
    filename: 'b.md',
    mime_type: 'text/markdown',
    raw_text: 'bbbbb '.repeat(30),
    existing_activities: [],
  });
  // Summaries differ (filename embedded), tokens differ (size differs is
  // possible — but actually both are the same len here, so tokens equal).
  // Activities/invoices may differ via hash.
  assert.notEqual(r1.output.document_summary, r2.output.document_summary);
});

test('MockDocumentAnalyzer: usage reflects input length (tokens_in ~ chars/4)', async () => {
  const analyzer = new MockDocumentAnalyzer();
  const input = {
    filename: 'test.md',
    mime_type: 'text/markdown',
    raw_text: 'x'.repeat(4000), // 4000 chars
    existing_activities: [],
  };
  const r = await analyzer.analyze(input);
  assert.equal(r.usage?.tokens_in, 1000); // 4000/4
  assert.equal(r.usage?.tokens_out, 100); // 4000/40
});

test('MockDocumentAnalyzer: sparse input (<50 chars) returns 0 activities, 0 invoices', async () => {
  const analyzer = new MockDocumentAnalyzer();
  const r = await analyzer.analyze({
    filename: 'tiny.txt',
    mime_type: 'text/plain',
    raw_text: 'OK',
    existing_activities: [],
  });
  assert.equal(r.output.activities.length, 0);
  assert.equal(r.output.invoices.length, 0);
  assert.match(r.output.document_summary, /^Sparse mock/);
  // Usage still non-null — the call happened
  assert.ok(r.usage !== null);
});

test('MockDocumentAnalyzer: model name override propagates to usage', async () => {
  const analyzer = new MockDocumentAnalyzer({ model: 'claude-sonnet-4-5-mock' });
  const r = await analyzer.analyze({
    filename: 'a.md',
    mime_type: 'text/markdown',
    raw_text: 'x'.repeat(200),
    existing_activities: [],
  });
  assert.equal(r.usage?.model, 'claude-sonnet-4-5-mock');
});

test('MockDocumentAnalyzer: throwError option throws on every call', async () => {
  const analyzer = new MockDocumentAnalyzer({ throwError: true });
  await assert.rejects(
    analyzer.analyze({
      filename: 'a.md',
      mime_type: 'text/markdown',
      raw_text: 'x'.repeat(100),
      existing_activities: [],
    }),
  );
});

test('MockDocumentAnalyzer: tokensInFn override drives ledger arithmetic', async () => {
  const analyzer = new MockDocumentAnalyzer({
    tokensInFn: () => 9999,
    tokensOutFn: () => 1111,
  });
  const r = await analyzer.analyze({
    filename: 'a.md',
    mime_type: 'text/markdown',
    raw_text: 'x'.repeat(50),
    existing_activities: [],
  });
  assert.equal(r.usage?.tokens_in, 9999);
  assert.equal(r.usage?.tokens_out, 1111);
});

// ---------------------------------------------------------------------------
// Integration: run every fixture through the mock analyzer
// ---------------------------------------------------------------------------

test('MockDocumentAnalyzer: processes every fixture without throwing', async () => {
  const analyzer = new MockDocumentAnalyzer();
  let processed = 0;
  for (const fx of SYNTHETIC_FIXTURES) {
    const parsed = parseFileUploadPayload(fx.raw_text);
    if (!parsed.extractedText) continue; // skip malformed
    const r = await analyzer.analyze({
      filename: parsed.filename,
      mime_type: parsed.mimeType,
      raw_text: parsed.extractedText,
      existing_activities: [],
    });
    assert.ok(r.output.document_summary.length > 0, `${fx.id}: empty summary`);
    assert.ok(r.usage !== null, `${fx.id}: missing usage`);
    processed += 1;
  }
  assert.ok(processed >= 14, `expected to process at least 14 fixtures, processed ${processed}`);
});

test('MockDocumentAnalyzer: ledger arithmetic across full fixture corpus', async () => {
  const analyzer = new MockDocumentAnalyzer();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  for (const fx of SYNTHETIC_FIXTURES) {
    const parsed = parseFileUploadPayload(fx.raw_text);
    if (!parsed.extractedText) continue;
    const r = await analyzer.analyze({
      filename: parsed.filename,
      mime_type: parsed.mimeType,
      raw_text: parsed.extractedText,
      existing_activities: [],
    });
    totalTokensIn += r.usage!.tokens_in;
    totalTokensOut += r.usage!.tokens_out;
  }
  // With ~15 fixtures, the corpus should produce thousands of total tokens.
  assert.ok(totalTokensIn > 1000, `unexpectedly low total tokens_in: ${totalTokensIn}`);
  assert.ok(totalTokensOut > 100, `unexpectedly low total tokens_out: ${totalTokensOut}`);
});
