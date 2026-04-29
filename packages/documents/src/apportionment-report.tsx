import { Document, Page, View, Text, StyleSheet, pdf } from '@react-pdf/renderer';

/**
 * Apportionment report PDF (C9). The third report-style PDF after A8's
 * activity application and C7's claim summary, and the third standalone
 * <Document><Page> tree in this package.
 *
 * Why standalone (again): same rationale as `claim-summary.tsx`. The
 * existing `DocumentLayout` in `pdf-base.tsx` is hard-coded for content-
 * hashed evidence documents — it bakes the truncated content hash into
 * the page footer. C9 is a higher-level deliverable that aggregates
 * across expenditures and activities; it has no anchor hash of its own.
 *
 * This file is the third-instance trigger documented in `claim-summary.tsx`'s
 * JSDoc. After it lands, its sibling renderers (A8, C7) and this one are
 * candidates for a shared `ReportDocumentLayout` extraction — see
 * pdf-base.tsx for the abstraction outcome.
 *
 * Audience: regulator-facing audit. The document answers two questions:
 *   1. "How was each expenditure mapped to one or more R&D activities?"
 *      (the expenditure detail table — every row, every mapping state)
 *   2. "What does each activity look like in aggregate?" (the activity
 *      rollup — distinct expenditures contributing, total amount, share
 *      of all expenditure)
 *
 * Layout sections:
 *   1. Header — firm + ABN, "R&D Tax Incentive — Apportionment Report,
 *      FY{year}", generated_at timestamp.
 *   2. Claim metadata box — project + FY/stage.
 *   3. Activity rollup table — one row per activity (code, title, kind,
 *      expenditure count, total amount, % of total). Footer row with
 *      grand total. Empty-state line if zero activities.
 *   4. Expenditure detail table — multi-page; one row per expenditure.
 *      Columns: kind, date, payee, reference, amount, mapping. The
 *      mapping cell renders as either "Unmapped" (today's reality, no
 *      events exist), "→ {code}" (single mapping), or a multi-line
 *      "60% CA-001 / 40% CA-002" breakdown (apportioned).
 *   5. Totals box — total expenditure, total apportioned, total
 *      unmapped (count + amount). Unmapped > 0% rendered in amber so the
 *      "this claim has un-apportioned spend" signal pops on a quick
 *      glance.
 *   6. Footer (every page) — "Page X of Y · Apportionment Report ·
 *      Claim FY{year}".
 */

export type ApportionmentMappingState =
  | { type: 'unmapped' }
  | { type: 'mapped'; activity_code: string; activity_title: string }
  | {
      type: 'apportioned';
      allocations: ReadonlyArray<{
        activity_code: string;
        activity_title: string;
        percentage: number;
        amount: number;
      }>;
    };

export type ApportionmentExpenditure = {
  /** Stable id (in stub: the xero_invoice / xero_bank_tx / xero_receipt id). */
  id: string;
  kind: 'INVOICE' | 'BANK_TX' | 'RECEIPT';
  date: string; // ISO-8601
  payee: string | null;
  reference: string | null;
  amount: number;
  currency: string;
  mapping_state: ApportionmentMappingState;
};

export type ApportionmentActivityRollup = {
  code: string;
  title: string;
  kind: 'CORE' | 'SUPPORTING';
  /** Distinct expenditures contributing to this activity. */
  expenditure_count: number;
  /** Sum across this activity's allocations, in claim currency. */
  total_amount: number;
};

