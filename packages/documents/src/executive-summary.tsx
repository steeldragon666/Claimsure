import { Document, Page, View, Text, StyleSheet, pdf } from '@react-pdf/renderer';

/**
 * Executive Summary PDF (F.4).
 *
 * A forensic, regulator-facing summary document for an R&D Tax Incentive
 * claim. It answers:
 *   1. Who is claiming and for which year? (cover/title block)
 *   2. What are the headline financial figures? (financial summary)
 *   3. What R&D activities were performed? (activity overview)
 *   4. What are the key risks to the claim? (key risks)
 *   5. What notes did the preparer record? (preparer notes, optional)
 *
 * Design tokens (Sprint F, matching ingest-summary.tsx):
 *   - Page background:  cream   #FAF8F3
 *   - Primary text:     ink     #1A1814
 *   - Accent/headings:  patina  #5C7A6B
 *   - Fonts: Helvetica-Bold for headings, Helvetica for body
 *
 * Forensic header (every page, fixed):
 *   Claim: {id} | FY{year} | Generated: {iso} | Hash: {hex[:12]}… | v{ver}
 *
 * Standalone <Document><Page> — no DocumentLayout wrapper (same rationale
 * as claim-summary.tsx and ingest-summary.tsx).
 */

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export type ExecutiveSummaryInput = {
  firm: { name: string; abn: string | null };
  subject_tenant: { name: string; abn: string | null };
  claim: {
    id: string;
    fy_year: number;
    eligible_expenditure: number;
    tax_offset_estimate: number;
    activity_count: number;
    core_activity_count: number;
    supporting_activity_count: number;
  };
  generated_at: string; // ISO timestamp
  content_hash_hex: string; // 64 hex chars (sha256)
  generator_version: string; // e.g. "1.0.0"
  activities: Array<{
    code: string;
    title: string;
    kind: 'core' | 'supporting';
    hypothesis: string | null;
  }>;
  key_risks: Array<{
    description: string;
    severity: 'high' | 'medium' | 'low';
  }>;
  preparer_notes: string | null;
};

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const COLOR_CREAM = '#FAF8F3';
const COLOR_INK = '#1A1814';
const COLOR_PATINA = '#5C7A6B';
const COLOR_MUTED = '#666666';
const COLOR_BORDER = '#cccccc';
const COLOR_THEAD_BG = '#EEF2EF'; // light tint of patina for table headers
const COLOR_TROW_BORDER = '#e0e8e4';
const COLOR_SEVERITY_HIGH = '#b91c1c';
const COLOR_SEVERITY_MEDIUM = '#b45309';
const COLOR_CHIP_CORE_BG = '#EEF2EF';
const COLOR_CHIP_CORE_TEXT = '#5C7A6B';
const COLOR_CHIP_SUPPORTING_BG = '#FFF7ED';
const COLOR_CHIP_SUPPORTING_TEXT = '#b45309';

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

  // Generic meta key-value box.
  metaBox: {
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    padding: 10,
    borderRadius: 2,
  },
  metaRow: { flexDirection: 'row', marginBottom: 4 },
  metaLabel: { width: 200, color: COLOR_MUTED },
  metaValue: { flex: 1, color: COLOR_INK },
  metaValueAccent: { flex: 1, color: COLOR_PATINA, fontFamily: 'Helvetica-Bold' },

  // Activity overview summary counts.
  countsRow: { flexDirection: 'row', marginBottom: 8, gap: 12 },
  countBox: {
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    borderRadius: 4,
    padding: 8,
    flex: 1,
    alignItems: 'center',
  },
  countValue: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: COLOR_PATINA,
  },
  countLabel: { fontSize: 8, color: COLOR_MUTED, marginTop: 2 },

  // Activities table.
  table: { borderWidth: 1, borderColor: COLOR_BORDER, borderRadius: 2 },
  thead: {
    flexDirection: 'row',
    backgroundColor: COLOR_THEAD_BG,
    borderBottomWidth: 1,
    borderBottomColor: COLOR_BORDER,
  },
  trow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: COLOR_TROW_BORDER,
  },
  th: {
    padding: 6,
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    color: COLOR_PATINA,
  },
  td: { padding: 6, fontSize: 9, color: COLOR_INK },

  // Activity table columns.
  actColCode: { width: '12%' },
  actColTitle: { width: '48%' },
  actColKind: { width: '18%' },
  actColHypothesis: { width: '22%' },

  // Kind chips (inline text with background-like border).
  chipCore: {
    backgroundColor: COLOR_CHIP_CORE_BG,
    color: COLOR_CHIP_CORE_TEXT,
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  chipSupporting: {
    backgroundColor: COLOR_CHIP_SUPPORTING_BG,
    color: COLOR_CHIP_SUPPORTING_TEXT,
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },

  // Key risks table columns.
  riskColSeverity: { width: '18%' },
  riskColDescription: { width: '82%' },

  // Severity chips.
  severityHigh: { color: COLOR_SEVERITY_HIGH, fontFamily: 'Helvetica-Bold' },
  severityMedium: { color: COLOR_SEVERITY_MEDIUM, fontFamily: 'Helvetica-Bold' },
  severityLow: { color: COLOR_MUTED },

  // Preparer notes block.
  notesBox: {
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    borderLeftWidth: 3,
    borderLeftColor: COLOR_PATINA,
    padding: 10,
    borderRadius: 2,
  },
  notesText: { fontSize: 9, color: COLOR_INK, lineHeight: 1.5 },

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

/**
 * Format amount as AUD currency using en-AU locale.
 * E.g. 1500000 → "$1,500,000.00"
 */
function formatAUD(amount: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ForensicHeader(props: { input: ExecutiveSummaryInput }): React.ReactElement {
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

function TitleBlock(props: { input: ExecutiveSummaryInput }): React.ReactElement {
  const { firm, subject_tenant, claim, generated_at } = props.input;
  const firmLine = firm.abn ? `${firm.name} · ABN ${firm.abn}` : firm.name;
  const claimantLine = subject_tenant.abn
    ? `${subject_tenant.name} · ABN ${subject_tenant.abn}`
    : subject_tenant.name;
  const shortId = claim.id.slice(-8);

  return (
    <View style={styles.titleBlock}>
      <Text style={styles.firmLine}>{firmLine}</Text>
      <Text style={styles.title}>R&amp;D Tax Incentive — Executive Summary, FY{claim.fy_year}</Text>
      <Text style={styles.subtitle}>Generated {generated_at}</Text>
      <View style={styles.claimMetaRow}>
        <Text style={styles.claimMetaLabel}>Claimant</Text>
        <Text style={styles.claimMetaValue}>{claimantLine}</Text>
      </View>
      <View style={styles.claimMetaRow}>
        <Text style={styles.claimMetaLabel}>Claim ID</Text>
        <Text style={styles.claimMetaValue}>…{shortId}</Text>
      </View>
    </View>
  );
}

function FinancialSummarySection(props: { input: ExecutiveSummaryInput }): React.ReactElement {
  const { claim } = props.input;
  return (
    <View>
      <Text style={styles.sectionHeading}>Financial Summary</Text>
      <View style={styles.metaBox}>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Eligible expenditure (AUD)</Text>
          <Text style={styles.metaValueAccent}>{formatAUD(claim.eligible_expenditure)}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Estimated tax offset (AUD)</Text>
          <Text style={styles.metaValueAccent}>{formatAUD(claim.tax_offset_estimate)}</Text>
        </View>
      </View>
    </View>
  );
}

function ActivityOverviewSection(props: { input: ExecutiveSummaryInput }): React.ReactElement {
  const { claim, activities } = props.input;

  const kindOrder: Array<'core' | 'supporting'> = ['core', 'supporting'];
  const sorted = [...activities].sort(
    (a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind),
  );

  return (
    <View>
      <Text style={styles.sectionHeading}>Activity Overview</Text>

      {/* Summary counts row */}
      <View style={styles.countsRow}>
        <View style={styles.countBox}>
          <Text style={styles.countValue}>{claim.activity_count}</Text>
          <Text style={styles.countLabel}>Total activities</Text>
        </View>
        <View style={styles.countBox}>
          <Text style={styles.countValue}>{claim.core_activity_count}</Text>
          <Text style={styles.countLabel}>Core</Text>
        </View>
        <View style={styles.countBox}>
          <Text style={styles.countValue}>{claim.supporting_activity_count}</Text>
          <Text style={styles.countLabel}>Supporting</Text>
        </View>
      </View>

      {/* Activities table */}
      {activities.length === 0 ? (
        <View style={styles.metaBox}>
          <Text>No activities registered for this claim.</Text>
        </View>
      ) : (
        <View style={styles.table}>
          <View style={styles.thead} fixed>
            <Text style={[styles.th, styles.actColCode]}>Code</Text>
            <Text style={[styles.th, styles.actColTitle]}>Title</Text>
            <Text style={[styles.th, styles.actColKind]}>Kind</Text>
            <Text style={[styles.th, styles.actColHypothesis]}>Hypothesis</Text>
          </View>
          {sorted.map((a) => (
            <View key={a.code} style={styles.trow} wrap={false}>
              <Text style={[styles.td, styles.actColCode]}>{a.code}</Text>
              <Text style={[styles.td, styles.actColTitle]}>{a.title}</Text>
              <View style={[styles.td, styles.actColKind]}>
                <Text style={a.kind === 'core' ? styles.chipCore : styles.chipSupporting}>
                  {a.kind === 'core' ? 'Core' : 'Supporting'}
                </Text>
              </View>
              <Text style={[styles.td, styles.actColHypothesis]}>{a.hypothesis ?? '\u2014'}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function KeyRisksSection(props: { input: ExecutiveSummaryInput }): React.ReactElement {
  const { key_risks } = props.input;

  if (key_risks.length === 0) {
    return (
      <View>
        <Text style={styles.sectionHeading}>Key Risks</Text>
        <View style={styles.metaBox}>
          <Text>No key risks recorded for this claim.</Text>
        </View>
      </View>
    );
  }

  // Sort high → medium → low
  const severityOrder: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
  const sorted = [...key_risks].sort(
    (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity),
  );

  return (
    <View>
      <Text style={styles.sectionHeading}>Key Risks</Text>
      <View style={styles.table}>
        <View style={styles.thead} fixed>
          <Text style={[styles.th, styles.riskColSeverity]}>Severity</Text>
          <Text style={[styles.th, styles.riskColDescription]}>Description</Text>
        </View>
        {sorted.map((risk, idx) => {
          const severityStyle =
            risk.severity === 'high'
              ? styles.severityHigh
              : risk.severity === 'medium'
                ? styles.severityMedium
                : styles.severityLow;
          return (
            <View key={`${risk.severity}-${idx}`} style={styles.trow} wrap={false}>
              <Text style={[styles.td, styles.riskColSeverity, severityStyle]}>
                {risk.severity}
              </Text>
              <Text style={[styles.td, styles.riskColDescription]}>{risk.description}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function PreparerNotesSection(props: { input: ExecutiveSummaryInput }): React.ReactElement | null {
  const { preparer_notes } = props.input;
  if (!preparer_notes) return null;

  return (
    <View>
      <Text style={styles.sectionHeading}>Preparer Notes</Text>
      <View style={styles.notesBox}>
        <Text style={styles.notesText}>{preparer_notes}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Render function
// ---------------------------------------------------------------------------

/** Pure-function renderer. Returns a Uint8Array of the raw PDF bytes. */
export async function renderExecutiveSummaryPdf(input: ExecutiveSummaryInput): Promise<Uint8Array> {
  const { firm, subject_tenant, claim } = input;
  const claimantLine = subject_tenant.abn
    ? `${subject_tenant.name} · ABN ${subject_tenant.abn}`
    : subject_tenant.name;
  const footerText = `Executive Summary · Claim FY${claim.fy_year} · ${firm.name} → ${claimantLine}`;

  const doc = (
    <Document>
      <Page size="A4" style={styles.page}>
        <ForensicHeader input={input} />
        <TitleBlock input={input} />
        <FinancialSummarySection input={input} />
        <ActivityOverviewSection input={input} />
        <KeyRisksSection input={input} />
        <PreparerNotesSection input={input} />
        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `Page ${pageNumber} of ${totalPages} · ${footerText}`
          }
        />
      </Page>
    </Document>
  );

  // @react-pdf/renderer v4: pdf().toBuffer() returns an AsyncGenerator.
  // Collect all chunks into a single Buffer then return as Uint8Array.
  // Mirrors ingest-summary.tsx pattern.
  const stream = await pdf(doc).toBuffer();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
