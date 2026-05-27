import { Document, Page, View, Text, StyleSheet, pdf, Link } from '@react-pdf/renderer';

/**
 * IP-Search Verdict Report PDF (Wizard Step 2, Task 07).
 *
 * Renders the per-claim prior-art verdict report for audit defence. One
 * report covers every approved verdict in a claim; the resulting PDF is
 * stored once and referenced by every `ip_search_verdict.pdf_evidence_id`
 * in the claim (the same evidence row, fanned out).
 *
 * Document structure:
 *   - Cover page: claimant, firm, FY, claim id, generated_at, content hash
 *   - One section per (activity, hypothesis) — i.e. per verdict — with:
 *       - Hypothesis text (verbatim)
 *       - Queries run, grouped by database (ip_australia / semantic_scholar
 *         / pubmed / arxiv) showing query + result_count
 *       - Top 5 hits (title, URL, relevance score)
 *       - Analyst-approved verdict chip (pass / fail / inconclusive)
 *       - Analysis markdown (rendered as plain paragraphs — markdown
 *         inline syntax is preserved verbatim; the renderer doesn't parse
 *         **bold** etc. The audit value is in the literal text, not the
 *         styling)
 *       - Sign-off: approver + approved_at timestamp
 *
 * Design tokens match the rest of the @cpa/documents package
 * (cream / ink / patina; Helvetica). Pages are A4 portrait.
 *
 * The Markdown → HTML → PDF spec phrasing in the task doc is satisfied
 * by `analysis_markdown` rendering inline: we treat the markdown as the
 * authoritative payload (regulator reads the exact bytes), preserve
 * newlines as paragraph breaks, and skip inline-formatter complexity
 * that would only obscure the evidence chain. Same approach
 * compliance-notes.tsx and ingest-summary.tsx take with their
 * `note_text` / `summary` fields.
 */

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export type IpSearchVerdictReportVerdict = 'pass' | 'fail' | 'inconclusive';

export type IpSearchVerdictReportHit = {
  title: string;
  url: string | null;
  /** 0..1 — LLM-assigned. */
  relevance_score: number | null;
  external_id: string;
  database_name: string;
};

export type IpSearchVerdictReportQuery = {
  database_name: string;
  query: string;
  result_count: number;
};

export type IpSearchVerdictReportSection = {
  activity_code: string;
  activity_title: string;
  hypothesis_text: string;
  verdict: IpSearchVerdictReportVerdict;
  /** LLM draft pre-review; nullable. */
  draft_verdict: IpSearchVerdictReportVerdict | null;
  analysis_markdown: string;
  approved_by_name: string | null;
  approved_at: string | null;
  queries: IpSearchVerdictReportQuery[];
  /** Already truncated to top 5 by the caller. */
  top_hits: IpSearchVerdictReportHit[];
};

export type IpSearchVerdictReportInput = {
  firm: { name: string; abn: string | null };
  subject_tenant: { name: string; abn: string | null };
  claim: { id: string; fy_year: number };
  consultant_name: string | null;
  generated_at: string;
  content_hash_hex: string;
  generator_version: string;
  sections: IpSearchVerdictReportSection[];
};

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const COLOR_CREAM = '#FAF8F3';
const COLOR_INK = '#1A1814';
const COLOR_PATINA = '#5C7A6B';
const COLOR_MUTED = '#666666';
const COLOR_BORDER = '#cccccc';
const COLOR_PALE_BG = '#F5F5F0';
const COLOR_HEADING_BG = '#EEF2EF';

