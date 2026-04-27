import { privilegedSql } from '@cpa/db/client';
import type { ScoreInput, ScoreRule, SqlClient } from './types.js';

/**
 * 10 audit-readiness scoring rules per design doc §7.1, adapted to
 * executable SQL against the P3 schemas (event, time_entry, signing_request,
 * integration_connection, media_artefact).
 *
 * Each rule has its own SQL query — no batching — so a slow rule doesn't
 * starve the others, and so a future cron worker can opt-in to a subset
 * (e.g. for a "score preview" before all rules can run). Total: 100 pts.
 */

/**
 * Resolve the sql client for a rule. When `input.sql_client` is provided
 * (tests + a future per-tenant batched recompute job), use that; otherwise
 * fall back to `privilegedSql`. The recompute job runs as cron (no per-tenant
 * GUC) so privilegedSql — which bypasses RLS — is the right default.
 *
 * The rules then cast their query result rows to local interfaces; this
 * keeps the SqlClient contract minimal while still giving each rule strict
 * typed access to the columns it queries.
 */
function getSql(input: ScoreInput): SqlClient {
  if (input.sql_client) {
    return input.sql_client;
  }
  // postgres-js's tagged-template signature is the structural superset of
  // SqlClient (it returns `PendingQuery<T>` which extends Promise<RowList<T>>).
  // The two-step cast through `unknown` avoids TS's structural-mismatch
  // diagnostic on the return-type covariance — the runtime contract is the
  // same: rows[] in, rows[] out.
  return privilegedSql as unknown as SqlClient;
}

/** Row shape for COUNT-only queries returning `n`. */
interface CountRow {
  n: number;
}

/** Row shape for the `no_30day_gap` query — a single nullable max_gap. */
interface MaxGapRow {
  max_gap: number | null;
}

/** Row shape for "every event has artefact". */
interface RatioRow {
  total: number;
  with_artefact: number;
}

/** Row shape for time-tracking active. */
interface TimeTrackingRow {
  active_payroll: number;
  recent_entries: number;
}

/** Row shape for apportionment_complete. */
interface ApportionmentRow {
  total: number;
  apportioned: number;
}

/** Row shape for classifier confidence. */
interface AvgConfidenceRow {
  avg_conf: number | null;
}

/** Row shape for override_rate_low. */
interface OverrideRateRow {
  overrides: number;
  non_overrides: number;
}

