import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { ReactNode } from 'react';

/**
 * Typed input for the activity record-of-application PDF (T-A8).
 *
 * The shape is decoupled from the DB rows on purpose — the API route layer
 * is responsible for joining `activity → project → claim → subject_tenant
 * → tenant` and folding the artefact / uncertainty event chains into the
 * arrays below. Keeping this package storage-agnostic means a future
 * AusIndustry template-fill path (Phase 2) can construct the same input
 * from regulator-supplied fixture JSON without touching @cpa/db.
 *
 * Fields whose source DB column doesn't exist yet (e.g. ABN, activity-
 * level start/end dates, separate `objective` / `new_knowledge` columns)
 * are typed as nullable here; the route fills them with `null` and the
 * renderer surfaces "Not yet captured" placeholders. The schema can grow
 * those columns later without changing the wire-shape of the input.
 */
export interface ActivityApplicationInput {
  firm: {
    name: string;
    abn: string | null;
  };
  subject_tenant: {
    name: string;
    abn: string | null;
  };
  project: {
    name: string;
    description: string | null;
    started_at: string; // ISO-8601 with offset
    ended_at: string | null;
  };
  claim: {
    fiscal_year: number;
    stage: string;
  };
  activity: {
    code: string; // e.g. "CA-001" or "SA-001"
    title: string;
    kind: 'CORE' | 'SUPPORTING';
    description: string | null;
    objective: string | null;
    hypothesis: string | null;
    technical_uncertainty: string | null;
    new_knowledge: string | null;
    activity_started_at: string | null;
    activity_ended_at: string | null;
  };
  artefacts: Array<{
    kind: string;
    title: string;
    uri: string | null;
    linked_at: string;
    reason: string | null;
  }>;
  uncertainty_events: Array<{
    kind: string;
    captured_at: string;
    summary: string;
    classification?: { confidence: number; rationale: string } | null;
  }>;
  /**
   * ISO-8601 timestamp this PDF reflects state at. The footer renders this
   * verbatim — auditors can compare against the chain to reconstruct what
   * the consultant saw at generation time. This makes the PDF a derived
   * report, not a committed artefact (no PDF_GENERATED chain event;
   * auditability is the chain itself).
   */
  generated_at: string;
}

/**
 * A4 page metrics (in pt) and a small A4-friendly type system. We keep the
 * styles flat (one StyleSheet object) rather than per-section because
 * @react-pdf re-creates the renderer on every call and there's no win to
 * memoising at module-init time.
 */
// Font: Helvetica is one of @react-pdf's 14 built-in PDF standard fonts.
// Coverage: Latin-1 only (ASCII + Western European accents + § symbol used
// in statutory_anchor). Non-Latin characters (Cyrillic, Greek, Asian
// scripts, emoji) will silently strip during rendering — they do NOT throw.
//
// To support non-Latin characters: register a TTF/OTF font with @react-pdf's
// Font.register() (e.g. NotoSans-Regular.ttf provides multi-script coverage).
// This will increase PDF size from ~5 KB to ~200 KB.
//
// TODO(P4-followup): font coverage — evaluate Unicode font registration
// once we have a real customer with non-Latin activity titles.
const styles = StyleSheet.create({
  page: { padding: 40, paddingBottom: 60, fontFamily: 'Helvetica', fontSize: 10, color: '#111827' },
  header: {
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingBottom: 10,
  },
  firmName: { fontSize: 13, fontWeight: 'bold' },
  firmAbn: { fontSize: 9, color: '#475569', marginTop: 1 },
  docTitle: { fontSize: 16, fontWeight: 'bold', marginTop: 8 },
  generatedAt: { fontSize: 8, color: '#475569', marginTop: 3 },
  sectionHeading: {
    fontSize: 12,
    fontWeight: 'bold',
    marginTop: 16,
    marginBottom: 6,
    color: '#0f172a',
  },
  overviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  overviewItem: { width: '48%', marginBottom: 4 },
  overviewLabel: { fontSize: 8, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 },
  overviewValue: { fontSize: 10, marginTop: 1 },
  kindChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    fontSize: 8,
    fontWeight: 'bold',
    color: '#1e3a8a',
    backgroundColor: '#dbeafe',
    marginTop: 1,
  },
  kindChipSupporting: {
    color: '#3f3f46',
    backgroundColor: '#e4e4e7',
  },
  narrativeSection: { marginBottom: 8 },
  narrativeLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#0f172a',
    marginBottom: 2,
  },
  narrativeText: { fontSize: 10, lineHeight: 1.45 },
  narrativeEmpty: { fontSize: 10, color: '#94a3b8', fontStyle: 'italic' },
  table: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 3,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  tableRowLast: {
    flexDirection: 'row',
  },
  tableCell: {
    padding: 6,
    fontSize: 9,
  },
  tableCellHeader: {
    padding: 6,
    fontSize: 8,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    color: '#475569',
  },
  colKind: { width: '15%' },
  colTitle: { width: '45%' },
  colLinkedAt: { width: '20%' },
  colReason: { width: '20%' },
  emptyState: {
    fontSize: 9,
    color: '#94a3b8',
    fontStyle: 'italic',
    padding: 6,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderStyle: 'dashed',
    borderRadius: 3,
  },
  registerEntry: {
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  registerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  registerKindChip: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    fontSize: 8,
    fontWeight: 'bold',
    color: '#0f172a',
    backgroundColor: '#fef3c7',
  },
  registerTimestamp: { fontSize: 8, color: '#64748b' },
  registerSummary: { fontSize: 10, marginTop: 2 },
  registerClassification: { fontSize: 8, color: '#475569', fontStyle: 'italic', marginTop: 1 },
  footer: {
    position: 'absolute',
    bottom: 25,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: '#64748b',
  },
});