export type ApportionmentReportInput = {
  firm: { name: string; abn: string | null };
  subject_tenant: { name: string; abn: string | null };
  project: { name: string; description: string | null };
  claim: { fiscal_year: number; stage: string };
  expenditures: ReadonlyArray<ApportionmentExpenditure>;
  activity_rollup: ReadonlyArray<ApportionmentActivityRollup>;
  totals: {
    total_expenditure: number;
    total_apportioned: number;
    total_unmapped: number;
    total_unmapped_count: number;
    currency: string;
  };
  generated_at: string;
};

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: 'Helvetica', fontSize: 10, paddingBottom: 60 },
  // Header.
  header: {
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#cccccc',
    paddingBottom: 8,
  },
  firmLine: { fontSize: 9, color: '#666666' },
  title: { fontSize: 16, fontWeight: 'bold', marginTop: 4 },
  subtitle: { fontSize: 9, color: '#666666', marginTop: 4 },
  sectionHeading: { fontSize: 11, fontWeight: 'bold', marginTop: 14, marginBottom: 6 },
  // Claim metadata box.
  metaBox: {
    borderWidth: 1,
    borderColor: '#cccccc',
    padding: 10,
    borderRadius: 2,
  },
  metaRow: { flexDirection: 'row', marginBottom: 4 },
  metaLabel: { width: 110, color: '#666666' },
  metaValue: { flex: 1 },
  // Tables (shared between rollup + detail).
  table: { borderWidth: 1, borderColor: '#cccccc', borderRadius: 2 },
  thead: {
    flexDirection: 'row',
    backgroundColor: '#f3f3f3',
    borderBottomWidth: 1,
    borderBottomColor: '#cccccc',
  },
  trow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#eeeeee' },
  tfoot: {
    flexDirection: 'row',
    backgroundColor: '#fafafa',
    borderTopWidth: 1,
    borderTopColor: '#cccccc',
  },
  th: { padding: 6, fontWeight: 'bold', fontSize: 9 },
  td: { padding: 6, fontSize: 9 },
  // Activity rollup columns (sum to 100%).
  rollupColCode: { width: '12%' },
  rollupColTitle: { width: '34%' },
  rollupColKind: { width: '12%' },
  rollupColCount: { width: '10%', textAlign: 'right' },
  rollupColAmount: { width: '20%', textAlign: 'right' },
  rollupColShare: { width: '12%', textAlign: 'right' },
  // Expenditure detail columns (sum to 100%).
  detailColKind: { width: '10%' },
  detailColDate: { width: '12%' },
  detailColPayee: { width: '22%' },
  detailColRef: { width: '12%' },
  detailColAmount: { width: '14%', textAlign: 'right' },
  detailColMapping: { width: '30%' },
  // Multi-line mapping breakdown rendered inside the mapping cell.
  mappingLine: { fontSize: 9 },
  mappingMuted: { fontSize: 9, color: '#666666' },
  // Totals box.
  totalsBox: {
    borderWidth: 1,
    borderColor: '#cccccc',
    padding: 10,
    borderRadius: 2,
  },
  totalsRow: { flexDirection: 'row', marginBottom: 4 },
  totalsLabel: { width: 200, color: '#666666' },
  totalsValue: { flex: 1 },
  // Amber highlight for unmapped > 0% — single-glance regulator signal.
  // We use a foreground color rather than a background highlight to keep
  // the look consistent with the rest of the document's restrained
  // typography and avoid surprising "color band" artefacts in print.
  totalsValueAmber: { flex: 1, color: '#b45309', fontWeight: 'bold' },
  // Per-page footer.
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: '#cccccc',
    paddingTop: 6,
    fontSize: 8,
    color: '#666666',
    textAlign: 'center',
  },
});