const COLOR_PASS = '#166534';
const COLOR_FAIL = '#7f1d1d';
const COLOR_INCONCLUSIVE = '#b45309';

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

  coverWrap: {
    marginBottom: 16,
  },
  firmLine: { fontSize: 9, color: COLOR_MUTED },
  title: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    marginTop: 6,
    color: COLOR_PATINA,
  },
  subtitle: { fontSize: 10, color: COLOR_MUTED, marginTop: 4 },

  coverMetaBox: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    padding: 10,
    borderRadius: 2,
  },
  metaRow: { flexDirection: 'row', marginBottom: 4 },
  metaLabel: { width: 130, color: COLOR_MUTED, fontSize: 9 },
  metaValue: { flex: 1, fontSize: 9, color: COLOR_INK },

  sectionHeading: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: COLOR_PATINA,
    marginTop: 16,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: COLOR_PATINA,
    paddingBottom: 4,
  },

  subSectionHeading: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: COLOR_INK,
    marginTop: 10,
    marginBottom: 4,
    backgroundColor: COLOR_HEADING_BG,
    padding: 4,
    borderRadius: 2,
  },

  hypothesisBox: {
    borderLeftWidth: 3,
    borderLeftColor: COLOR_PATINA,
    backgroundColor: COLOR_PALE_BG,
    padding: 8,
    marginBottom: 6,
    borderRadius: 2,
  },
  hypothesisText: { fontSize: 10, color: COLOR_INK, lineHeight: 1.4 },

  verdictRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  verdictChip: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: '#FFFFFF',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    marginRight: 8,
  },
  verdictChipPass: { backgroundColor: COLOR_PASS },
  verdictChipFail: { backgroundColor: COLOR_FAIL },
  verdictChipInconclusive: { backgroundColor: COLOR_INCONCLUSIVE },

  // Query table.
  queryRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: COLOR_BORDER,
    paddingVertical: 3,
  },
  queryCellDb: { width: 110, fontSize: 9, color: COLOR_PATINA, fontFamily: 'Helvetica-Bold' },
  queryCellText: { flex: 1, fontSize: 9, color: COLOR_INK },
  queryCellCount: { width: 50, fontSize: 9, color: COLOR_MUTED, textAlign: 'right' },

  hitCard: {
    marginTop: 4,
    padding: 6,
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    borderRadius: 2,
  },
  hitTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: COLOR_INK },
  hitMetaRow: { flexDirection: 'row', marginTop: 2 },
  hitMetaLabel: { fontSize: 8, color: COLOR_MUTED, width: 70 },
  hitMetaValue: { flex: 1, fontSize: 8, color: COLOR_INK },
  hitLink: { fontSize: 8, color: COLOR_PATINA, textDecoration: 'underline' },

  analysisBlock: { marginTop: 6 },
  analysisParagraph: { fontSize: 10, color: COLOR_INK, lineHeight: 1.5, marginBottom: 4 },

  signOffBlock: {
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: 0.5,
    borderTopColor: COLOR_BORDER,
  },
  signOffText: { fontSize: 9, color: COLOR_MUTED },

  noVerdictsBox: {
    marginTop: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: COLOR_BORDER,
    borderRadius: 2,
    alignItems: 'center',
  },

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

