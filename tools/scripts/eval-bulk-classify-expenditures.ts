#!/usr/bin/env tsx
/**
 * Eval driver — classify every EXPENDITURE_INGESTED event in the
 * bulk-claims c0a2* namespace through the platform's dedicated
 * Agent A (expenditure classifier).
 *
 *   pnpm exec tsx --env-file=../../.env \
 *     eval-bulk-classify-expenditures.ts [--concurrency=3]
 *
 *   # Live model (default outside CI; needs ANTHROPIC_API_KEY):
 *   EXPENDITURE_CLASSIFIER_IMPL=haiku pnpm exec tsx … eval-bulk-classify-expenditures.ts
 *
 *   # Deterministic regex stub (no API spend, useful as a baseline):
 *   EXPENDITURE_CLASSIFIER_IMPL=stub pnpm exec tsx … eval-bulk-classify-expenditures.ts
 *
 * Why this exists rather than just calling the generic note Classifier:
 *
 *   The original eval driver synthesised a one-line "Xero invoice from
 *   X" string and ran it through the note classifier — which only ever
 *   sees raw_text and decides between HYPOTHESIS / OBSERVATION / … /
 *   INELIGIBLE. That gives the model almost nothing to work with on a
 *   transaction (vendor name only) and so contamination caught dropped
 *   to ~40%.
 *
 *   The platform ships a dedicated ExpenditureClassifier in
 *   `@cpa/agents/classifier-expenditure` with a richer input bundle:
 *     - expenditure: vendor + description + amount + currency + date +
 *       source + kind
 *     - project:     name + industry sector + fiscal year
 *     - existing_activities: candidate matches (none in the bulk seed
 *       — Agent B's job)
 *     - recent_evidence_events: up to N most recent evidence captures
 *       for the same subject_tenant (gives the model context for what
 *       this claim is actually doing)
 *
 *   And a structured output: { decision, statutory_anchor,
 *   eligibility_probability, rationale, … }.
 *
 * Output mapping
 *   The scorer reads `event.classification->>'kind'`. We translate the
 *   dedicated agent's `decision` into that field so the existing
 *   scoring CLI continues to work without further plumbing:
 *
 *     decision='ineligible'                  → kind='INELIGIBLE'
 *     decision='eligible' + anchor='s.355-25' → kind='EXPENDITURE_NOTE'
 *     decision='eligible' + anchor='s.355-30' → kind='SUPPORTING'
 *     decision='needs_review'                → kind='EXPENDITURE_NOTE'
 *                                              with lower confidence
 *
 *   The full ExpenditureClassifierOutput shape is preserved in
 *   `classification.full` for downstream consumers that want the
 *   richer fields (rationale, probability, statutory anchor).
 *
 * Skips events that already have a non-null classification, so a
 * partial run interrupted by rate limits or a credit cap is resumable.
 */
import { parseArgs } from 'node:util';
import { makeExpenditureClassifier } from '@cpa/agents/classifier-expenditure';
import type {
  ExpenditureClassifierInput,
  ExpenditureClassifierOutput,
} from '@cpa/agents/classifier-expenditure';
import { privilegedSql, sql } from '@cpa/db/client';

const { values } = parseArgs({
  options: {
    concurrency: { type: 'string', default: '3' },
    tenant: { type: 'string' },
  },
});
const CONCURRENCY = Math.max(1, Math.min(64, Number(values.concurrency ?? '3') || 3));
const TENANT_FILTER = values.tenant;

interface IngestedEventRow {
  id: string;
  tenant_id: string;
  subject_tenant_id: string;
  project_id: string | null;
  payload: {
    expenditure_id?: string;
    vendor_name?: string;
    reference?: string | null;
    total_amount?: string;
    currency?: string;
    source?: 'xero_invoice' | 'xero_bank_tx' | 'xero_receipt' | 'manual';
    rd_band_hint?: string;
  };
  captured_at: Date | string;
}

interface ProjectRow {
  id: string;
  name: string;
  industry_sector: string | null;
}

interface RecentEvidenceRow {
  id: string;
  kind: string;
  captured_at: Date | string;
  summary: string | null;
}