/** Format an ISO-8601 timestamp for human display. We keep the exact ISO
 *  string in the footer (auditors want unambiguous comparison) and use a
 *  human-readable form in body copy. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

/** Narrative section helper. Empty / whitespace-only values render the
 *  "Not yet captured" placeholder — the spec calls this out explicitly so
 *  reviewers can see at a glance which fields the consultant still owes. */
function NarrativeBlock({ label, value }: { label: string; value: string | null }): ReactNode {
  const trimmed = value?.trim() ?? '';
  return (
    <View style={styles.narrativeSection}>
      <Text style={styles.narrativeLabel}>{label}</Text>
      {trimmed.length > 0 ? (
        <Text style={styles.narrativeText}>{trimmed}</Text>
      ) : (
        <Text style={styles.narrativeEmpty}>Not yet captured</Text>
      )}
    </View>
  );
}

/** Render the full PDF as a React tree. Exported so tests can introspect
 *  the JSX shape, but the canonical entry point is `renderActivityApplicationPdf`. */
export function ActivityApplicationDocument({
  input,
}: {
  input: ActivityApplicationInput;
}): ReactNode {
  const { firm, subject_tenant, project, claim, activity, artefacts, uncertainty_events } = input;
  const kindLabel = activity.kind === 'CORE' ? 'Core activity' : 'Supporting activity';
  const projectDates =
    project.ended_at !== null
      ? `${formatDate(project.started_at)} – ${formatDate(project.ended_at)}`
      : `${formatDate(project.started_at)} – ongoing`;

  return (
    <Document title={`Activity ${activity.code} application — FY${claim.fiscal_year}`}>
      <Page size="A4" style={styles.page}>
        {/* Header — firm + ABN, doc title, generated-at */}
        <View style={styles.header}>
          <Text style={styles.firmName}>{firm.name}</Text>
          {firm.abn !== null ? (
            <Text style={styles.firmAbn}>ABN {firm.abn}</Text>
          ) : (
            <Text style={styles.firmAbn}>ABN not on file</Text>
          )}
          <Text style={styles.docTitle}>
            R&amp;D Tax Incentive — Activity Record-of-Application
          </Text>
          <Text style={styles.generatedAt}>Generated {formatDateTime(input.generated_at)}</Text>
        </View>

        {/* Overview — project + claim + activity identity */}
        <Text style={styles.sectionHeading}>Activity overview</Text>
        <View style={styles.overviewGrid}>
          <View style={styles.overviewItem}>
            <Text style={styles.overviewLabel}>Claimant</Text>
            <Text style={styles.overviewValue}>{subject_tenant.name}</Text>
            {subject_tenant.abn !== null ? (
              <Text style={styles.firmAbn}>ABN {subject_tenant.abn}</Text>
            ) : null}
          </View>
          <View style={styles.overviewItem}>
            <Text style={styles.overviewLabel}>Fiscal year</Text>
            <Text style={styles.overviewValue}>FY{claim.fiscal_year}</Text>
            <Text style={styles.firmAbn}>Stage: {claim.stage}</Text>
          </View>
          <View style={styles.overviewItem}>
            <Text style={styles.overviewLabel}>Project</Text>
            <Text style={styles.overviewValue}>{project.name}</Text>
            <Text style={styles.firmAbn}>{projectDates}</Text>
          </View>
          <View style={styles.overviewItem}>
            <Text style={styles.overviewLabel}>Activity</Text>
            <Text style={styles.overviewValue}>
              {activity.code} — {activity.title}
            </Text>
            <Text
              style={
                activity.kind === 'CORE'
                  ? styles.kindChip
                  : [styles.kindChip, styles.kindChipSupporting]
              }
            >
              {kindLabel.toUpperCase()}
            </Text>
          </View>
          {activity.activity_started_at !== null || activity.activity_ended_at !== null ? (
            <View style={styles.overviewItem}>
              <Text style={styles.overviewLabel}>Activity period</Text>
              <Text style={styles.overviewValue}>
                {activity.activity_started_at !== null
                  ? formatDate(activity.activity_started_at)
                  : '—'}{' '}
                –{' '}
                {activity.activity_ended_at !== null
                  ? formatDate(activity.activity_ended_at)
                  : 'ongoing'}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Narrative — the six labelled R&D narrative fields */}
        <Text style={styles.sectionHeading}>Activity narrative</Text>
        <NarrativeBlock label="Description" value={activity.description} />
        <NarrativeBlock label="Objective" value={activity.objective} />
        <NarrativeBlock label="Hypothesis" value={activity.hypothesis} />
        <NarrativeBlock label="Technical uncertainty" value={activity.technical_uncertainty} />
        <NarrativeBlock label="New knowledge" value={activity.new_knowledge} />
        {project.description !== null ? (
          <NarrativeBlock label="Project context" value={project.description} />
        ) : null}

        {/* Linked artefacts table */}
        <Text style={styles.sectionHeading}>Linked artefacts</Text>
        {artefacts.length === 0 ? (
          <Text style={styles.emptyState}>No artefacts linked</Text>
        ) : (
          <View style={styles.table}>
            <View style={styles.tableHeader} fixed>
              <Text style={[styles.tableCellHeader, styles.colKind]}>Kind</Text>
              <Text style={[styles.tableCellHeader, styles.colTitle]}>Title</Text>
              <Text style={[styles.tableCellHeader, styles.colLinkedAt]}>Linked at</Text>
              <Text style={[styles.tableCellHeader, styles.colReason]}>Reason</Text>
            </View>
            {artefacts.map((a, i) => {
              const isLast = i === artefacts.length - 1;
              return (
                <View
                  key={`artefact-${i}`}
                  style={isLast ? styles.tableRowLast : styles.tableRow}
                  wrap={false}
                >
                  <Text style={[styles.tableCell, styles.colKind]}>{a.kind}</Text>
                  <Text style={[styles.tableCell, styles.colTitle]}>{a.title}</Text>
                  <Text style={[styles.tableCell, styles.colLinkedAt]}>
                    {formatDate(a.linked_at)}
                  </Text>
                  <Text style={[styles.tableCell, styles.colReason]}>{a.reason ?? '—'}</Text>
                </View>
              );
            })}
          </View>
        )}

        {/* Uncertainty register — chronological list */}
        <Text style={styles.sectionHeading}>Uncertainty register</Text>
        {uncertainty_events.length === 0 ? (
          <Text style={styles.emptyState}>No uncertainty events captured</Text>
        ) : (
          <View>
            {uncertainty_events.map((e, i) => (
              <View key={`event-${i}`} style={styles.registerEntry} wrap={false}>
                <View style={styles.registerHeader}>
                  <Text style={styles.registerKindChip}>{e.kind}</Text>
                  <Text style={styles.registerTimestamp}>{formatDateTime(e.captured_at)}</Text>
                </View>
                <Text style={styles.registerSummary}>{e.summary}</Text>
                {e.classification ? (
                  <Text style={styles.registerClassification}>
                    Confidence {(e.classification.confidence * 100).toFixed(0)}% —{' '}
                    {e.classification.rationale}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        )}

        {/* Footer — page number, attribution, activity code */}
        <View style={styles.footer} fixed>
          <Text>Generated by R&amp;D Platform · {activity.code}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
          <Text>{formatDateTime(input.generated_at)}</Text>
        </View>
      </Page>
    </Document>
  );
}

/**
 * Render the activity application PDF and return the bytes.
 *
 * Pure function: same input ⇒ same output (modulo the timestamp embedded
 * in the PDF metadata; consumers that want byte-stable output should set
 * `creationDate`, but for an audit-anchored doc the time-of-render is a
 * feature, not a bug). The function is async because @react-pdf streams
 * the underlying pdfkit Buffer chunks and resolves once the document is
 * fully rendered.
 */
export async function renderActivityApplicationPdf(
  input: ActivityApplicationInput,
): Promise<Uint8Array> {
  const buf = await renderToBuffer(<ActivityApplicationDocument input={input} />);
  // renderToBuffer returns a Node Buffer; expose Uint8Array on the public
  // surface so downstream callers (Fastify reply.send, Web Response, etc.)
  // don't have to know about the Node Buffer subclass.
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