export const SCORING_RULES: ScoreRule[] = [
  {
    id: 'has_recent_capture',
    label: 'Recent evidence',
    max_pts: 10,
    fn: async (input) => {
      const sql = getSql(input);
      const rows = await sql<CountRow>`
        SELECT count(*)::int AS n FROM event
         WHERE subject_tenant_id = ${input.subject_tenant_id}
           AND captured_at > NOW() - INTERVAL '7 days'
      `;
      const n = rows[0]?.n ?? 0;
      return { earned: n > 0 ? 10 : 0, details: `${n} events in last 7d` };
    },
  },
  {
    id: 'hypothesis_per_core',
    label: 'Hypotheses pre-dated',
    max_pts: 15,
    fn: async (input) => {
      const sql = getSql(input);
      const rows = await sql<CountRow>`
        SELECT count(*)::int AS n FROM event
         WHERE subject_tenant_id = ${input.subject_tenant_id}
           AND kind = 'HYPOTHESIS'
           AND captured_at > NOW() - INTERVAL '90 days'
      `;
      const n = rows[0]?.n ?? 0;
      const earned = n >= 3 ? 15 : n * 5;
      return { earned, details: `${n} hypotheses in last 90d` };
    },
  },
  {
    id: 'no_30day_gap',
    label: 'No 30-day evidence gaps',
    max_pts: 10,
    fn: async (input) => {
      const sql = getSql(input);
      // Use the lag() window to compute consecutive gaps in days, then take
      // the max. NULL when fewer than two events in the window — treat as
      // 0 (a single-event chain hasn't had time to gap).
      const rows = await sql<MaxGapRow>`
        SELECT max(gap_days)::int AS max_gap FROM (
          SELECT EXTRACT(DAY FROM (captured_at - lag(captured_at) OVER (ORDER BY captured_at))) AS gap_days
            FROM event
           WHERE subject_tenant_id = ${input.subject_tenant_id}
             AND captured_at > NOW() - INTERVAL '180 days'
        ) gaps
      `;
      const maxGap = rows[0]?.max_gap ?? 0;
      return { earned: maxGap < 30 ? 10 : 0, details: `max gap ${maxGap} days` };
    },
  },
  {
    id: 'every_event_has_artefact',
    label: 'Evidence linked',
    max_pts: 15,
    fn: async (input) => {
      const sql = getSql(input);
      const rows = await sql<RatioRow>`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM media_artefact m WHERE m.event_id = event.id
          ))::int AS with_artefact
        FROM event
         WHERE subject_tenant_id = ${input.subject_tenant_id}
           AND kind != 'OVERRIDE'
           AND captured_at > NOW() - INTERVAL '90 days'
      `;
      const row = rows[0];
      const total = row?.total ?? 0;
      const withArtefact = row?.with_artefact ?? 0;
      if (total === 0) return { earned: 0, details: 'no events to evaluate' };
      const ratio = withArtefact / total;
      return {
        earned: Math.round(ratio * 15),
        details: `${withArtefact}/${total} have artefact (${Math.round(ratio * 100)}%)`,
      };
    },
  },
  {
    id: 'time_tracking_active',
    label: 'Time tracking',
    max_pts: 10,
    fn: async (input) => {
      const sql = getSql(input);
      const rows = await sql<TimeTrackingRow>`
        SELECT
          (SELECT count(*) FROM integration_connection
            WHERE tenant_id = ${input.tenant_id}
              AND provider IN ('employment_hero','keypay','deputy','xero_payroll')
              AND sync_state != 'failed')::int AS active_payroll,
          (SELECT count(*) FROM time_entry
            WHERE subject_tenant_id = ${input.subject_tenant_id}
              AND created_at > NOW() - INTERVAL '7 days')::int AS recent_entries
      `;
      const row = rows[0];
      const activePayroll = row?.active_payroll ?? 0;
      const recentEntries = row?.recent_entries ?? 0;
      if (activePayroll > 0) return { earned: 10, details: `payroll integration active` };
      if (recentEntries > 0)
        return { earned: 5, details: `${recentEntries} manual entries last 7d` };
      return { earned: 0, details: 'no time tracking' };
    },
  },
  {
    id: 'apportionment_complete',
    label: 'Apportionment complete',
    max_pts: 10,
    fn: async (input) => {
      const sql = getSql(input);
      const rows = await sql<ApportionmentRow>`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE apportionment_pct IS NOT NULL)::int AS apportioned
        FROM time_entry
         WHERE subject_tenant_id = ${input.subject_tenant_id}
           AND created_at > NOW() - INTERVAL '90 days'
      `;
      const row = rows[0];
      const total = row?.total ?? 0;
      const apportioned = row?.apportioned ?? 0;
      if (total === 0) return { earned: 0, details: 'no time entries' };
      const ratio = apportioned / total;
      return {
        earned: Math.round(ratio * 10),
        details: `${apportioned}/${total} apportioned`,
      };
    },
  },
  {
    id: 'engagement_letter_signed',
    label: 'Engagement signed',
    max_pts: 10,
    fn: async (input) => {
      const sql = getSql(input);
      const rows = await sql<CountRow>`
        SELECT count(*)::int AS n FROM signing_request
         WHERE subject_tenant_id = ${input.subject_tenant_id}
           AND document_kind = 'engagement_letter'
           AND status = 'completed'
      `;
      const n = rows[0]?.n ?? 0;
      return { earned: n > 0 ? 10 : 0, details: n > 0 ? 'signed' : 'not signed' };
    },
  },
  {
    id: 'classifier_avg_confidence',
    label: 'Classification quality',
    max_pts: 10,
    fn: async (input) => {
      const sql = getSql(input);
      // classification is jsonb; extract the float subfield. avg() over an
      // empty set returns NULL — treat as 0 confidence (no signal).
      const rows = await sql<AvgConfidenceRow>`
        SELECT avg((classification->>'confidence')::float)::float AS avg_conf
          FROM event
         WHERE subject_tenant_id = ${input.subject_tenant_id}
           AND classification IS NOT NULL
           AND captured_at > NOW() - INTERVAL '30 days'
      `;
      const avg = rows[0]?.avg_conf ?? 0;
      return { earned: Math.round(avg * 10), details: `mean confidence ${avg.toFixed(2)}` };
    },
  },
  {
    id: 'override_rate_low',
    label: 'Low override rate',
    max_pts: 5,
    fn: async (input) => {
      const sql = getSql(input);
      const rows = await sql<OverrideRateRow>`
        SELECT
          count(*) FILTER (WHERE kind = 'OVERRIDE')::int AS overrides,
          count(*) FILTER (WHERE kind != 'OVERRIDE')::int AS non_overrides
        FROM event
         WHERE subject_tenant_id = ${input.subject_tenant_id}
           AND captured_at > NOW() - INTERVAL '30 days'
      `;
      const row = rows[0];
      const overrides = row?.overrides ?? 0;
      const nonOverrides = row?.non_overrides ?? 0;
      if (nonOverrides === 0) return { earned: 0, details: 'no events' };
      const rate = overrides / nonOverrides;
      return { earned: rate < 0.3 ? 5 : 0, details: `override rate ${(rate * 100).toFixed(0)}%` };
    },
  },
  {
    id: 'evidence_kinds_diverse',
    label: 'Diverse evidence kinds',
    max_pts: 5,
    fn: async (input) => {
      const sql = getSql(input);
      const rows = await sql<CountRow>`
        SELECT count(DISTINCT kind)::int AS n FROM event
         WHERE subject_tenant_id = ${input.subject_tenant_id}
           AND kind != 'OVERRIDE'
           AND captured_at > NOW() - INTERVAL '30 days'
      `;
      const n = rows[0]?.n ?? 0;
      // 4+ distinct kinds → full 5 pts; otherwise 1.25 per kind, floored.
      return { earned: n >= 4 ? 5 : Math.floor(n * 1.25), details: `${n} distinct kinds` };
    },
  },
];

export const TOTAL_MAX_PTS = SCORING_RULES.reduce((sum, r) => sum + r.max_pts, 0);
