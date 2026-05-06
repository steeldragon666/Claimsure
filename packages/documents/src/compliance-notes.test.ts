import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderComplianceNotesPdf, type ComplianceNotesInput } from './compliance-notes.js';

/**
 * Tests for renderComplianceNotesPdf — pure-function rendering.
 *
 * The PDF buffer is opaque (compressed binary), so assertions are
 * structural rather than visual:
 *   - magic bytes (`%PDF`) confirm a real PDF was emitted
 *   - empty-state paths render without throwing
 *   - determinism: changing generated_at affects output
 *   - null reviewer fields render without throwing
 *   - resolved note with resolution_note renders without throwing
 *   - all severity levels render without throwing
 */

const CLAIM_ID = '00000000-0000-4000-8000-000f40000009';

const baseNote = {
  id: 'note-001',
  section: 's355-25(1)(a)',
  note_text:
    'The activity description lacks sufficient technical detail to demonstrate experimental uncertainty.',
  severity: 'high' as const,
  activity_codes: ['CA-001', 'CA-002'],
  resolved: false,
  resolution_note: null,
};

const baseInput: ComplianceNotesInput = {
  firm: { name: 'Test Firm Pty Ltd', abn: '12 345 678 901' },
  subject_tenant: { name: 'Acme Research Co', abn: '98 765 432 109' },
  claim: { id: CLAIM_ID, fy_year: 2025 },
  generated_at: '2025-07-01T12:00:00Z',
  content_hash_hex: 'd'.repeat(64),
  generator_version: '1.0.0',
  compliance_notes: [
    baseNote,
    {
      id: 'note-002',
      section: 's355-35',
      note_text: 'Supporting activity does not meet the nexus requirement.',
      severity: 'medium' as const,
      activity_codes: ['SA-001'],
      resolved: true,
      resolution_note: 'Nexus documentation updated in addendum 3.',
    },
  ],
  reviewer_name: 'Jane Smith',
  reviewed_at: '2025-07-15T09:00:00Z',
};

const PDF_MAGIC = Buffer.from('%PDF', 'ascii');

function assertIsPdf(bytes: Uint8Array): void {
  assert.ok(bytes.length > 0, 'PDF byte length must be positive');
  const head = Buffer.from(bytes.slice(0, 4));
  assert.ok(head.equals(PDF_MAGIC), `Expected %PDF magic header, got ${head.toString('utf8')}`);
}

test('renderComplianceNotesPdf: produces a valid PDF (magic bytes %PDF)', async () => {
  const result = await renderComplianceNotesPdf(baseInput);
  assertIsPdf(result);
  assert.ok(result.length > 1024, `expected >1KB, got ${result.length}`);
  assert.ok(result.length < 400_000, `expected <400KB, got ${result.length}`);
});

test('renderComplianceNotesPdf: empty compliance_notes renders without throwing', async () => {
  const input: ComplianceNotesInput = {
    ...baseInput,
    compliance_notes: [],
  };
  const out = await renderComplianceNotesPdf(input);
  assertIsPdf(out);
});

test('renderComplianceNotesPdf: changing generated_at affects output', async () => {
  const a = await renderComplianceNotesPdf(baseInput);
  const b = await renderComplianceNotesPdf({
    ...baseInput,
    generated_at: '2099-12-31T23:59:59.000Z',
  });
  assert.notEqual(
    Buffer.from(a).compare(Buffer.from(b)),
    0,
    'Two PDFs with different timestamps must differ',
  );
});

test('renderComplianceNotesPdf: null reviewer_name and null reviewed_at render without throwing', async () => {
  const input: ComplianceNotesInput = {
    ...baseInput,
    reviewer_name: null,
    reviewed_at: null,
  };
  const out = await renderComplianceNotesPdf(input);
  assertIsPdf(out);
});

test('renderComplianceNotesPdf: resolved note with resolution_note renders without throwing', async () => {
  const input: ComplianceNotesInput = {
    ...baseInput,
    compliance_notes: [
      {
        id: 'note-resolved',
        section: 's355-25(1)(b)',
        note_text: 'Risk of systematic investigation not clearly documented.',
        severity: 'high' as const,
        activity_codes: ['CA-003'],
        resolved: true,
        resolution_note:
          'Experimental logs and lab notebooks submitted as evidence items EV-012 and EV-013.',
      },
    ],
  };
  const out = await renderComplianceNotesPdf(input);
  assertIsPdf(out);
});

test('renderComplianceNotesPdf: all severity levels render without throwing', async () => {
  const input: ComplianceNotesInput = {
    ...baseInput,
    compliance_notes: [
      {
        id: 'note-critical',
        section: 's355-25(1)(a)',
        note_text:
          'Activity fails the core R&D definition — no experimental uncertainty identified.',
        severity: 'critical' as const,
        activity_codes: ['CA-001'],
        resolved: false,
        resolution_note: null,
      },
      {
        id: 'note-high',
        section: 's355-25(1)(b)',
        note_text: 'Hypothesis not clearly stated in project documentation.',
        severity: 'high' as const,
        activity_codes: ['CA-002'],
        resolved: false,
        resolution_note: null,
      },
      {
        id: 'note-medium',
        section: 's355-35',
        note_text: 'Nexus between supporting and core activity is weak.',
        severity: 'medium' as const,
        activity_codes: [],
        resolved: false,
        resolution_note: null,
      },
      {
        id: 'note-low',
        section: 's355-45',
        note_text: 'Minor formatting inconsistency in expenditure records.',
        severity: 'low' as const,
        activity_codes: ['SA-001', 'SA-002'],
        resolved: true,
        resolution_note: 'Formatting corrected.',
      },
      {
        id: 'note-info',
        section: 's355-25(1)(a)',
        note_text: 'Consider including additional contemporaneous records for completeness.',
        severity: 'info' as const,
        activity_codes: [],
        resolved: false,
        resolution_note: null,
      },
    ],
  };
  const out = await renderComplianceNotesPdf(input);
  assertIsPdf(out);
  assert.ok(out.length > 1024, `expected >1KB for all-severity PDF, got ${out.length}`);
});
