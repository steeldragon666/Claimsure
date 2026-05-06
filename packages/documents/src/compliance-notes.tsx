import { Document, Page, View, Text, StyleSheet, pdf } from '@react-pdf/renderer';

/**
 * Compliance Notes PDF (F.9).
 *
 * A forensic, regulator-facing document listing all compliance notes raised
 * against an R&D Tax Incentive claim, grouped by legislative section and
 * ordered by severity (critical → info).
 *
 * Design tokens (Sprint F, matching executive-summary.tsx):
 *   - Page background:  cream   #FAF8F3
 *   - Primary text:     ink     #1A1814
 *   - Accent/headings:  patina  #5C7A6B
 *   - Fonts: Helvetica-Bold for headings, Helvetica for body
 *
 * Forensic header (every page, fixed):
 *   Claim: {id} | FY{year} | Generated: {iso} | Hash: {hex[:12]}… | v{ver}
 *
 * Orientation: portrait A4 (default — no orientation prop).
 * Standalone <Document><Page> — no DocumentLayout wrapper.
 */

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface ComplianceNotesInput {
  firm: { name: string; abn: string | null };
  subject_tenant: { name: string; abn: string | null };
  claim: { id: string; fy_year: number };
  generated_at: string; // ISO timestamp
  content_hash_hex: string; // 64 hex chars (sha256)
  generator_version: string; // e.g. "1.0.0"
  compliance_notes: Array<{
    id: string;
    section: string; // e.g. "s355-25(1)(a)", "s355-35"
    note_text: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    activity_codes: string[]; // may be empty
    resolved: boolean;
    resolution_note: string | null;
  }>;
  reviewer_name: string | null;
  reviewed_at: string | null; // ISO timestamp
}

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const COLOR_CREAM = '#FAF8F3';
const COLOR_INK = '#1A1814';
const COLOR_PATINA = '#5C7A6B';
const COLOR_MUTED = '#666666';
const COLOR_BORDER = '#cccccc';
const COLOR_TROW_BORDER = '#e0e8e4';
const COLOR_RESOLUTION_BG = '#F5F5F0';