async function loadIngestedEvents(): Promise<IngestedEventRow[]> {
  if (TENANT_FILTER) {
    return await privilegedSql<IngestedEventRow[]>`
      SELECT id::text, tenant_id::text, subject_tenant_id::text, project_id::text, payload, captured_at
      FROM event
      WHERE tenant_id = ${TENANT_FILTER}
        AND kind = 'EXPENDITURE_INGESTED'
        AND classification IS NULL
    `;
  }
  return await privilegedSql<IngestedEventRow[]>`
    SELECT id::text, tenant_id::text, subject_tenant_id::text, project_id::text, payload, captured_at
    FROM event
    WHERE tenant_id::text LIKE '00000000-0000-4000-8000-c0a2%'
      AND kind = 'EXPENDITURE_INGESTED'
      AND classification IS NULL
  `;
}

/** Project metadata cache keyed by project id — one load per project, not per event. */
const projectCache = new Map<string, ProjectRow | null>();
async function loadProject(projectId: string | null): Promise<ProjectRow | null> {
  if (!projectId) return null;
  if (projectCache.has(projectId)) return projectCache.get(projectId) ?? null;
  const rows = await privilegedSql<ProjectRow[]>`
    SELECT id::text, name, NULL::text AS industry_sector
    FROM project
    WHERE id = ${projectId}
  `;
  const p = rows[0] ?? null;
  projectCache.set(projectId, p);
  return p;
}

/**
 * Recent-evidence pool cached per subject_tenant — one load per claimant,
 * not per expenditure. Pulls up to 80 text events (those with a raw_text
 * payload), so each expenditure's per-row pickRecentEvidence() can slice
 * the most recent few that fall before its captured_at.
 */
const evidenceByTenant = new Map<string, RecentEvidenceRow[]>();
async function loadEvidencePool(subjectTenantId: string): Promise<RecentEvidenceRow[]> {
  const cached = evidenceByTenant.get(subjectTenantId);
  if (cached) return cached;
  const rows = await privilegedSql<RecentEvidenceRow[]>`
    SELECT
      id::text,
      kind,
      captured_at,
      LEFT(payload->>'raw_text', 200) AS summary
    FROM event
    WHERE subject_tenant_id = ${subjectTenantId}
      AND payload ? 'raw_text'
    ORDER BY captured_at DESC
    LIMIT 80
  `;
  evidenceByTenant.set(subjectTenantId, rows);
  return rows;
}

function pickRecentEvidence(
  pool: RecentEvidenceRow[],
  beforeCapturedAt: Date | string,
  max = 6,
): RecentEvidenceRow[] {
  const cutoff = new Date(beforeCapturedAt).getTime();
  const filtered = pool.filter((r) => new Date(r.captured_at).getTime() <= cutoff);
  return filtered.slice(0, max);
}

function buildInput(
  ev: IngestedEventRow,
  project: ProjectRow | null,
  recent: RecentEvidenceRow[],
): ExpenditureClassifierInput | null {
  const p = ev.payload;
  if (!p.expenditure_id || !p.vendor_name || !p.total_amount || !p.source || !p.currency) {
    return null;
  }
  const kind: 'INVOICE' | 'BANK_TX' | 'RECEIPT' =
    p.source === 'xero_invoice'
      ? 'INVOICE'
      : p.source === 'xero_bank_tx'
        ? 'BANK_TX'
        : p.source === 'xero_receipt'
          ? 'RECEIPT'
          : 'INVOICE';
  return {
    expenditure_id: p.expenditure_id,
    expenditure: {
      vendor_name: p.vendor_name,
      description: p.reference ?? null,
      total_amount: p.total_amount,
      currency: p.currency,
      expenditure_date: new Date(ev.captured_at).toISOString().slice(0, 10),
      source: p.source,
      kind,
    },
    project: {
      name: project?.name ?? '(unknown project)',
      industry_sector: project?.industry_sector ?? null,
      fiscal_year: 2026,
    },
    existing_activities: [],
    recent_evidence_events: recent.map((r) => ({
      id: r.id,
      kind: r.kind,
      captured_at: new Date(r.captured_at).toISOString(),
      summary: (r.summary ?? '(no text)').slice(0, 200),
    })),
  };
}

/**
 * Map the dedicated agent's decision back to the chain's `kind` enum so
 * the existing scorer (which reads classification->>'kind') keeps
 * working. The full ExpenditureClassifierOutput is preserved alongside
 * under classification.full for downstream consumers.
 */
