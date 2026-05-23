#!/usr/bin/env tsx
/**
 * Score the platform's accuracy against the stress-test seed ground truth
 * (40 claimants in the c0a3 namespace, seeded by seed-stress-test.ts).
 *
 *   pnpm exec tsx --env-file=../../.env score-stress-test.ts
 *   pnpm exec tsx --env-file=../../.env score-stress-test.ts --last-n=5
 *
 * Writes results to two sinks:
 *   1. tools/scripts/eval-results/&lt;ISO-ts&gt;.json   — full per-claim +
 *      aggregate metrics, diff-friendly, git-trackable.
 *   2. eval_run + eval_run_claim Postgres tables    — queryable history.
 *
 * Flags:
 *   --last-n=N     after scoring, print the last N runs from the JSON
 *                  results directory as a delta table.
 *   --skip-db      compute + write JSON only, don't write DB rows. Useful
 *                  for read-only environments or when the migration
 *                  hasn't been applied yet.
 *   --skip-json    compute + write DB rows only, don't write a JSON file.
 *
 * Mirrors score-bulk-claims.ts's scoring logic exactly — the two files
 * differ only in tenant prefix, claimant cycling, and the persistence
 * sinks. Refactor candidate once the stress-test scoring stabilises.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privilegedSql, sql } from '@cpa/db/client';
import { DOMAINS } from './_bulk-claim-domains.js';

const TENANT_PREFIX = '00000000-0000-4000-8000-c0a3';
const N_CLAIMS = 40;
const RESULTS_DIR = 'eval-results';
const SEED_NAME = 'stress-test-480m';

// ── CLI flag parsing ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const lastNFlag = args.find((a) => a.startsWith('--last-n='));
const LAST_N = lastNFlag ? parseInt(lastNFlag.split('=')[1] ?? '0', 10) : 0;
const SKIP_DB = args.includes('--skip-db');
const SKIP_JSON = args.includes('--skip-json');

// ── Shapes (mirror score-bulk-claims.ts) ─────────────────────────────
interface ExpenditureRow {
  id: string;
  tenant_id: string;
  total_amount: string;
  ingest_band: 'rd_critical' | 'rd_supporting' | 'non_rd' | null;
  mapping_state: 'mapped' | 'apportioned' | 'unmapped' | 'voided';
  classification_kind: string | null;
}
interface NoteRow {
  id: string;
  tenant_id: string;
  declared_kind: string;
  rd_band_hint: 'rd_relevant' | 'non_rd' | null;
  classification_kind: string | null;
}
interface ClaimExpStats {
  total_n: number;
  total_amount: number;
  rd_amount_total: number;
  rd_amount_kept: number;
  non_rd_amount_total: number;
  non_rd_amount_caught: number;
  classified_n: number;
}
interface ClaimNoteStats {
  total: number;
  rd_relevant: number;
  non_rd_contam: number;
  classified: number;
  contamination_caught: number;
  rd_kept: number;
}
interface ClaimReport {
  idx: number;
  tenant_id: string;
  claim_id: string;
  firm: string;
  claimant: string;
  domain_slug: string;
  exp: ClaimExpStats;
  notes: ClaimNoteStats;
}

function tenantIdFor(idx: number): string {
  return `${TENANT_PREFIX}${(idx + 1).toString().padStart(2, '0')}010000`;
}
function claimIdFor(idx: number): string {
  return `${TENANT_PREFIX}${(idx + 1).toString().padStart(2, '0')}050000`;
}
function cycleIndex(idx: number): number {
  return Math.floor(idx / DOMAINS.length) + 1;
}
function displayFirmName(idx: number): string {
  return `${DOMAINS[idx % DOMAINS.length]!.firm.name} (stress-${cycleIndex(idx)})`;
}
function displayClaimantName(idx: number): string {
  return `${DOMAINS[idx % DOMAINS.length]!.claimant.name} (S${cycleIndex(idx)})`;
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 0;
  return (num / denom) * 100;
}
function pctFmt(num: number, denom: number): string {
  if (denom === 0) return ' n/a ';
  return pct(num, denom).toFixed(2).padStart(6) + '%';
}
function aud(n: number): string {
  return '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ── DB loaders (verbatim from score-bulk-claims.ts) ──────────────────
async function loadExpenditures(tenantId: string): Promise<ExpenditureRow[]> {
  return await privilegedSql<ExpenditureRow[]>`
    WITH ingest AS (
      SELECT
        (payload->>'expenditure_id')::uuid AS exp_id,
        payload->>'rd_band_hint'           AS band,
        classification->>'kind'            AS classification_kind
      FROM event
      WHERE tenant_id = ${tenantId}
        AND kind = 'EXPENDITURE_INGESTED'
    ),
    unmapped_by_event AS (
      SELECT DISTINCT ON ((payload->>'expenditure_id')::uuid)
        (payload->>'expenditure_id')::uuid AS exp_id,
        kind
      FROM event
      WHERE tenant_id = ${tenantId}
        AND kind IN ('EXPENDITURE_MAPPED','EXPENDITURE_APPORTIONED','EXPENDITURE_UNMAPPED')
      ORDER BY (payload->>'expenditure_id')::uuid, captured_at DESC, id DESC
    )
    SELECT
      exp.id::text AS id,
      exp.tenant_id::text AS tenant_id,
      exp.total_amount::text AS total_amount,
      i.band AS ingest_band,
      i.classification_kind AS classification_kind,
      CASE
        WHEN exp.voided_at IS NOT NULL THEN 'voided'
        WHEN ubE.kind = 'EXPENDITURE_APPORTIONED' THEN 'apportioned'
        WHEN ubE.kind = 'EXPENDITURE_MAPPED' THEN 'mapped'
        ELSE 'unmapped'
      END AS mapping_state
    FROM expenditure exp
    LEFT JOIN ingest i        ON i.exp_id = exp.id
    LEFT JOIN unmapped_by_event ubE ON ubE.exp_id = exp.id
    WHERE exp.tenant_id = ${tenantId}
    ORDER BY exp.id
  `;
}

async function loadNotes(tenantId: string): Promise<NoteRow[]> {
  const eligibleKinds = [
    'HYPOTHESIS',
    'OBSERVATION',
    'EXPERIMENT',
    'ITERATION',
    'NEW_KNOWLEDGE',
    'UNCERTAINTY',
    'TIME_LOG',
    'ASSOCIATE_FLAG',
    'EXPENDITURE_NOTE',
    'SUPPORTING',
    'INELIGIBLE',
    'DESIGN',
  ];
  return await privilegedSql<NoteRow[]>`
    SELECT
      id::text          AS id,
      tenant_id::text   AS tenant_id,
      kind              AS declared_kind,
      payload->>'rd_band_hint' AS rd_band_hint,
      classification->>'kind'  AS classification_kind
    FROM event
    WHERE tenant_id = ${tenantId}
      AND kind = ANY(${eligibleKinds})
  `;
}

function tallyExpenditures(rows: ExpenditureRow[]): ClaimExpStats {
  const s: ClaimExpStats = {
    total_n: 0,
    total_amount: 0,
    rd_amount_total: 0,
    rd_amount_kept: 0,
    non_rd_amount_total: 0,
    non_rd_amount_caught: 0,
    classified_n: 0,
  };
  for (const r of rows) {
    const amount = Number(r.total_amount);
    s.total_n += 1;
    s.total_amount += amount;
    const band = r.ingest_band;
    if (band === 'rd_critical' || band === 'rd_supporting') s.rd_amount_total += amount;
    if (band === 'non_rd') s.non_rd_amount_total += amount;
    if (r.classification_kind !== null) {
      s.classified_n += 1;
      const classifiedRD = r.classification_kind !== 'INELIGIBLE';
      if ((band === 'rd_critical' || band === 'rd_supporting') && classifiedRD) {
        s.rd_amount_kept += amount;
      }
      // Caught = ground-truth non-R&D + classifier said INELIGIBLE.
      if (band === 'non_rd' && !classifiedRD) {
        s.non_rd_amount_caught += amount;
      }
    }
  }
  return s;
}

function tallyNotes(rows: NoteRow[]): ClaimNoteStats {
  const s: ClaimNoteStats = {
    total: rows.length,
    rd_relevant: 0,
    non_rd_contam: 0,
    classified: 0,
    contamination_caught: 0,
    rd_kept: 0,
  };
  for (const r of rows) {
    if (r.rd_band_hint === 'non_rd') s.non_rd_contam += 1;
    else if (r.rd_band_hint === 'rd_relevant') s.rd_relevant += 1;
    if (r.classification_kind !== null) {
      s.classified += 1;
      if (r.rd_band_hint === 'non_rd' && r.classification_kind === 'INELIGIBLE') {
        s.contamination_caught += 1;
      }
      if (r.rd_band_hint === 'rd_relevant' && r.classification_kind !== 'INELIGIBLE') {
        s.rd_kept += 1;
      }
    }
  }
  return s;
}

// ── Aggregate roll-up ────────────────────────────────────────────────
interface Aggregate {
  total_claims: number;
  total_expenditure: number;
  total_ineligible_expenditure: number;
  total_notes: number;
  total_contaminated_notes: number;
  note_rd_recall_pct: number;
  note_contamination_caught_pct: number;
  exp_rd_recall_pct: number;
  exp_contamination_caught_pct: number;
}
function rollUp(reports: ClaimReport[]): Aggregate {
  let totalExp = 0;
  let totalNonRdExp = 0;
  let rdTotal = 0;
  let rdKept = 0;
  let nonRdTotal = 0;
  let nonRdCaught = 0;
  let noteTotal = 0;
  let noteContam = 0;
  let noteRdRel = 0;
  let noteRdKept = 0;
  let contamCaught = 0;
  for (const r of reports) {
    totalExp += r.exp.total_amount;
    totalNonRdExp += r.exp.non_rd_amount_total;
    rdTotal += r.exp.rd_amount_total;
    rdKept += r.exp.rd_amount_kept;
    nonRdTotal += r.exp.non_rd_amount_total;
    nonRdCaught += r.exp.non_rd_amount_caught;
    noteTotal += r.notes.total;
    noteContam += r.notes.non_rd_contam;
    noteRdRel += r.notes.rd_relevant;
    noteRdKept += r.notes.rd_kept;
    contamCaught += r.notes.contamination_caught;
  }
  return {
    total_claims: reports.length,
    total_expenditure: totalExp,
    total_ineligible_expenditure: totalNonRdExp,
    total_notes: noteTotal,
    total_contaminated_notes: noteContam,
    note_rd_recall_pct: pct(noteRdKept, noteRdRel),
    note_contamination_caught_pct: pct(contamCaught, noteContam),
    exp_rd_recall_pct: pct(rdKept, rdTotal),
    exp_contamination_caught_pct: pct(nonRdCaught, nonRdTotal),
  };
}

// ── Persistence ──────────────────────────────────────────────────────
function writeJson(reports: ClaimReport[], agg: Aggregate, startedAt: Date): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = startedAt.toISOString().replace(/[:.]/g, '-');
  const path = join(RESULTS_DIR, `${ts}.json`);
  const payload = {
    seed_name: SEED_NAME,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    agents_classifier_impl: process.env.CLASSIFIER_IMPL ?? 'stub',
    agents_expenditure_classifier_impl: process.env.EXPENDITURE_CLASSIFIER_IMPL ?? 'stub',
    agents_classifier_model: process.env.CLASSIFIER_MODEL ?? null,
    agents_expenditure_classifier_model: process.env.EXPENDITURE_CLASSIFIER_MODEL ?? null,
    aggregate: agg,
    per_claim: reports.map((r) => ({
      claim_idx: r.idx,
      tenant_id: r.tenant_id,
      claim_id: r.claim_id,
      claimant: r.claimant,
      firm: r.firm,
      domain_slug: r.domain_slug,
      exp: r.exp,
      notes: r.notes,
    })),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

async function writeDb(reports: ClaimReport[], agg: Aggregate, startedAt: Date): Promise<string> {
  const classifierImpl = process.env.CLASSIFIER_IMPL ?? 'stub';
  const expClassifierImpl = process.env.EXPENDITURE_CLASSIFIER_IMPL ?? 'stub';
  const classifierModel = process.env.CLASSIFIER_MODEL ?? null;
  const expClassifierModel = process.env.EXPENDITURE_CLASSIFIER_MODEL ?? null;

  const [runRow] = await privilegedSql<{ id: string }[]>`
    INSERT INTO eval_run (
      started_at, finished_at, seed_name,
      agents_classifier_impl, agents_expenditure_classifier_impl,
      agents_classifier_model, agents_expenditure_classifier_model,
      total_claims, total_expenditure_cents, total_ineligible_expenditure_cents,
      total_notes, total_contaminated_notes,
      note_rd_recall_pct, note_contamination_caught_pct,
      exp_rd_recall_pct, exp_contamination_caught_pct
    ) VALUES (
      ${startedAt.toISOString()}::timestamptz, now(), ${SEED_NAME},
      ${classifierImpl}, ${expClassifierImpl},
      ${classifierModel}, ${expClassifierModel},
      ${agg.total_claims},
      ${Math.round(agg.total_expenditure * 100)},
      ${Math.round(agg.total_ineligible_expenditure * 100)},
      ${agg.total_notes}, ${agg.total_contaminated_notes},
      ${agg.note_rd_recall_pct.toFixed(3)}::numeric,
      ${agg.note_contamination_caught_pct.toFixed(3)}::numeric,
      ${agg.exp_rd_recall_pct.toFixed(3)}::numeric,
      ${agg.exp_contamination_caught_pct.toFixed(3)}::numeric
    )
    RETURNING id::text
  `;
  const runId = runRow!.id;

  for (const r of reports) {
    await privilegedSql`
      INSERT INTO eval_run_claim (
        eval_run_id, claim_idx, tenant_id, claim_id, claimant_name, domain_slug,
        note_rd_total, note_rd_kept, note_contamination_total, note_contamination_caught,
        exp_rd_dollars_cents, exp_rd_kept_cents,
        exp_contamination_dollars_cents, exp_contamination_caught_cents
      ) VALUES (
        ${runId}, ${r.idx}, ${r.tenant_id}, ${r.claim_id}, ${r.claimant}, ${r.domain_slug},
        ${r.notes.rd_relevant}, ${r.notes.rd_kept},
        ${r.notes.non_rd_contam}, ${r.notes.contamination_caught},
        ${Math.round(r.exp.rd_amount_total * 100)}, ${Math.round(r.exp.rd_amount_kept * 100)},
        ${Math.round(r.exp.non_rd_amount_total * 100)}, ${Math.round(r.exp.non_rd_amount_caught * 100)}
      )
    `;
  }
  return runId;
}

// ── Last-N delta reporter ────────────────────────────────────────────
interface LoadedRun {
  path: string;
  started_at: string;
  aggregate: Aggregate;
}
function loadLastNRuns(n: number): LoadedRun[] {
  if (n <= 0) return [];
  let files: string[];
  try {
    files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  files.sort().reverse();
  const picked = files.slice(0, n);
  const runs: LoadedRun[] = [];
  for (const f of picked) {
    try {
      const raw = JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8')) as {
        started_at: string;
        aggregate: Aggregate;
      };
      runs.push({ path: f, started_at: raw.started_at, aggregate: raw.aggregate });
    } catch {
      // skip malformed
    }
  }
  return runs;
}
function renderDeltaTable(runs: LoadedRun[]): void {
  if (runs.length === 0) {
    process.stdout.write('\n(no prior runs in eval-results/)\n');
    return;
  }
  process.stdout.write('\n' + '═'.repeat(96) + '\n');
  process.stdout.write(`Last ${runs.length} run(s) — accuracy drift\n`);
  process.stdout.write('═'.repeat(96) + '\n');
  process.stdout.write(
    'When                       claims  exp $          ineligible $   note R&D  note caught  exp R&D   exp caught\n',
  );
  for (const r of runs) {
    const a = r.aggregate;
    process.stdout.write(
      `${r.started_at.slice(0, 19).padEnd(22)}  ` +
        `${String(a.total_claims).padStart(4)}    ` +
        `${aud(a.total_expenditure).padStart(14)}  ` +
        `${aud(a.total_ineligible_expenditure).padStart(14)}  ` +
        `${a.note_rd_recall_pct.toFixed(2).padStart(6)}%  ` +
        `${a.note_contamination_caught_pct.toFixed(2).padStart(6)}%      ` +
        `${a.exp_rd_recall_pct.toFixed(2).padStart(6)}%  ` +
        `${a.exp_contamination_caught_pct.toFixed(2).padStart(6)}%\n`,
    );
  }
}

// ── Render ───────────────────────────────────────────────────────────
function renderAggregate(agg: Aggregate): void {
  process.stdout.write('\n' + '═'.repeat(96) + '\n');
  process.stdout.write(`Aggregate — stress-test (${agg.total_claims} claims)\n`);
  process.stdout.write('═'.repeat(96) + '\n');
  process.stdout.write(`Expenditures total ${aud(agg.total_expenditure)}\n`);
  process.stdout.write(
    `  cls recall ($)          ${pctFmt(agg.exp_rd_recall_pct, 100)}   R&D dollars kept\n`,
  );
  process.stdout.write(
    `  cls contamination caught ${pctFmt(agg.exp_contamination_caught_pct, 100)}   ` +
      `non-R&D dollars flagged INELIGIBLE (${aud(agg.total_ineligible_expenditure)} non-R&D total)\n`,
  );
  process.stdout.write(
    `Notes total ${agg.total_notes}   R&D=${agg.total_notes - agg.total_contaminated_notes}   ` +
      `contamination=${agg.total_contaminated_notes}\n`,
  );
  process.stdout.write(
    `  contamination caught   ${pctFmt(agg.note_contamination_caught_pct, 100)}\n`,
  );
  process.stdout.write(`  R&D kept               ${pctFmt(agg.note_rd_recall_pct, 100)}\n`);
}

// ── main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  process.stdout.write(`Stress-test accuracy report (${N_CLAIMS} claimants)\n`);
  process.stdout.write('─'.repeat(96) + '\n');

  const startedAt = new Date();
  const reports: ClaimReport[] = [];
  for (let i = 0; i < N_CLAIMS; i++) {
    const tenantId = tenantIdFor(i);
    const exp = await loadExpenditures(tenantId);
    if (exp.length === 0) {
      // Claim wasn't seeded — skip silently.
      continue;
    }
    const notes = await loadNotes(tenantId);
    reports.push({
      idx: i,
      tenant_id: tenantId,
      claim_id: claimIdFor(i),
      firm: displayFirmName(i),
      claimant: displayClaimantName(i),
      domain_slug: DOMAINS[i % DOMAINS.length]!.firm.slug,
      exp: tallyExpenditures(exp),
      notes: tallyNotes(notes),
    });
  }
  if (reports.length === 0) {
    process.stdout.write('\nNo claims found in c0a3 namespace — run seed-stress-test.ts first.\n');
    return;
  }

  const agg = rollUp(reports);
  renderAggregate(agg);

  if (!SKIP_JSON) {
    const path = writeJson(reports, agg, startedAt);
    process.stdout.write(`\nJSON results → ${path}\n`);
  }
  if (!SKIP_DB) {
    try {
      const runId = await writeDb(reports, agg, startedAt);
      process.stdout.write(`DB row → eval_run.id = ${runId}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('eval_run') && msg.includes('does not exist')) {
        process.stderr.write(
          `\nWARNING: eval_run / eval_run_claim tables don't exist — apply migration 0085 ` +
            `then re-run, or pass --skip-db.\n  (${msg})\n`,
        );
      } else {
        throw err;
      }
    }
  }

  if (LAST_N > 0) renderDeltaTable(loadLastNRuns(LAST_N));
}

main()
  .then(async () => {
    await sql.end();
    await privilegedSql.end();
    process.exit(0);
  })
  .catch(async (err) => {
    process.stderr.write(
      `\nFAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    try {
      await sql.end();
      await privilegedSql.end();
    } catch {
      // best-effort
    }
    process.exit(2);
  });