const COLOR_CRITICAL = '#7f1d1d';
const COLOR_HIGH = '#b91c1c';
const COLOR_MEDIUM = '#b45309';
const COLOR_LOW = '#166534';
const COLOR_INFO = '#1e40af';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  page: {
    padding: 40,
    paddingTop: 56,
    paddingBottom: 60,
    fontFamily: 'Helvetica',
    fontSize: 10,
    backgroundColor: COLOR_CREAM,
    color: COLOR_INK,
  },

  // Forensic header (fixed, top of every page).
  forensicHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: COLOR_PATINA,
    paddingHorizontal: 40,
    paddingVertical: 5,
    flexDirection: 'row',
  },
  forensicHeaderText: {
    fontSize: 7,
    color: '#FFFFFF',
    fontFamily: 'Helvetica',
    flex: 1,
  },

  // Title / cover block.
  titleBlock: {
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLOR_PATINA,
    paddingBottom: 8,
  },
  firmLine: { fontSize: 9, color: COLOR_MUTED },
  title: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    marginTop: 4,
    color: COLOR_PATINA,
  },
  subtitle: { fontSize: 9, color: COLOR_MUTED, marginTop: 4 },

  // Claim identity sub-block inside the title block.
  claimMetaRow: { flexDirection: 'row', marginTop: 6 },
  claimMetaLabel: { width: 120, color: COLOR_MUTED, fontSize: 9 },
  claimMetaValue: { flex: 1, fontSize: 9, color: COLOR_INK },

  // Section headings.
  sectionHeading: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    marginTop: 14,
    marginBottom: 6,
    color: COLOR_PATINA,
  },

  // Legislative section sub-heading (within notes section).
  legislativeHeading: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    marginTop: 10,
    marginBottom: 4,
    color: COLOR_INK,
    backgroundColor: '#EEF2EF',
    padding: 4,
    borderRadius: 2,
  },

  // Generic meta key-value box.
  metaBox: {
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    padding: 10,
    borderRadius: 2,
  },
  metaRow: { flexDirection: 'row', marginBottom: 4 },
  metaLabel: { width: 160, color: COLOR_MUTED },
  metaValue: { flex: 1, color: COLOR_INK },

  // Summary counts row.
  countsRow: { flexDirection: 'row', marginBottom: 8, gap: 8 },
  countBox: {
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    borderRadius: 4,
    padding: 6,
    flex: 1,
    alignItems: 'center',
  },
  countValue: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: COLOR_PATINA,
  },
  countLabel: { fontSize: 7, color: COLOR_MUTED, marginTop: 2 },

  // Individual compliance note card.
  noteCard: {
    borderWidth: 1,
    borderColor: COLOR_TROW_BORDER,
    borderRadius: 2,
    marginBottom: 6,
    padding: 8,
  },
  noteRow: { flexDirection: 'row', marginBottom: 4, alignItems: 'flex-start' },
  noteMetaLabel: { width: 100, color: COLOR_MUTED, fontSize: 9 },
  noteMetaValue: { flex: 1, fontSize: 9, color: COLOR_INK },

  noteText: { fontSize: 9, color: COLOR_INK, lineHeight: 1.5, marginBottom: 6 },

  // Severity chips.
  severityChip: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    borderRadius: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  severityCritical: { color: COLOR_CRITICAL },
  severityHigh: { color: COLOR_HIGH },
  severityMedium: { color: COLOR_MEDIUM },
  severityLow: { color: COLOR_LOW },
  severityInfo: { color: COLOR_INFO },

  // Resolution status.
  resolvedText: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: COLOR_LOW,
  },
  openText: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: COLOR_MUTED,
  },

  // Resolution note box (left-border accent, muted background).
  resolutionBox: {
    borderLeftWidth: 3,
    borderLeftColor: COLOR_PATINA,
    backgroundColor: COLOR_RESOLUTION_BG,
    padding: 6,
    marginTop: 4,
    borderRadius: 2,
  },
  resolutionText: {
    fontSize: 8,
    color: COLOR_MUTED,
    lineHeight: 1.5,
  },

  // Sign-off block.
  signOffBlock: {
    marginTop: 20,
    borderTopWidth: 1,
    borderTopColor: COLOR_PATINA,
    paddingTop: 10,
  },
  signOffHeading: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: COLOR_PATINA,
    marginBottom: 6,
  },
  signOffRow: { flexDirection: 'row', marginBottom: 4 },
  signOffLabel: { width: 120, color: COLOR_MUTED, fontSize: 9 },
  signOffValue: { flex: 1, fontSize: 9, color: COLOR_INK },
  awaitingText: { fontSize: 9, color: COLOR_MUTED },

  // Per-page footer.
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: COLOR_BORDER,
    paddingTop: 6,
    fontSize: 8,
    color: COLOR_MUTED,
    textAlign: 'center',
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Array<ComplianceNotesInput['compliance_notes'][number]['severity']> = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

function severityLabel(
  severity: ComplianceNotesInput['compliance_notes'][number]['severity'],
): string {
  return severity.toUpperCase();
}

type NoteStyle =
  | typeof styles.severityCritical
  | typeof styles.severityHigh
  | typeof styles.severityMedium
  | typeof styles.severityLow
  | typeof styles.severityInfo;

