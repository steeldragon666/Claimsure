/**
 * Prepared-content reader for the claim wizard.
 *
 * Per docs/product/workflow.md (LOCKED): the claimant triggers "Prepare
 * claim"; an AI pipeline AUTHORS the claim (classify evidence → Core /
 * Supporting activities per Division 355 → IP / prior-art search per
 * hypothesis → apportion the ledger → draft the cited narrative); the
 * consultant APPROVES it per step in the 6-step wizard. The consultant
 * renders judgement; the AI authored.
 *
 * The per-step approval state machine already exists (`workflow.ts` +
 * `routes/claim-workflow.ts`). What was missing — and is supplied here —
 * is a read surface that returns the actual AI-prepared artefact for each
 * step, so the wizard can show REAL content above each Approve button
 * instead of the "awaiting AI preparation" placeholder.
 *
 * This module is pure data-loading: it runs inside an RLS-scoped
 * transaction (the caller MUST have set `app.current_tenant_id` before
 * invoking {@link loadPreparedContent}), reads from the tables / event
 * chain the pipeline jobs write to, and shapes the result per wizard
 * step. It NEVER fabricates content — where nothing has been generated
 * yet, the step's `prepared` flag is false and its arrays are empty.
 *
 * Where each step's data comes from:
 *
 *   Step 1 Hypotheses    — `ip_search_verdict` (one row per hypothesis,
 *                          carries the IP / prior-art verdict + analysis).
 *   Step 2 Activities    — proposed Core / Supporting activities from the
 *                          latest `ACTIVITY_REGISTER_DRAFTED` event payload
 *                          (`proposed_activities[]`, Div 355 anchors +
 *                          confidence), reconciled against accepted
 *                          `activity` rows.
 *   Step 3 Apportionment — `expenditure` + `expenditure_line` totals, with
 *                          each expenditure's current activity mapping
 *                          projected from the EXPENDITURE_MAPPED /
 *                          EXPENDITURE_APPORTIONED / EXPENDITURE_UNMAPPED
 *                          event chain.
 *   Step 4 Evidence      — `event` artefacts bound to each `activity` via
 *                          the live ARTEFACT_LINKED / ARTEFACT_UNLINKED
 *                          chain (latest event per triple wins).
 *   Step 5 Narrative     — `narrative_draft` segments per activity /
 *                          section, with citing-event references.
 *   Step 6 Review        — a roll-up of the five steps' counts.
 *
 * Belt-and-suspenders tenant scoping: every scan carries an explicit
 * `tenant_id = ${tenantId}` predicate IN ADDITION to the RLS GUC, mirroring
 * the convention in `workflow.ts:loadWorkflowSnapshot` and the IP-search /
 * activity-register routes.
 */

import type { SqlClient } from './workflow.js';

/* ───────────────────────────── Step shapes ─────────────────────────── */

/** Step 1 — one hypothesis the AI surfaced + its IP / prior-art verdict. */
export interface PreparedHypothesis {
  verdict_id: string;
  activity_id: string;
  activity_code: string | null;
  activity_title: string | null;
  hypothesis_text: string;
  /** Consultant-approved (or, pre-approval, the LLM draft) verdict. */
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** LLM-suggested verdict before consultant review. */
  draft_verdict: 'pass' | 'fail' | 'inconclusive' | null;
  analysis_markdown: string;
  approved_at: string | null;
  /** 'approved' once a consultant signed off, else 'draft'. */
  status: 'draft' | 'approved';
}

/** Step 2 — one Core / Supporting activity the AI proposed. */
export interface PreparedActivity {
  /** Stable id the AI assigned when clustering the evidence. */
  proposed_id: string;
  kind: 'core' | 'supporting';
  title: string;
  /** Div 355 statutory anchor: s.355-25 (core) / s.355-30 (supporting). */
  statutory_anchor: string | null;
  hypothesis: string | null;
  technical_uncertainty: string | null;
  /** Why the AI clustered this evidence into this activity. */
  rationale: string | null;
  /** AI confidence 0..1 (null when the draft carried none). */
  confidence: number | null;
  /** True once this proposal has been accepted into an `activity` row. */
  accepted: boolean;
  /** The accepted `activity` row id + code (null while still pending). */
  activity_id: string | null;
  activity_code: string | null;
}

