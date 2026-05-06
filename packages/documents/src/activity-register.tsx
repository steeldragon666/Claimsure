import { Document, Page, View, Text, StyleSheet, pdf } from '@react-pdf/renderer';

/**
 * Activity Register PDF (F.5).
 *
 * A forensic, regulator-facing landscape document listing every R&D activity
 * registered against a claim, with expenditure, time, and documentation counts.
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
 * Orientation: landscape (A4) — the table has many columns.
 * Standalone <Document><Page> — no DocumentLayout wrapper.
 */

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export type ActivityRegisterInput = {
  firm: { name: string; abn: string | null };
  subject_tenant: { name: string; abn: string | null };
  claim: { id: string; fy_year: number };
  generated_at: string; // ISO timestamp
  content_hash_hex: string; // 64 hex chars (sha256)
  generator_version: string; // e.g. "1.0.0"
  activities: Array<{
    code: string;
    title: string;
    kind: 'core' | 'supporting';
    hypothesis: string | null;
    technical_lead: string | null;
    start_date: string | null; // ISO date
    end_date: string | null; // ISO date
    eligible_expenditure: number;
    time_entries_count: number;
    supporting_documents_count: number;
  }>;
};

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const COLOR_CREAM = '#FAF8F3';
const COLOR_INK = '#1A1814';
const COLOR_PATINA = '#5C7A6B';
const COLOR_MUTED = '#666666';
const COLOR_BORDER = '#cccccc';
const COLOR_THEAD_BG = '#EEF2EF';
const COLOR_TROW_BORDER = '#e0e8e4';
const COLOR_CHIP_CORE_BG = '#EEF2EF';
const COLOR_CHIP_CORE_TEXT = '#5C7A6B';
const COLOR_CHIP_SUPPORTING_BG = '#FFF7ED';
const COLOR_CHIP_SUPPORTING_TEXT = '#b45309';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  page: {
    paddingTop: 56,
    paddingBottom: 60,
    paddingHorizontal: 40,
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

  // Summary counts row.
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
    fontSize: 8,
    color: COLOR_PATINA,
  },
  td: { padding: 6, fontSize: 8, color: COLOR_INK },

  // Activity table columns.
  // Landscape A4 = 842pt wide; minus 80pt padding = 762pt usable.
  // Code: 8%, Title: 25%, Kind: 9%, Lead: 14%, Dates: 13%, Expenditure: 12%, Time: 9%, Docs: 10%
  actColCode: { width: '8%' },
  actColTitle: { width: '25%' },
  actColKind: { width: '9%' },
  actColLead: { width: '14%' },
  actColDates: { width: '13%' },
  actColExpenditure: { width: '12%' },
  actColTime: { width: '9%' },
  actColDocs: { width: '10%' },

  // Kind chips (inline text with background).
  chipCore: {
    backgroundColor: COLOR_CHIP_CORE_BG,
    color: COLOR_CHIP_CORE_TEXT,
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  chipSupporting: {
    backgroundColor: COLOR_CHIP_SUPPORTING_BG,
    color: COLOR_CHIP_SUPPORTING_TEXT,
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },

  // Financial footer.
  financialFooterBox: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: COLOR_BORDER,
    paddingTop: 6,
  },
  financialFooterLabel: {
    fontSize: 9,
    color: COLOR_MUTED,
    marginRight: 8,
  },
  financialFooterValue: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: COLOR_INK,
  },

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

  // Empty state box.
  emptyBox: {
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    padding: 10,
    borderRadius: 2,
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

/**
 * Format date range. Returns em-dash if both null; otherwise formats as start→end.
 */
function formatDateRange(start: string | null, end: string | null): string {
  if (start === null && end === null) return '\u2014';
  return `${start ?? '?'} \u2192 ${end ?? '?'}`;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ForensicHeader(props: { input: ActivityRegisterInput }): React.ReactElement {
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

function TitleBlock(props: { input: ActivityRegisterInput }): React.ReactElement {
  const { firm, subject_tenant, claim, generated_at } = props.input;
  const firmLine = firm.abn ? `${firm.name} \u00B7 ABN ${firm.abn}` : firm.name;
  const claimantLine = subject_tenant.abn
    ? `${subject_tenant.name} \u00B7 ABN ${subject_tenant.abn}`
    : subject_tenant.name;
  const shortId = claim.id.slice(-8);

  return (
    <View style={styles.titleBlock}>
      <Text style={styles.firmLine}>{firmLine}</Text>
      <Text style={styles.title}>
        R&amp;D Tax Incentive \u2014 Activity Register, FY{claim.fy_year}
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
    </View>
  );
}

function SummaryCountsSection(props: { input: ActivityRegisterInput }): React.ReactElement {
  const { activities } = props.input;
  const total = activities.length;
  const coreCount = activities.filter((a) => a.kind === 'core').length;
  const supportingCount = activities.filter((a) => a.kind === 'supporting').length;

  return (
    <View style={styles.countsRow}>
      <View style={styles.countBox}>
        <Text style={styles.countValue}>{total}</Text>
        <Text style={styles.countLabel}>Total activities</Text>
      </View>
      <View style={styles.countBox}>
        <Text style={styles.countValue}>{coreCount}</Text>
        <Text style={styles.countLabel}>Core</Text>
      </View>
      <View style={styles.countBox}>
        <Text style={styles.countValue}>{supportingCount}</Text>
        <Text style={styles.countLabel}>Supporting</Text>
      </View>
    </View>
  );
}

function ActivityTableSection(props: { input: ActivityRegisterInput }): React.ReactElement {
  const { activities } = props.input;

  const kindOrder: Array<'core' | 'supporting'> = ['core', 'supporting'];
  const sorted = [...activities].sort(
    (a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind),
  );

  if (activities.length === 0) {
    return (
      <View style={styles.emptyBox}>
        <Text>No activities registered for this claim.</Text>
      </View>
    );
  }

  return (
    <View style={styles.table}>
      <View style={styles.thead} fixed>
        <Text style={[styles.th, styles.actColCode]}>Code</Text>
        <Text style={[styles.th, styles.actColTitle]}>Title</Text>
        <Text style={[styles.th, styles.actColKind]}>Kind</Text>
        <Text style={[styles.th, styles.actColLead]}>Technical Lead</Text>
        <Text style={[styles.th, styles.actColDates]}>Dates</Text>
        <Text style={[styles.th, styles.actColExpenditure]}>Eligible Exp. (AUD)</Text>
        <Text style={[styles.th, styles.actColTime]}>Time Entries</Text>
        <Text style={[styles.th, styles.actColDocs]}>Supp. Docs</Text>
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
          <Text style={[styles.td, styles.actColLead]}>{a.technical_lead ?? '\u2014'}</Text>
          <Text style={[styles.td, styles.actColDates]}>
            {formatDateRange(a.start_date, a.end_date)}
          </Text>
          <Text style={[styles.td, styles.actColExpenditure]}>
            {formatAUD(a.eligible_expenditure)}
          </Text>
          <Text style={[styles.td, styles.actColTime]}>{a.time_entries_count}</Text>
          <Text style={[styles.td, styles.actColDocs]}>{a.supporting_documents_count}</Text>
        </View>
      ))}
    </View>
  );
}

