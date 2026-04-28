import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderActivityApplicationPdf,
  type ActivityApplicationInput,
} from './activity-application.js';

/**
 * Pure-function tests for the activity application PDF generator (T-A8).
 *
 * @react-pdf produces an opaque PDF byte stream — we don't introspect
 * the internals (no test-side dep on pdfkit / pdf.js). Instead we lock
 * in the externally-observable contract:
 *   - returns a non-empty Uint8Array
 *   - starts with the `%PDF-` magic bytes (every valid PDF does)
 *   - renders all the spec-mandated input variants without throwing
 *
 * If a future change wants to assert text content (e.g. that the firm
 * name appears on page 1), we'll add a pdf-parse dev dep and a single
 * regression test then. For now the surface contract is enough — the
 * PDF layout is also exercised by manual review during PR.
 */

const PDF_MAGIC = '%PDF-';

function baseInput(): ActivityApplicationInput {
  return {
    firm: { name: 'Acme Tax Advisors', abn: '12 345 678 901' },
    subject_tenant: { name: 'BioReactor Co Pty Ltd', abn: '98 765 432 109' },
    project: {
      name: 'Continuous catalyst run #4',
      description: 'Investigate degradation pathways in the catalyst stack.',
      started_at: '2026-01-15T00:00:00Z',
      ended_at: null,
    },
    claim: { fiscal_year: 2027, stage: 'narrative_drafting' },
    activity: {
      code: 'CA-001',
      title: 'Catalyst longevity hypothesis testing',
      kind: 'CORE',
      description:
        'Bench-test the proprietary catalyst formulation against the 200-hour lifespan hypothesis.',
      objective: 'Establish whether the catalyst meets the 200-hour design target.',
      hypothesis: 'The catalyst will retain >85% activity at 200 hours.',
      technical_uncertainty:
        'No published longevity data for this catalyst class at our operating temperature.',
      new_knowledge:
        'Confirmed degradation mechanism is sintering-driven, not ligand loss as expected.',
      activity_started_at: '2026-02-01T00:00:00Z',
      activity_ended_at: null,
    },
    artefacts: [
      {
        kind: 'media',
        title: 'Bench setup photo',
        uri: null,
        linked_at: '2026-02-05T10:00:00Z',
        reason: 'baseline configuration',
      },
      {
        kind: 'expenditure',
        title: 'INV-2026-0042 — catalyst supplier invoice',
        uri: null,
        linked_at: '2026-02-12T14:30:00Z',
        reason: null,
      },
    ],
    uncertainty_events: [
      {
        kind: 'HYPOTHESIS',
        captured_at: '2026-02-01T09:00:00Z',
        summary: 'Catalyst will retain >85% activity at 200 hours.',
        classification: { confidence: 0.92, rationale: 'Direct match to hypothesis kind.' },
      },
      {
        kind: 'OBSERVATION',
        captured_at: '2026-02-15T16:00:00Z',
        summary: 'Activity dropped to 73% by hour 150 — unexpected.',
        classification: { confidence: 0.81, rationale: 'Quantitative measurement note.' },
      },
    ],
    generated_at: '2026-04-29T12:00:00Z',
  };
}

function asciiPrefix(buf: Uint8Array, n: number): string {
  return Buffer.from(buf.subarray(0, n)).toString('utf8');
}

test('renderActivityApplicationPdf: produces a valid PDF for a complete input', async () => {
  const buf = await renderActivityApplicationPdf(baseInput());
  assert.ok(buf instanceof Uint8Array, 'returns a Uint8Array');
  assert.ok(buf.byteLength > 1000, `PDF should be at least 1KB; got ${buf.byteLength}`);
  assert.equal(asciiPrefix(buf, 5), PDF_MAGIC, 'starts with %PDF- magic bytes');
  // Every PDF ends with %%EOF (possibly followed by a newline).
  const trailer = Buffer.from(buf.subarray(buf.byteLength - 16)).toString('utf8');
  assert.ok(trailer.includes('%%EOF'), `trailer should contain %%EOF; got: ${trailer}`);
});

test('renderActivityApplicationPdf: renders empty-artefacts input (empty-state path)', async () => {
  const input = baseInput();
  input.artefacts = [];
  input.uncertainty_events = [];
  const buf = await renderActivityApplicationPdf(input);
  assert.ok(buf.byteLength > 1000);
  assert.equal(asciiPrefix(buf, 5), PDF_MAGIC);
});