/** Step 3 — one ledger expenditure mapped (or not) onto activities. */
export interface PreparedExpenditureLine {
  expenditure_id: string;
  vendor_name: string;
  reference: string | null;
  expenditure_date: string;
  total_amount: number;
  /** null = unmapped; 'single' or 'apportioned' otherwise. */
  mapping_kind: 'single' | 'apportioned' | null;
  /** Activities this expenditure rolls up into (with % for apportioned). */
  allocations: Array<{
    activity_id: string;
    activity_code: string;
    activity_title: string;
    /** 100 for a single mapping; the apportioned share otherwise. */
    percentage: number;
  }>;
}

/** Step 4 — one activity with the artefacts the AI bound to it. */
export interface PreparedActivityEvidence {
  activity_id: string;
  activity_code: string;
  activity_title: string;
  artefacts: Array<{
    artefact_kind: string;
    artefact_id: string;
    link_reason: string | null;
    linked_at: string;
    /** Short human label for the bound event (its kind), when resolvable. */
    artefact_label: string | null;
  }>;
}

/** Step 5 — one drafted narrative section for an activity. */
export interface PreparedNarrativeSection {
  activity_id: string;
  activity_code: string;
  activity_title: string;
  section_kind: string;
  status: 'streaming' | 'complete' | 'accepted' | 'archived';
  /** Flattened prose text of the section's segments (citation-preserving). */
  segments: Array<{
    type: 'prose' | 'claim';
    text: string;
    /** Event ids this segment cites (empty for prose). */
    citing_events: string[];
  }>;
}

/** A per-step envelope: `prepared` is false when nothing was generated. */
export interface PreparedStep<T> {
  prepared: boolean;
  items: T[];
}

export interface PreparedContent {
  step1_hypotheses: PreparedStep<PreparedHypothesis>;
  step2_activities: PreparedStep<PreparedActivity>;
  step3_apportionment: PreparedStep<PreparedExpenditureLine> & {
    /** Sum of total_amount across all expenditures (cents-free AUD). */
    total_amount: number;
    /** Sum of total_amount that is mapped onto at least one activity. */
    total_mapped: number;
  };
  step4_evidence: PreparedStep<PreparedActivityEvidence>;
  step5_narrative: PreparedStep<PreparedNarrativeSection>;
  step6_review: {
    hypothesis_count: number;
    activity_count: number;
    activities_accepted: number;
    expenditure_count: number;
    expenditure_mapped: number;
    evidence_links: number;
    narrative_sections: number;
    narrative_sections_accepted: number;
  };
}

/* ─────────────────────── Internal row shapes ───────────────────────── */

interface VerdictRow {
  id: string;
  activity_id: string;
  activity_code: string | null;
  activity_title: string | null;
  hypothesis_text: string;
  verdict: 'pass' | 'fail' | 'inconclusive';
  draft_verdict: 'pass' | 'fail' | 'inconclusive' | null;
  analysis_markdown: string;
  approved_at: string | null;
}

interface ProposedRow {
  proposed_id: string;
  proposed_kind: string;
  title: string;
  statutory_anchor: string | null;
  hypothesis: string | null;
  technical_uncertainty: string | null;
  rationale: string | null;
  confidence: string | null;
  accepted_activity_id: string | null;
  accepted_activity_code: string | null;
}

interface ExpenditureRow {
  id: string;
  vendor_name: string;
  reference: string | null;
  expenditure_date: string;
  total_amount: string;
}

interface MappingEventRow {
  expenditure_id: string;
  kind: 'EXPENDITURE_MAPPED' | 'EXPENDITURE_APPORTIONED' | 'EXPENDITURE_UNMAPPED';
  payload: Record<string, unknown>;
  captured_at: string;
  id: string;
}

interface ActivityRow {
  id: string;
  code: string;
  title: string;
}

interface LinkEventRow {
  activity_id: string;
  artefact_kind: string;
  artefact_id: string;
  kind: 'ARTEFACT_LINKED' | 'ARTEFACT_UNLINKED';
  link_reason: string | null;
  captured_at: string;
}