function FinancialFooter(props: { input: ActivityRegisterInput }): React.ReactElement {
  const total = props.input.activities.reduce((sum, a) => sum + a.eligible_expenditure, 0);
  return (
    <View style={styles.financialFooterBox}>
      <Text style={styles.financialFooterLabel}>Total Eligible Expenditure:</Text>
      <Text style={styles.financialFooterValue}>{formatAUD(total)}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Render function
// ---------------------------------------------------------------------------

/** Pure-function renderer. Returns a Uint8Array of the raw PDF bytes. */
export async function renderActivityRegisterPdf(input: ActivityRegisterInput): Promise<Uint8Array> {
  const { firm, subject_tenant, claim } = input;
  const claimantLine = subject_tenant.abn
    ? `${subject_tenant.name} \u00B7 ABN ${subject_tenant.abn}`
    : subject_tenant.name;
  const footerText = `Activity Register \u00B7 Claim FY${claim.fy_year} \u00B7 ${firm.name} \u2192 ${claimantLine}`;

  const doc = (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <ForensicHeader input={input} />
        <TitleBlock input={input} />
        <Text style={styles.sectionHeading}>Activity Register</Text>
        <SummaryCountsSection input={input} />
        <ActivityTableSection input={input} />
        <FinancialFooter input={input} />
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
  const stream = await pdf(doc).toBuffer();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