function projectClassification(out: ExpenditureClassifierOutput): {
  kind: string;
  confidence: number;
  rationale: string;
  statutory_anchor: string | null;
  model: string;
  prompt_version: string;
  tokens_in: number;
  tokens_out: number;
  full: ExpenditureClassifierOutput;
} {
  let kind: string;
  if (out.decision === 'ineligible') {
    kind = 'INELIGIBLE';
  } else if (out.decision === 'eligible' && out.statutory_anchor === 's.355-30') {
    kind = 'SUPPORTING';
  } else {
    // eligible §355-25, or needs_review (treated as eligible-ish with
    // lower confidence — the consultant will still see it on the queue)
    kind = 'EXPENDITURE_NOTE';
  }
  return {
    kind,
    confidence: out.eligibility_probability,
    rationale: out.rationale,
    statutory_anchor: out.statutory_anchor === 'ineligible' ? null : out.statutory_anchor,
    model: out.model,
    prompt_version: out.prompt_version,
    tokens_in: out.tokens_in,
    tokens_out: out.tokens_out,
    full: out,
  };
}

async function processOne(
  classifier: ReturnType<typeof makeExpenditureClassifier>,
  ev: IngestedEventRow,
): Promise<{ id: string; decision: string } | { id: string; err: string }> {
  try {
    const project = await loadProject(ev.project_id);
    const pool = await loadEvidencePool(ev.subject_tenant_id);
    const recent = pickRecentEvidence(pool, ev.captured_at);
    const input = buildInput(ev, project, recent);
    if (!input) {
      return { id: ev.id, err: 'payload missing required fields' };
    }
    const output = await classifier.classify(input);
    const projected = projectClassification(output);
    await privilegedSql`
      UPDATE event
         SET classification = ${JSON.stringify(projected)}::text::jsonb
       WHERE id = ${ev.id}
    `;
    return { id: ev.id, decision: output.decision };
  } catch (err) {
    return {
      id: ev.id,
      err: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
    };
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  onResult: (r: R, i: number) => void,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i]!;
      const r = await fn(item, i);
      onResult(r, i);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const impl = process.env['EXPENDITURE_CLASSIFIER_IMPL'] ?? (process.env['CI'] ? 'stub' : 'haiku');
  const keySet = Boolean(process.env['ANTHROPIC_API_KEY']);
  process.stdout.write(
    `Eval expenditure classifier:\n  impl=${impl}  ANTHROPIC_API_KEY=${keySet ? 'set' : 'unset'}  concurrency=${CONCURRENCY}\n\n`,
  );

  const classifier = makeExpenditureClassifier();
  const rows = await loadIngestedEvents();
  process.stdout.write(`Found ${rows.length} unclassified EXPENDITURE_INGESTED events\n\n`);
  if (rows.length === 0) {
    process.stdout.write(
      'Nothing to do. (Re-seed first if you want a fresh run: seed-bulk-claims.ts)\n',
    );
    return;
  }

  const t0 = Date.now();
  const decisionTally: Record<string, number> = {};
  let okCount = 0;
  let errCount = 0;
  let lastReport = Date.now();

  await runWithConcurrency(
    rows,
    CONCURRENCY,
    (r) => processOne(classifier, r),
    (r) => {
      if ('err' in r) {
        errCount += 1;
        process.stderr.write(`  ERR ${r.id.slice(0, 8)}  ${r.err}\n`);
      } else {
        okCount += 1;
        decisionTally[r.decision] = (decisionTally[r.decision] ?? 0) + 1;
      }
      if (Date.now() - lastReport > 2000) {
        const done = okCount + errCount;
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = ((rows.length - done) / Math.max(rate, 0.01)).toFixed(0);
        process.stdout.write(
          `  progress ${done}/${rows.length}  ok=${okCount}  err=${errCount}  ${rate.toFixed(1)}/s  eta ${eta}s\n`,
        );
        lastReport = Date.now();
      }
    },
  );

  const elapsed = (Date.now() - t0) / 1000;
  process.stdout.write(
    `\nDone in ${elapsed.toFixed(1)}s · ${okCount} classified · ${errCount} errors\n`,
  );
  const sorted = Object.entries(decisionTally).sort((a, b) => b[1] - a[1]);
  process.stdout.write('Decision distribution:\n');
  for (const [d, n] of sorted) process.stdout.write(`  ${d.padEnd(20)} ${n}\n`);
  process.stdout.write(
    '\nRun score-bulk-claims.ts for the per-claim + aggregate accuracy report.\n',
  );
}

main()
  .then(async () => {
    await sql.end();
    await privilegedSql.end();
    process.exit(0);
  })
  .catch(async (err) => {
    process.stderr.write(
      `FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    try {
      await sql.end();
      await privilegedSql.end();
    } catch {
      // best-effort
    }
    process.exit(2);
  });