test('renderActivityApplicationPdf: renders narrative with all-null fields (placeholder path)', async () => {
  const input = baseInput();
  input.activity.description = null;
  input.activity.objective = null;
  input.activity.hypothesis = null;
  input.activity.technical_uncertainty = null;
  input.activity.new_knowledge = null;
  input.project.description = null;
  input.activity.activity_started_at = null;
  input.activity.activity_ended_at = null;
  input.firm.abn = null;
  input.subject_tenant.abn = null;
  const buf = await renderActivityApplicationPdf(input);
  assert.ok(buf.byteLength > 800);
  assert.equal(asciiPrefix(buf, 5), PDF_MAGIC);
});

test('renderActivityApplicationPdf: renders very long narrative (multi-page path)', async () => {
  const input = baseInput();
  // ~40k characters of narrative. @react-pdf will wrap and overflow to
  // additional pages; the renderer's footer Text component uses
  // `render={({ totalPages })}` which only resolves once the doc has
  // overflowed, so this exercises the multi-page code path.
  const para =
    'The team observed several anomalies during the experimental campaign that warranted deeper investigation. ';
  const longText = para.repeat(400);
  input.activity.description = longText;
  input.activity.hypothesis = longText;
  input.activity.technical_uncertainty = longText;
  // Stuff the artefacts too so the table page-breaks.
  input.artefacts = Array.from({ length: 60 }, (_, i) => ({
    kind: 'media',
    title: `Long-input artefact ${i + 1}`,
    uri: null,
    linked_at: '2026-02-05T10:00:00Z',
    reason: i % 3 === 0 ? `reason ${i}` : null,
  }));
  const buf = await renderActivityApplicationPdf(input);
  assert.ok(
    buf.byteLength > 5000,
    `multi-page PDF should be substantially larger than single-page; got ${buf.byteLength}`,
  );
  assert.equal(asciiPrefix(buf, 5), PDF_MAGIC);
  // Approximation for "more than one page": the PDF should contain
  // multiple "/Type /Page" markers (one per page object).
  const haystack = Buffer.from(buf).toString('latin1');
  const pageMarkerCount = (haystack.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  assert.ok(
    pageMarkerCount >= 2,
    `expected >=2 page objects in long-narrative PDF; got ${pageMarkerCount}`,
  );
});

test('renderActivityApplicationPdf: different generated_at produces different bytes', async () => {
  // The generated_at timestamp is rendered into the header AND footer of
  // every page, so changing it MUST change the PDF bytes. This locks in
  // that the footer attribution is actually included (rather than being
  // silently dropped by a layout misconfiguration).
  const a = await renderActivityApplicationPdf({
    ...baseInput(),
    generated_at: '2026-04-29T12:00:00Z',
  });
  const b = await renderActivityApplicationPdf({
    ...baseInput(),
    generated_at: '2026-04-29T18:30:00Z',
  });
  assert.equal(asciiPrefix(a, 5), PDF_MAGIC);
  assert.equal(asciiPrefix(b, 5), PDF_MAGIC);
  // Compare a window large enough to include the rendered timestamp text
  // even after PDF stream framing — if the bytes are identical the
  // timestamp wasn't actually rendered into the document.
  assert.notEqual(
    Buffer.from(a).toString('latin1'),
    Buffer.from(b).toString('latin1'),
    'PDFs with different generated_at should produce different bytes',
  );
});

test('renderActivityApplicationPdf: SUPPORTING activity kind chip renders', async () => {
  const input = baseInput();
  input.activity.kind = 'SUPPORTING';
  input.activity.code = 'SA-002';
  const buf = await renderActivityApplicationPdf(input);
  assert.ok(buf.byteLength > 1000);
  assert.equal(asciiPrefix(buf, 5), PDF_MAGIC);
});

test('renderActivityApplicationPdf: uncertainty events without classification render', async () => {
  // The classification block on each register entry is optional — exercise
  // the null branch so the layout doesn't crash on bare-summary rows.
  const input = baseInput();
  input.uncertainty_events = [
    {
      kind: 'UNCERTAINTY',
      captured_at: '2026-03-01T08:00:00Z',
      summary: 'No idea why the run aborted at hour 47.',
      classification: null,
    },
    {
      kind: 'EXPERIMENT',
      captured_at: '2026-03-02T08:00:00Z',
      summary: 'Restart attempt with revised purge sequence.',
    },
  ];
  const buf = await renderActivityApplicationPdf(input);
  assert.ok(buf.byteLength > 1000);
  assert.equal(asciiPrefix(buf, 5), PDF_MAGIC);
});