function severityStyle(
  severity: ComplianceNotesInput['compliance_notes'][number]['severity'],
): NoteStyle {
  switch (severity) {
    case 'critical':
      return styles.severityCritical;
    case 'high':
      return styles.severityHigh;
    case 'medium':
      return styles.severityMedium;
    case 'low':
      return styles.severityLow;
    case 'info':
      return styles.severityInfo;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ForensicHeader(props: { input: ComplianceNotesInput }): React.ReactElement {
  const { claim, generated_at, content_hash_hex, generator_version } = props.input;
  const hashChip = `${content_hash_hex.slice(0, 12)}\u2026`;
  const text =
    `Claim: ${claim.id} | FY${claim.fy_year} | ` +
    `Generated: ${generated_at} | Hash: ${hashChip} | v${generator_version}`;
  return (
    <View style={styles.forensicHeader} fixed>
      <Text style={styles.forensicHeaderText}>{text}</Text>
    </View>
  );
}

function TitleBlock(props: { input: ComplianceNotesInput }): React.ReactElement {
  const { firm, subject_tenant, claim, generated_at, reviewer_name, reviewed_at } = props.input;
  const firmLine = firm.abn ? `${firm.name} \u00B7 ABN ${firm.abn}` : firm.name;
  const claimantLine = subject_tenant.abn
    ? `${subject_tenant.name} \u00B7 ABN ${subject_tenant.abn}`
    : subject_tenant.name;
  const shortId = claim.id.slice(-8);
  const reviewerDisplay = reviewer_name ?? 'Unreviewed';
  const reviewedDisplay = reviewed_at ? formatDate(reviewed_at) : 'Pending';

  return (
    <View style={styles.titleBlock}>
      <Text style={styles.firmLine}>{firmLine}</Text>
      <Text style={styles.title}>
        R&amp;D Tax Incentive \u2014 Compliance Notes, FY{claim.fy_year}
      </Text>
      <Text style={styles.subtitle}>Generated {generated_at}</Text>
      <View style={styles.claimMetaRow}>
        <Text style={styles.claimMetaLabel}>Claimant</Text>
        <Text style={styles.claimMetaValue}>{claimantLine}</Text>
      </View>
      <View style={styles.claimMetaRow}>
        <Text style={styles.claimMetaLabel}>Claim ID</Text>
        <Text style={styles.claimMetaValue}>\u2026{shortId}</Text>
      </View>
      <View style={styles.claimMetaRow}>
        <Text style={styles.claimMetaLabel}>Reviewer</Text>
        <Text style={styles.claimMetaValue}>{reviewerDisplay}</Text>
      </View>
      <View style={styles.claimMetaRow}>
        <Text style={styles.claimMetaLabel}>Reviewed</Text>
        <Text style={styles.claimMetaValue}>{reviewedDisplay}</Text>
      </View>
    </View>
  );
}

function SummarySection(props: { input: ComplianceNotesInput }): React.ReactElement {
  const { compliance_notes: notes } = props.input;

  const total = notes.length;
  const resolved = notes.filter((n) => n.resolved).length;

  const counts: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const note of notes) {
    counts[note.severity] = (counts[note.severity] ?? 0) + 1;
  }

  return (
    <View>
      <Text style={styles.sectionHeading}>Summary</Text>
      <View style={styles.countsRow}>
        <View style={styles.countBox}>
          <Text style={styles.countValue}>{total}</Text>
          <Text style={styles.countLabel}>Total Notes</Text>
        </View>
        <View style={styles.countBox}>
          <Text style={[styles.countValue, { color: COLOR_CRITICAL }]}>{counts['critical']}</Text>
          <Text style={styles.countLabel}>Critical</Text>
        </View>
        <View style={styles.countBox}>
          <Text style={[styles.countValue, { color: COLOR_HIGH }]}>{counts['high']}</Text>
          <Text style={styles.countLabel}>High</Text>
        </View>
        <View style={styles.countBox}>
          <Text style={[styles.countValue, { color: COLOR_MEDIUM }]}>{counts['medium']}</Text>
          <Text style={styles.countLabel}>Medium</Text>
        </View>
        <View style={styles.countBox}>
          <Text style={[styles.countValue, { color: COLOR_LOW }]}>{counts['low']}</Text>
          <Text style={styles.countLabel}>Low</Text>
        </View>
        <View style={styles.countBox}>
          <Text style={[styles.countValue, { color: COLOR_INFO }]}>{counts['info']}</Text>
          <Text style={styles.countLabel}>Info</Text>
        </View>
        <View style={styles.countBox}>
          <Text style={styles.countValue}>{resolved}</Text>
          <Text style={styles.countLabel}>Resolved</Text>
        </View>
      </View>
    </View>
  );
}

type ComplianceNote = ComplianceNotesInput['compliance_notes'][number];

function NoteCard(props: { note: ComplianceNote }): React.ReactElement {
  const { note } = props;
  const activityDisplay =
    note.activity_codes.length > 0 ? note.activity_codes.join(', ') : '\u2014';
  const resolutionStatus = note.resolved ? '\u2713 Resolved' : '\u2298 Open';

  return (
    <View style={styles.noteCard} wrap={false}>
      <View style={styles.noteRow}>
        <Text style={[styles.severityChip, severityStyle(note.severity)]}>
          {severityLabel(note.severity)}
        </Text>
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Text style={styles.noteText}>{note.note_text}</Text>
          <View style={styles.noteRow}>
            <Text style={styles.noteMetaLabel}>Activity codes</Text>
            <Text style={styles.noteMetaValue}>{activityDisplay}</Text>
          </View>
          <View style={styles.noteRow}>
            <Text style={styles.noteMetaLabel}>Status</Text>
            <Text style={note.resolved ? styles.resolvedText : styles.openText}>
              {resolutionStatus}
            </Text>
          </View>
        </View>
      </View>
      {note.resolved && note.resolution_note !== null && (
        <View style={styles.resolutionBox}>
          <Text style={styles.resolutionText}>{note.resolution_note}</Text>
        </View>
      )}
    </View>
  );
}

function ComplianceNotesSection(props: { input: ComplianceNotesInput }): React.ReactElement {
  const { compliance_notes: notes } = props.input;

  if (notes.length === 0) {
    return (
      <View>
        <Text style={styles.sectionHeading}>Compliance Notes</Text>
        <View style={styles.metaBox}>
          <Text>No compliance notes recorded for this claim.</Text>
        </View>
      </View>
    );
  }

  // Group notes by section.
  const sectionMap = new Map<string, ComplianceNote[]>();
  for (const note of notes) {
    const existing = sectionMap.get(note.section);
    if (existing) {
      existing.push(note);
    } else {
      sectionMap.set(note.section, [note]);
    }
  }

  // Sort notes within each section by severity order (critical → info).
  for (const [section, sectionNotes] of sectionMap.entries()) {
    sectionMap.set(
      section,
      [...sectionNotes].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
      ),
    );
  }

  return (
    <View>
      <Text style={styles.sectionHeading}>Compliance Notes</Text>
      {[...sectionMap.entries()].map(([section, sectionNotes]) => (
        <View key={section}>
          <Text style={styles.legislativeHeading}>{section}</Text>
          {sectionNotes.map((note) => (
            <NoteCard key={note.id} note={note} />
          ))}
        </View>
      ))}
    </View>
  );
}