/** Format an ISO timestamp as YYYY-MM-DD; '—' for null. Slice not Date. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

/** Format amount as fixed-2 with thousand separators + currency suffix. */
function formatMoney(amount: number, currency: string): string {
  // Intl.NumberFormat is available in @react-pdf/renderer's Node runtime.
  // Locale fixed to en-AU for the AusIndustry-facing PDF.
  const f = new Intl.NumberFormat('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${f.format(amount)} ${currency}`;
}

/** Format a percentage 0-100 as e.g. "12.5%". */
function formatPercent(pct: number): string {
  // One decimal place — enough to distinguish 33.3% / 66.7% halves but
  // not so noisy that exact-integer shares get spurious precision.
  return `${pct.toFixed(1)}%`;
}

function HeaderBlock(props: { input: ApportionmentReportInput }): React.ReactElement {
  const { firm, claim, generated_at } = props.input;
  const abnLine = firm.abn ? `${firm.name} · ABN ${firm.abn}` : firm.name;
  return (
    <View style={styles.header}>
      <Text style={styles.firmLine}>{abnLine}</Text>
      <Text style={styles.title}>
        R&amp;D Tax Incentive — Apportionment Report, FY{claim.fiscal_year}
      </Text>
      <Text style={styles.subtitle}>Generated {generated_at}</Text>
    </View>
  );
}

function ClaimMetadataBox(props: { input: ApportionmentReportInput }): React.ReactElement {
  const { project, subject_tenant, claim } = props.input;
  return (
    <View>
      <Text style={styles.sectionHeading}>Claim</Text>
      <View style={styles.metaBox}>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Claimant</Text>
          <Text style={styles.metaValue}>
            {subject_tenant.abn
              ? `${subject_tenant.name} · ABN ${subject_tenant.abn}`
              : subject_tenant.name}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Project</Text>
          <Text style={styles.metaValue}>{project.name}</Text>
        </View>
        {project.description ? (
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Description</Text>
            <Text style={styles.metaValue}>{project.description}</Text>
          </View>
        ) : null}
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Fiscal year</Text>
          <Text style={styles.metaValue}>FY{claim.fiscal_year}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Stage</Text>
          <Text style={styles.metaValue}>{claim.stage}</Text>
        </View>
      </View>
    </View>
  );
}

function ActivityRollupTable(props: { input: ApportionmentReportInput }): React.ReactElement {
  const { activity_rollup, totals } = props.input;
  const currency = totals.currency;

  if (activity_rollup.length === 0) {
    return (
      <View>
        <Text style={styles.sectionHeading}>Activity rollup</Text>
        <View style={styles.metaBox}>
          <Text>No activities registered for this claim.</Text>
        </View>
      </View>
    );
  }

  const grandTotal = activity_rollup.reduce((acc, a) => acc + a.total_amount, 0);

  return (
    <View>
      <Text style={styles.sectionHeading}>Activity rollup ({activity_rollup.length})</Text>
      <View style={styles.table}>
        <View style={styles.thead} fixed>
          <Text style={[styles.th, styles.rollupColCode]}>Code</Text>
          <Text style={[styles.th, styles.rollupColTitle]}>Title</Text>
          <Text style={[styles.th, styles.rollupColKind]}>Kind</Text>
          <Text style={[styles.th, styles.rollupColCount]}>Items</Text>
          <Text style={[styles.th, styles.rollupColAmount]}>Total</Text>
          <Text style={[styles.th, styles.rollupColShare]}>Share</Text>
        </View>
        {activity_rollup.map((a) => {
          // Share-of-total: ratio of this activity's amount to the
          // claim-wide expenditure total (NOT to the apportioned-only
          // total). This means a claim with high unmapped spend will
          // see the rollup shares sum to less than 100%, which is the
          // correct signal — unmapped expenditure is genuine spend that
          // hasn't been attributed yet.
          const share =
            totals.total_expenditure > 0 ? (a.total_amount / totals.total_expenditure) * 100 : 0;
          return (
            <View key={a.code} style={styles.trow} wrap={false}>
              <Text style={[styles.td, styles.rollupColCode]}>{a.code}</Text>
              <Text style={[styles.td, styles.rollupColTitle]}>{a.title}</Text>
              <Text style={[styles.td, styles.rollupColKind]}>
                {a.kind === 'CORE' ? 'Core' : 'Supporting'}
              </Text>
              <Text style={[styles.td, styles.rollupColCount]}>{a.expenditure_count}</Text>
              <Text style={[styles.td, styles.rollupColAmount]}>
                {formatMoney(a.total_amount, currency)}
              </Text>
              <Text style={[styles.td, styles.rollupColShare]}>{formatPercent(share)}</Text>
            </View>
          );
        })}
        <View style={styles.tfoot}>
          <Text style={[styles.td, styles.rollupColCode]}>Total</Text>
          <Text style={[styles.td, styles.rollupColTitle]}> </Text>
          <Text style={[styles.td, styles.rollupColKind]}> </Text>
          <Text style={[styles.td, styles.rollupColCount]}> </Text>
          <Text style={[styles.td, styles.rollupColAmount]}>
            {formatMoney(grandTotal, currency)}
          </Text>
          <Text style={[styles.td, styles.rollupColShare]}> </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Render the mapping cell for a single expenditure row.
 *
 * Three states (mirroring `ApportionmentMappingState`):
 *   - unmapped → grey "Unmapped" placeholder. This is today's universal
 *     state since neither `EXPENDITURE_MAPPED` nor
 *     `EXPENDITURE_APPORTIONED` events exist (deferred to A-swimlane).
 *   - mapped → "→ {code}". Compact arrow form so the code stands out
 *     against the cell's neighbours (kind, date, amount).
 *   - apportioned → multi-line breakdown, one allocation per line:
 *     "60% CA-001  Algorithm work" / "40% CA-002  Sensor calibration"
 *     The sum of percentages is contractually 100 (enforced upstream by
 *     the apportionment dialog / event payload), so we don't render a
 *     trailing total.
 */
function MappingCell(props: { state: ApportionmentMappingState }): React.ReactElement {
  const s = props.state;
  if (s.type === 'unmapped') {
    return <Text style={styles.mappingMuted}>Unmapped</Text>;
  }
  if (s.type === 'mapped') {
    return (
      <Text style={styles.mappingLine}>
        → {s.activity_code} {s.activity_title}
      </Text>
    );
  }
  return (
    <View>
      {s.allocations.map((alloc, i) => (
        <Text key={`${alloc.activity_code}-${i}`} style={styles.mappingLine}>
          {formatPercent(alloc.percentage)} {alloc.activity_code} {alloc.activity_title}
        </Text>
      ))}
    </View>
  );
}

function ExpenditureDetailTable(props: { input: ApportionmentReportInput }): React.ReactElement {
  const { expenditures, totals } = props.input;
  if (expenditures.length === 0) {
    return (
      <View>
        <Text style={styles.sectionHeading}>Expenditure detail</Text>
        <View style={styles.metaBox}>
          <Text>No expenditures recorded for this claim.</Text>
        </View>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.sectionHeading}>Expenditure detail ({expenditures.length})</Text>
      <View style={styles.table}>
        <View style={styles.thead} fixed>
          <Text style={[styles.th, styles.detailColKind]}>Kind</Text>
          <Text style={[styles.th, styles.detailColDate]}>Date</Text>
          <Text style={[styles.th, styles.detailColPayee]}>Payee</Text>
          <Text style={[styles.th, styles.detailColRef]}>Reference</Text>
          <Text style={[styles.th, styles.detailColAmount]}>Amount</Text>
          <Text style={[styles.th, styles.detailColMapping]}>Mapping</Text>
        </View>
        {expenditures.map((e) => (
          // wrap={false} keeps each expenditure's row (including a multi-
          // line apportionment breakdown) on a single page. The table
          // itself spans pages — @react-pdf paginates by row.
          <View key={e.id} style={styles.trow} wrap={false}>
            <Text style={[styles.td, styles.detailColKind]}>{e.kind}</Text>
            <Text style={[styles.td, styles.detailColDate]}>{formatDate(e.date)}</Text>
            <Text style={[styles.td, styles.detailColPayee]}>{e.payee ?? '—'}</Text>
            <Text style={[styles.td, styles.detailColRef]}>{e.reference ?? '—'}</Text>
            <Text style={[styles.td, styles.detailColAmount]}>
              {formatMoney(e.amount, e.currency)}
            </Text>
            <View style={[styles.td, styles.detailColMapping]}>
              <MappingCell state={e.mapping_state} />
            </View>
          </View>
        ))}
      </View>
      <Text style={styles.subtitle}>Currency: {totals.currency}</Text>
    </View>
  );
}

function TotalsBox(props: { input: ApportionmentReportInput }): React.ReactElement {
  const t = props.input.totals;
  // Amber highlight when ANY unmapped spend exists. Strict > 0 catches
  // both the "no events" baseline (everything unmapped) and partial
  // states. A claim with $0 unmapped renders all rows in default colour.
  const unmappedAmber = t.total_unmapped > 0;
  return (
    <View>
      <Text style={styles.sectionHeading}>Totals</Text>
      <View style={styles.totalsBox}>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Total expenditure</Text>
          <Text style={styles.totalsValue}>{formatMoney(t.total_expenditure, t.currency)}</Text>
        </View>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Total apportioned to activities</Text>
          <Text style={styles.totalsValue}>{formatMoney(t.total_apportioned, t.currency)}</Text>
        </View>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Total unmapped</Text>
          <Text style={unmappedAmber ? styles.totalsValueAmber : styles.totalsValue}>
            {formatMoney(t.total_unmapped, t.currency)} ({t.total_unmapped_count} item
            {t.total_unmapped_count === 1 ? '' : 's'})
          </Text>
        </View>
      </View>
    </View>
  );
}

/** Pure-function renderer. Returns a Uint8Array of the raw PDF bytes. */
export async function renderApportionmentReportPdf(
  input: ApportionmentReportInput,
): Promise<Uint8Array> {
  const footerText = `Apportionment Report · Claim FY${input.claim.fiscal_year}`;

  const doc = (
    <Document>
      <Page size="A4" style={styles.page}>
        <HeaderBlock input={input} />
        <ClaimMetadataBox input={input} />
        <ActivityRollupTable input={input} />
        <ExpenditureDetailTable input={input} />
        <TotalsBox input={input} />
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

  // @react-pdf/renderer's pdf().toBuffer() returns either a Buffer (Node)
  // or a Readable stream depending on platform. Collect into a single
  // Uint8Array so the API layer can stream/send the bytes without
  // depending on Node's stream types. Mirrors `claim-summary.tsx`.
  const stream = await pdf(doc).toBuffer();
  if (stream instanceof Uint8Array) {
    return new Uint8Array(stream);
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    stream.on('error', reject);
  });
}