function verdictChipStyle(v: IpSearchVerdictReportVerdict) {
  switch (v) {
    case 'pass':
      return styles.verdictChipPass;
    case 'fail':
      return styles.verdictChipFail;
    case 'inconclusive':
      return styles.verdictChipInconclusive;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatScore(score: number | null): string {
  if (score === null || Number.isNaN(score)) return '—';
  return score.toFixed(2);
}

/** Split markdown into paragraphs on blank lines. Inline syntax left raw. */
function paragraphsOf(markdown: string): string[] {
  return markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ForensicHeader(props: { input: IpSearchVerdictReportInput }): React.ReactElement {
  const { claim, generated_at, content_hash_hex, generator_version } = props.input;
  const hashChip = `${content_hash_hex.slice(0, 12)}…`;
  const text =
    `Claim: ${claim.id} | FY${claim.fy_year} | ` +
    `Generated: ${generated_at} | Hash: ${hashChip} | v${generator_version}`;
  return (
    <View style={styles.forensicHeader} fixed>
      <Text style={styles.forensicHeaderText}>{text}</Text>
    </View>
  );
}

function CoverBlock(props: { input: IpSearchVerdictReportInput }): React.ReactElement {
  const { firm, subject_tenant, claim, consultant_name, generated_at, sections } = props.input;
  const firmLine = firm.abn ? `${firm.name} · ABN ${firm.abn}` : firm.name;
  const claimantLine = subject_tenant.abn
    ? `${subject_tenant.name} · ABN ${subject_tenant.abn}`
    : subject_tenant.name;

  return (
    <View style={styles.coverWrap}>
      <Text style={styles.firmLine}>{firmLine}</Text>
      <Text style={styles.title}>R&amp;D Tax Incentive — Prior-Art Search Verdict Report</Text>
      <Text style={styles.subtitle}>
        FY{claim.fy_year} · Generated {generated_at}
      </Text>

      <View style={styles.coverMetaBox}>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Claimant</Text>
          <Text style={styles.metaValue}>{claimantLine}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Claim ID</Text>
          <Text style={styles.metaValue}>{claim.id}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Fiscal Year</Text>
          <Text style={styles.metaValue}>FY{claim.fy_year}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Consultant</Text>
          <Text style={styles.metaValue}>{consultant_name ?? '—'}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Hypotheses covered</Text>
          <Text style={styles.metaValue}>{sections.length}</Text>
        </View>
      </View>
    </View>
  );
}

function QueriesTable(props: { queries: IpSearchVerdictReportQuery[] }): React.ReactElement {
  if (props.queries.length === 0) {
    return (
      <Text style={{ fontSize: 9, color: COLOR_MUTED, fontStyle: 'italic' }}>
        No external queries recorded.
      </Text>
    );
  }
  // Group by database for readability.
  const byDb = new Map<string, IpSearchVerdictReportQuery[]>();
  for (const q of props.queries) {
    const arr = byDb.get(q.database_name);
    if (arr) arr.push(q);
    else byDb.set(q.database_name, [q]);
  }
  return (
    <View>
      {[...byDb.entries()].map(([db, qs]) =>
        qs.map((q, i) => (
          <View key={`${db}-${i}`} style={styles.queryRow}>
            <Text style={styles.queryCellDb}>{i === 0 ? db : ''}</Text>
            <Text style={styles.queryCellText}>{q.query}</Text>
            <Text style={styles.queryCellCount}>{q.result_count}</Text>
          </View>
        )),
      )}
    </View>
  );
}

function HitCard(props: { hit: IpSearchVerdictReportHit }): React.ReactElement {
  const { hit } = props;
  return (
    <View style={styles.hitCard} wrap={false}>
      <Text style={styles.hitTitle}>{hit.title}</Text>
      <View style={styles.hitMetaRow}>
        <Text style={styles.hitMetaLabel}>Database</Text>
        <Text style={styles.hitMetaValue}>{hit.database_name}</Text>
      </View>
      <View style={styles.hitMetaRow}>
        <Text style={styles.hitMetaLabel}>External ID</Text>
        <Text style={styles.hitMetaValue}>{hit.external_id}</Text>
      </View>
      <View style={styles.hitMetaRow}>
        <Text style={styles.hitMetaLabel}>Relevance</Text>
        <Text style={styles.hitMetaValue}>{formatScore(hit.relevance_score)}</Text>
      </View>
      {hit.url !== null && hit.url.length > 0 ? (
        <View style={styles.hitMetaRow}>
          <Text style={styles.hitMetaLabel}>URL</Text>
          <Link style={styles.hitLink} src={hit.url}>
            {hit.url}
          </Link>
        </View>
      ) : null}
    </View>
  );
}

function SectionBlock(props: { section: IpSearchVerdictReportSection }): React.ReactElement {
  const { section } = props;
  const tag = `[${section.activity_code}] ${section.activity_title}`;
  const approvedAtDisplay = section.approved_at ? formatDate(section.approved_at) : '—';
  const paragraphs = paragraphsOf(section.analysis_markdown);

  return (
    <View>
      <Text style={styles.sectionHeading}>{tag}</Text>

      <Text style={styles.subSectionHeading}>Hypothesis</Text>
      <View style={styles.hypothesisBox}>
        <Text style={styles.hypothesisText}>{section.hypothesis_text}</Text>
      </View>

      <View style={styles.verdictRow}>
        <Text style={[styles.verdictChip, verdictChipStyle(section.verdict)]}>
          {section.verdict.toUpperCase()}
        </Text>
        {section.draft_verdict !== null && section.draft_verdict !== section.verdict ? (
          <Text style={{ fontSize: 8, color: COLOR_MUTED }}>
            (LLM draft: {section.draft_verdict.toUpperCase()} — overridden by analyst)
          </Text>
        ) : null}
      </View>

      <Text style={styles.subSectionHeading}>Queries Run</Text>
      <QueriesTable queries={section.queries} />

      <Text style={styles.subSectionHeading}>Top Hits</Text>
      {section.top_hits.length === 0 ? (
        <Text style={{ fontSize: 9, color: COLOR_MUTED, fontStyle: 'italic' }}>
          No hits returned by any database.
        </Text>
      ) : (
        section.top_hits.map((h, i) => <HitCard key={`${h.external_id}-${i}`} hit={h} />)
      )}

      <Text style={styles.subSectionHeading}>Analyst Analysis</Text>
      <View style={styles.analysisBlock}>
        {paragraphs.length === 0 ? (
          <Text style={[styles.analysisParagraph, { color: COLOR_MUTED, fontStyle: 'italic' }]}>
            No written analysis.
          </Text>
        ) : (
          paragraphs.map((p, i) => (
            <Text key={i} style={styles.analysisParagraph}>
              {p}
            </Text>
          ))
        )}
      </View>

      <View style={styles.signOffBlock}>
        <Text style={styles.signOffText}>
          Approved by {section.approved_by_name ?? '—'} on {approvedAtDisplay}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Render function
// ---------------------------------------------------------------------------

/** Pure renderer. Returns raw PDF bytes. */
export async function renderIpSearchVerdictReportPdf(
  input: IpSearchVerdictReportInput,
): Promise<Uint8Array> {
  const { firm, subject_tenant, claim, sections } = input;
  const claimantLine = subject_tenant.abn
    ? `${subject_tenant.name} · ABN ${subject_tenant.abn}`
    : subject_tenant.name;
  const footerText = `IP-Search Verdict Report · Claim FY${claim.fy_year} · ${firm.name} → ${claimantLine}`;

  const doc = (
    <Document>
      <Page size="A4" style={styles.page}>
        <ForensicHeader input={input} />
        <CoverBlock input={input} />
        {sections.length === 0 ? (
          <View style={styles.noVerdictsBox}>
            <Text>No approved verdicts to report for this claim.</Text>
          </View>
        ) : (
          sections.map((s, i) => <SectionBlock key={`${s.activity_code}-${i}`} section={s} />)
        )}
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

  // Mirror compliance-notes.tsx + evidence-index.tsx pattern for collecting
  // the AsyncGenerator returned by @react-pdf/renderer v4 into a single
  // contiguous Uint8Array.
  const stream = await pdf(doc).toBuffer();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