function SignOffBlock(props: { input: ComplianceNotesInput }): React.ReactElement {
  const { reviewer_name, reviewed_at } = props.input;
  const hasReview = reviewer_name !== null || reviewed_at !== null;

  return (
    <View style={styles.signOffBlock}>
      <Text style={styles.signOffHeading}>Sign-off</Text>
      {hasReview ? (
        <View>
          <View style={styles.signOffRow}>
            <Text style={styles.signOffLabel}>Reviewer</Text>
            <Text style={styles.signOffValue}>{reviewer_name ?? '\u2014'}</Text>
          </View>
          <View style={styles.signOffRow}>
            <Text style={styles.signOffLabel}>Reviewed at</Text>
            <Text style={styles.signOffValue}>
              {reviewed_at ? formatDate(reviewed_at) : '\u2014'}
            </Text>
          </View>
        </View>
      ) : (
        <Text style={styles.awaitingText}>Awaiting review</Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Render function
// ---------------------------------------------------------------------------

/** Pure-function renderer. Returns a Uint8Array of the raw PDF bytes. */
export async function renderComplianceNotesPdf(input: ComplianceNotesInput): Promise<Uint8Array> {
  const { firm, subject_tenant, claim } = input;
  const claimantLine = subject_tenant.abn
    ? `${subject_tenant.name} \u00B7 ABN ${subject_tenant.abn}`
    : subject_tenant.name;
  const footerText = `Compliance Notes \u00B7 Claim FY${claim.fy_year} \u00B7 ${firm.name} \u2192 ${claimantLine}`;

  const doc = (
    <Document>
      <Page size="A4" style={styles.page}>
        <ForensicHeader input={input} />
        <TitleBlock input={input} />
        <SummarySection input={input} />
        <ComplianceNotesSection input={input} />
        <SignOffBlock input={input} />
        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `Page ${pageNumber} of ${totalPages} \u00B7 ${footerText}`
          }
        />
      </Page>
    </Document>
  );

  // @react-pdf/renderer v4: pdf().toBuffer() returns an AsyncGenerator.
  // Collect all chunks into a single Buffer then return as Uint8Array.
  // Mirrors evidence-index.tsx pattern.
  const stream = await pdf(doc).toBuffer();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