interface NarrativeRow {
  activity_id: string;
  activity_code: string;
  activity_title: string;
  section_kind: string;
  status: 'streaming' | 'complete' | 'accepted' | 'archived';
  segments: unknown;
}

/* ────────────── Div 355 anchor for a proposed activity kind ─────────── */

function anchorForKind(kind: string): string | null {
  if (kind === 'core') return 's.355-25';
  if (kind === 'supporting') return 's.355-30';
  return null;
}

/**
 * Coerce an `unknown` JSONB-payload value to a string without tripping the
 * `no-base-to-string` lint (which fires on `String(unknown)`): only string
 * / number / boolean primitives are stringified; anything else (object,
 * null, undefined) maps to the empty string.
 */
function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Coerce an `unknown` JSONB value to a number; non-numerics → 0. */
function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Project the EXPENDITURE_* mapping chain for one expenditure into the
 * current mapping. Mirrors `lib/expenditure-projection.ts:projectMapping`
 * — the latest event by (captured_at, id) wins; UNMAPPED clears it.
 */
function projectExpenditureMapping(events: MappingEventRow[]): {
  kind: 'single' | 'apportioned' | null;
  allocations: PreparedExpenditureLine['allocations'];
} {
  if (events.length === 0) return { kind: null, allocations: [] };
  const sorted = [...events].sort((a, b) => {
    if (a.captured_at !== b.captured_at) return a.captured_at < b.captured_at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  const latest = sorted[0]!;
  if (latest.kind === 'EXPENDITURE_UNMAPPED') return { kind: null, allocations: [] };
  if (latest.kind === 'EXPENDITURE_MAPPED') {
    const p = latest.payload;
    return {
      kind: 'single',
      allocations: [
        {
          activity_id: str(p['activity_id']),
          activity_code: str(p['activity_code']),
          activity_title: str(p['activity_title']),
          percentage: 100,
        },
      ],
    };
  }
  // EXPENDITURE_APPORTIONED
  const raw = (latest.payload['allocations'] as Array<Record<string, unknown>>) ?? [];
  return {
    kind: 'apportioned',
    allocations: raw.map((a) => ({
      activity_id: str(a['activity_id']),
      activity_code: str(a['activity_code']),
      activity_title: str(a['activity_title']),
      percentage: num(a['percentage']),
    })),
  };
}

/**
 * Load every wizard step's AI-prepared content for one claim.
 *
 * Caller MUST have set `app.current_tenant_id` (the route's `sql.begin`
 * wrapper does). Reads are tenant-scoped both by RLS and by explicit
 * `tenant_id` predicates.
 */
export async function loadPreparedContent(
  sql: SqlClient,
  tenantId: string,
  claimId: string,
  subjectTenantId: string,
): Promise<PreparedContent> {
  // ── Step 1: Hypotheses + IP-search verdicts ───────────────────────────
  const verdictRows = await sql<VerdictRow[]>`
    SELECT v.id::text                AS id,
           v.activity_id::text       AS activity_id,
           a.code                    AS activity_code,
           a.title                   AS activity_title,
           v.hypothesis_text,
           v.verdict,
           v.draft_verdict,
           v.analysis_markdown,
           v.approved_at::text       AS approved_at
      FROM ip_search_verdict v
      LEFT JOIN activity a ON a.id = v.activity_id AND a.tenant_id = ${tenantId}
     WHERE v.claim_id  = ${claimId}
       AND v.tenant_id = ${tenantId}
     ORDER BY v.approved_at DESC NULLS FIRST, v.hypothesis_text ASC
  `;
  const hypotheses: PreparedHypothesis[] = verdictRows.map((r) => ({
    verdict_id: r.id,
    activity_id: r.activity_id,
    activity_code: r.activity_code,
    activity_title: r.activity_title,
    hypothesis_text: r.hypothesis_text,
    verdict: r.verdict,
    draft_verdict: r.draft_verdict,
    analysis_markdown: r.analysis_markdown,
    approved_at: r.approved_at,
    status: r.approved_at === null ? 'draft' : 'approved',
  }));

  // ── Step 2: Proposed Core / Supporting activities (Div 355) ───────────
  //
  // Source: the LATEST ACTIVITY_REGISTER_DRAFTED event per project under
  // the claim (the proposal job's output), unnested over its
  // `proposed_activities[]`, LEFT JOINed against accepted activities by
  // proposed_id. Mirrors loadWorkflowSnapshot's proposed-activities CTE,
  // but selects the full proposal fields the wizard needs to render.
  const proposedRows = await sql<ProposedRow[]>`
    WITH claim_projects AS (
      SELECT DISTINCT project_id FROM (
        SELECT project_id FROM claim    WHERE id = ${claimId} AND project_id IS NOT NULL
        UNION
        SELECT project_id FROM activity WHERE claim_id = ${claimId}
      ) p
      WHERE project_id IS NOT NULL
    ),
    latest_draft AS (
      SELECT DISTINCT ON (e.project_id)
             e.project_id,
             e.tenant_id,
             e.payload
        FROM event e
        JOIN claim_projects cp ON cp.project_id = e.project_id
       WHERE e.tenant_id = ${tenantId}
         AND e.kind = 'ACTIVITY_REGISTER_DRAFTED'
       ORDER BY e.project_id, e.captured_at DESC, e.received_at DESC, e.id DESC
    ),
    proposed AS (
      SELECT ld.tenant_id,
             ld.project_id,
             (pa ->> 'proposed_id')           AS proposed_id,
             (pa ->> 'kind')                  AS proposed_kind,
             (pa ->> 'name')                  AS title,
             (pa ->> 'statutory_anchor')      AS statutory_anchor,
             (pa ->> 'proposed_hypothesis')   AS hypothesis,
             (pa ->> 'proposed_uncertainty')  AS technical_uncertainty,
             (pa ->> 'rationale')             AS rationale,
             (pa ->> 'confidence')            AS confidence
        FROM latest_draft ld,
             LATERAL jsonb_array_elements(ld.payload -> 'proposed_activities') AS pa
    )
    SELECT p.proposed_id,
           p.proposed_kind,
           p.title,
           p.statutory_anchor,
           p.hypothesis,
           p.technical_uncertainty,
           p.rationale,
           p.confidence,
           a.id::text   AS accepted_activity_id,
           a.code       AS accepted_activity_code
      FROM proposed p
      LEFT JOIN activity a
             ON a.tenant_id   = ${tenantId}
            AND a.claim_id    = ${claimId}
            AND a.proposed_id::text = p.proposed_id
     ORDER BY p.proposed_kind DESC,
              (p.confidence)::numeric DESC NULLS LAST,
              p.title ASC
  `;
  const activities: PreparedActivity[] = proposedRows.map((r) => {
    const kind = r.proposed_kind === 'supporting' ? 'supporting' : 'core';
    return {
      proposed_id: r.proposed_id,
      kind,
      title: r.title,
      // Prefer the anchor the synthesizer pinned; fall back to the
      // kind-derived default if an older draft omitted it.
      statutory_anchor: r.statutory_anchor ?? anchorForKind(kind),
      hypothesis: r.hypothesis,
      technical_uncertainty: r.technical_uncertainty,
      rationale: r.rationale,
      confidence: r.confidence === null ? null : Number(r.confidence),
      accepted: r.accepted_activity_id !== null,
      activity_id: r.accepted_activity_id,
      activity_code: r.accepted_activity_code,
    };
  });

  // Load the claim's accepted activities once — used by step 3 (resolve
  // allocation labels) and step 4 (evidence bindings). The mapping-event
  // payloads are inconsistent about carrying activity_code / activity_title
  // (the consultant route enriches them; the rule engine does not), so we
  // resolve labels from the canonical `activity` table by activity_id.
  const claimActivityRows = await sql<ActivityRow[]>`
    SELECT id::text AS id, code, title
      FROM activity
     WHERE claim_id  = ${claimId}
       AND tenant_id = ${tenantId}
     ORDER BY code ASC
  `;
  const activityLabelById = new Map<string, { code: string; title: string }>();
  for (const a of claimActivityRows) {
    activityLabelById.set(a.id, { code: a.code, title: a.title });
  }

  // ── Step 3: Apportionment (ledger → activities) ───────────────────────
  //
  // Load every (non-voided) expenditure for the claim's subject_tenant,
  // bound to this claim where claim_id is set; project each one's mapping
  // from the EXPENDITURE_* event chain.
  const expRows = await sql<ExpenditureRow[]>`
    SELECT id::text               AS id,
           vendor_name,
           reference,
           expenditure_date::text AS expenditure_date,
           total_amount::text     AS total_amount
      FROM expenditure
     WHERE tenant_id = ${tenantId}
       AND (claim_id = ${claimId}
            OR (claim_id IS NULL AND subject_tenant_id = ${subjectTenantId}))
       AND voided_at IS NULL
     ORDER BY expenditure_date DESC, vendor_name ASC
  `;
  const mappingRows = await sql<MappingEventRow[]>`
    SELECT (payload ->> 'expenditure_id') AS expenditure_id,
           kind,
           payload,
           captured_at::text              AS captured_at,
           id::text                       AS id
      FROM event
     WHERE tenant_id = ${tenantId}
       AND kind IN ('EXPENDITURE_MAPPED', 'EXPENDITURE_APPORTIONED', 'EXPENDITURE_UNMAPPED')
       AND (payload ->> 'expenditure_id') IN (
             SELECT id::text FROM expenditure
              WHERE tenant_id = ${tenantId}
                AND (claim_id = ${claimId}
                     OR (claim_id IS NULL AND subject_tenant_id = ${subjectTenantId}))
           )
  `;
  const mappingByExp = new Map<string, MappingEventRow[]>();
  for (const m of mappingRows) {
    const list = mappingByExp.get(m.expenditure_id) ?? [];
    list.push(m);
    mappingByExp.set(m.expenditure_id, list);
  }
  let totalAmount = 0;
  let totalMapped = 0;
  const apportionment: PreparedExpenditureLine[] = expRows.map((r) => {
    const amount = Number(r.total_amount);
    totalAmount += amount;
    const projected = projectExpenditureMapping(mappingByExp.get(r.id) ?? []);
    if (projected.kind !== null) totalMapped += amount;
    // Resolve allocation labels from the activity table — payload labels
    // are unreliable (see comment above the activity load).
    const allocations = projected.allocations.map((alloc) => {
      const label = activityLabelById.get(alloc.activity_id);
      return {
        activity_id: alloc.activity_id,
        activity_code: label?.code ?? alloc.activity_code,
        activity_title: label?.title ?? alloc.activity_title,
        percentage: alloc.percentage,
      };
    });
    return {
      expenditure_id: r.id,
      vendor_name: r.vendor_name,
      reference: r.reference,
      expenditure_date: r.expenditure_date,
      total_amount: amount,
      mapping_kind: projected.kind,
      allocations,
    };
  });

  // ── Step 4: Evidence bound to each activity ───────────────────────────
  const linkRows =
    claimActivityRows.length === 0
      ? []
      : await sql<LinkEventRow[]>`
          WITH activities AS (
            SELECT id::text AS id FROM activity
             WHERE claim_id = ${claimId} AND tenant_id = ${tenantId}
          )
          SELECT (payload ->> 'activity_id')   AS activity_id,
                 (payload ->> 'artefact_kind') AS artefact_kind,
                 (payload ->> 'artefact_id')   AS artefact_id,
                 kind,
                 (payload ->> 'link_reason')   AS link_reason,
                 captured_at::text             AS captured_at
            FROM event
           WHERE tenant_id = ${tenantId}
             AND kind IN ('ARTEFACT_LINKED', 'ARTEFACT_UNLINKED')
             AND (payload ->> 'activity_id') IN (SELECT id FROM activities)
           ORDER BY captured_at ASC, received_at ASC, id ASC
        `;
  // Fold: latest event per (activity, artefact_kind, artefact_id) wins.
  type LiveArtefact = {
    artefact_kind: string;
    artefact_id: string;
    link_reason: string | null;
    linked_at: string;
  };
  const liveByActivity = new Map<string, Map<string, LiveArtefact>>();
  for (const row of linkRows) {
    const triple = `${row.artefact_kind}|${row.artefact_id}`;
    const live: Map<string, LiveArtefact> =
      liveByActivity.get(row.activity_id) ?? new Map<string, LiveArtefact>();
    if (row.kind === 'ARTEFACT_LINKED') {
      live.set(triple, {
        artefact_kind: row.artefact_kind,
        artefact_id: row.artefact_id,
        link_reason: row.link_reason,
        linked_at: row.captured_at,
      });
    } else {
      live.delete(triple);
    }
    liveByActivity.set(row.activity_id, live);
  }
  // Resolve a short label (the bound event's kind) for each artefact event.
  const boundEventIds = new Set<string>();
  for (const live of liveByActivity.values()) {
    for (const a of live.values()) {
      if (a.artefact_kind === 'event') boundEventIds.add(a.artefact_id);
    }
  }
  const labelById = new Map<string, string>();
  if (boundEventIds.size > 0) {
    const labelRows = await sql<{ id: string; kind: string }[]>`
      SELECT id::text AS id, kind
        FROM event
       WHERE tenant_id = ${tenantId}
         AND id = ANY(${[...boundEventIds]}::uuid[])
    `;
    for (const lr of labelRows) labelById.set(lr.id, lr.kind);
  }
  const evidence: PreparedActivityEvidence[] = claimActivityRows.map((a) => {
    const live = liveByActivity.get(a.id);
    const artefacts = live
      ? Array.from(live.values())
          .sort((x, y) => x.linked_at.localeCompare(y.linked_at))
          .map((art) => ({
            artefact_kind: art.artefact_kind,
            artefact_id: art.artefact_id,
            link_reason: art.link_reason,
            linked_at: art.linked_at,
            artefact_label:
              art.artefact_kind === 'event' ? (labelById.get(art.artefact_id) ?? null) : null,
          }))
      : [];
    return {
      activity_id: a.id,
      activity_code: a.code,
      activity_title: a.title,
      artefacts,
    };
  });

  // ── Step 5: Drafted narrative sections (cited) ────────────────────────
  const narrRows = await sql<NarrativeRow[]>`
    SELECT nd.activity_id::text AS activity_id,
           a.code               AS activity_code,
           a.title              AS activity_title,
           nd.section_kind,
           nd.status,
           nd.segments
      FROM narrative_draft nd
      JOIN activity a ON a.id = nd.activity_id AND a.tenant_id = ${tenantId}
     WHERE nd.tenant_id = ${tenantId}
       AND a.claim_id   = ${claimId}
       AND nd.status   <> 'archived'
     ORDER BY a.code ASC, nd.section_kind ASC
  `;
  const narrative: PreparedNarrativeSection[] = narrRows.map((r) => {
    const rawSegments = Array.isArray(r.segments)
      ? (r.segments as Array<Record<string, unknown>>)
      : [];
    return {
      activity_id: r.activity_id,
      activity_code: r.activity_code,
      activity_title: r.activity_title,
      section_kind: r.section_kind,
      status: r.status,
      segments: rawSegments.map((s) => ({
        type: s['type'] === 'claim' ? ('claim' as const) : ('prose' as const),
        text: typeof s['text'] === 'string' ? s['text'] : '',
        citing_events: Array.isArray(s['citing_events'])
          ? (s['citing_events'] as unknown[]).map((c) => String(c))
          : [],
      })),
    };
  });

  // ── Step 6: Review roll-up ────────────────────────────────────────────
  const evidenceLinks = evidence.reduce((sum, e) => sum + e.artefacts.length, 0);
  const narrativeAccepted = narrative.filter((n) => n.status === 'accepted').length;

  return {
    step1_hypotheses: { prepared: hypotheses.length > 0, items: hypotheses },
    step2_activities: { prepared: activities.length > 0, items: activities },
    step3_apportionment: {
      prepared: apportionment.length > 0,
      items: apportionment,
      total_amount: Math.round(totalAmount * 100) / 100,
      total_mapped: Math.round(totalMapped * 100) / 100,
    },
    step4_evidence: { prepared: evidenceLinks > 0, items: evidence },
    step5_narrative: { prepared: narrative.length > 0, items: narrative },
    step6_review: {
      hypothesis_count: hypotheses.length,
      activity_count: activities.length,
      activities_accepted: activities.filter((a) => a.accepted).length,
      expenditure_count: apportionment.length,
      expenditure_mapped: apportionment.filter((e) => e.mapping_kind !== null).length,
      evidence_links: evidenceLinks,
      narrative_sections: narrative.length,
      narrative_sections_accepted: narrativeAccepted,
    },
  };
}
