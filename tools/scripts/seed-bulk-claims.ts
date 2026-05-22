#!/usr/bin/env tsx
/**
 * Bulk-claim seed — 10 distinct firm tenants, each with one claimant and
 * a "raw dump" of unprocessed FY26 evidence + transactions. The test the
 * seed is built for: dump everything into the platform and have the
 * downstream agents (classifier, activity-register synthesiser, mapping
 * engine, narrative drafter) figure out the rest with minimal operator
 * input.
 *
 *   pnpm exec tsx --env-file=../../.env seed-bulk-claims.ts
 *
 * Per claim:
 *   - 500 transactions (expenditure rows + EXPENDITURE_INGESTED events,
 *     UNMAPPED — the mapping engine has to figure out which activity)
 *   - 80 notes (text events with kinds heuristically assigned; the
 *     classification jsonb is null so Agent A can still re-classify
 *     and add rationale + statutory anchor)
 *   - 120 images (EVIDENCE_UPLOADED with filename + EXIF + minimal
 *     extracted_content — the document-analyzer agent has to OCR)
 *   - 5 PDFs, 3 voice transcripts, 2 spreadsheets, 1 partial narrative
 *
 * NO ACTIVITIES are pre-created — Agent B's job is to cluster the
 * evidence into a proposed activity register from scratch.
 *
 * Across all 10 claims: ~7,100 events + ~5,000 expenditures. ~8 min on
 * a local Postgres at 5433.
 *
 * Tenant namespace: c0a200{N:02}NNNNNN where N ∈ 01..10 is the claim
 * index. Cleanup wipes the namespace before reseeding (idempotent).
 *
 * See tools/scripts/_bulk-claim-domains.ts for the 10 domain configs
 * the generator samples from.
 */
import { createHash } from 'node:crypto';
import { insertEventWithChain, verifyChain } from '@cpa/db';
import { privilegedSql, sql } from '@cpa/db/client';
import { CONTAMINATION_THEMES, DOMAINS, type Domain } from './_bulk-claim-domains.js';

// ── Volume per claim ─────────────────────────────────────────────────
const N_TRANSACTIONS = 500;
const N_NOTES = 80;
const N_IMAGES = 120;
const N_PDFS = 5;
const N_VOICE = 3;
const N_SPREADSHEETS = 2;
const N_NARRATIVE_DRAFTS = 1;

/**
 * Per-claim contamination ratio: 30% of notes are non-R&D content
 * (refactoring chores, marketing A/B tests, board prep, insurance
 * renewals). These carry payload.rd_band_hint = 'non_rd' as the ground
 * truth the scorer grades Agent A against. The remaining 70% carry
 * rd_band_hint = 'rd_relevant'.
 */
const CONTAMINATION_RATE = 0.3;

// FY26: 1 Jul 2025 — 30 Jun 2026. Times generated within this window.
const FY_START = new Date('2025-07-01T00:00:00Z');
const FY_END = new Date('2026-06-30T23:59:59Z');

// ── Deterministic PRNG so repeated runs produce the same data ────────
// Mulberry32 seeded by the claim index so each claim has reproducible
// noise while different claims feel different.
function mulberry32(a: number): () => number {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Per-claim IDs derived from the 0-based index ─────────────────────
// Format: 00000000-0000-4000-8000-c0a2{ii}{tag}{NNNN}
// where ii = two-digit claim index (01–10), tag = 2-digit subject
// (01 tenant, 02 user, 03 subject_tenant, 04 project, 05 claim,
// 06 expenditure rows), NNNN = 4-hex-digit row counter. UUID's 5th
// segment is exactly 12 chars (RFC 4122): 4 + 2 + 2 + 4 = 12.
function id(claimIdx: number, tag: string, n = 0): string {
  const ii = (claimIdx + 1).toString().padStart(2, '0');
  const nn = n.toString(16).padStart(4, '0');
  return `00000000-0000-4000-8000-c0a2${ii}${tag}${nn}`;
}
const tenantId = (i: number) => id(i, '01');
const userId = (i: number) => id(i, '02');
const subjectId = (i: number) => id(i, '03');
const projectId = (i: number) => id(i, '04');
const claimId = (i: number) => id(i, '05');
const expenditureId = (i: number, n: number) => id(i, '06', n);

// ── Tiny utilities used by the generators ────────────────────────────
type RandFn = () => number;
function ri(rng: RandFn, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}
function pick<T>(rng: RandFn, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
function randomFyDate(rng: RandFn): Date {
  const span = FY_END.getTime() - FY_START.getTime();
  return new Date(FY_START.getTime() + rng() * span);
}
/** Fill {placeholder} tokens with random integers — generators pass a record. */
function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match: string, k: string) => {
    const v = params[k];
    return v === undefined ? '?' : String(v);
  });
}
/** Hash a string deterministically for size_bytes / sha256 columns. */
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 64);
}

// ── Pending shapes ───────────────────────────────────────────────────
interface PendingEvent {
  claimIdx: number;
  kind: string;
  payload: Record<string, unknown>;
  classification: Record<string, unknown> | null;
  captured_at: Date;
  extracted_content?: Record<string, unknown>;
}
interface PendingExpenditure {
  claimIdx: number;
  id: string;
  source: 'xero_invoice' | 'xero_bank_tx' | 'xero_receipt';
  vendor: string;
  reference: string;
  date: string; // YYYY-MM-DD
  amount: string;
  rd_band: 'rd_critical' | 'rd_supporting' | 'non_rd';
}

// ── Cleanup + base seed ──────────────────────────────────────────────

async function cleanupAll(): Promise<void> {
  for (let i = 0; i < DOMAINS.length; i++) {
    const T = tenantId(i);
    const U = userId(i);
    await privilegedSql`DELETE FROM event WHERE tenant_id = ${T}`;
    await privilegedSql`DELETE FROM expenditure WHERE tenant_id = ${T}`;
    await privilegedSql`DELETE FROM claim WHERE tenant_id = ${T}`;
    await privilegedSql`DELETE FROM project WHERE tenant_id = ${T}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${T}`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${T}`;
    await sql`DELETE FROM "user" WHERE id = ${U}`;
    await sql`DELETE FROM tenant WHERE id = ${T}`;
  }
}

async function seedTenantSkeleton(i: number, d: Domain): Promise<void> {
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${tenantId(i)}, ${d.firm.name + ' (bulk)'}, ${`${d.firm.slug}-bulk`}, 'mixed')
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${userId(i)}, ${d.user.email}, 'microsoft', ${`ms:${d.firm.slug}`}, ${d.user.name})
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${tenantId(i)}, ${userId(i)}, 'admin', true)
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name, kind)
    VALUES (${subjectId(i)}, ${tenantId(i)}, ${d.claimant.name}, 'claimant')
  `;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, description, started_at)
    VALUES (${projectId(i)}, ${tenantId(i)}, ${subjectId(i)}, ${d.project.name}, ${d.project.summary}, ${FY_START.toISOString()}::timestamptz)
  `;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
    VALUES (${claimId(i)}, ${tenantId(i)}, ${subjectId(i)}, ${projectId(i)}, 2026, 'engagement')
  `;
}

// ── Generators ───────────────────────────────────────────────────────

function genTransaction(rng: RandFn, d: Domain, i: number, n: number): PendingExpenditure {
  // RD band split: 40 / 30 / 30
  const r = rng();
  const band: PendingExpenditure['rd_band'] =
    r < 0.4 ? 'rd_critical' : r < 0.7 ? 'rd_supporting' : 'non_rd';
  const pool =
    band === 'rd_critical'
      ? d.vendors.rdCritical
      : band === 'rd_supporting'
        ? d.vendors.rdSupporting
        : d.vendors.nonRd;
  const vendor = pick(rng, pool);

  // Source mix: invoice 50%, bank_tx 30%, receipt 20%
  const sr = rng();
  const source: PendingExpenditure['source'] =
    sr < 0.5 ? 'xero_invoice' : sr < 0.8 ? 'xero_bank_tx' : 'xero_receipt';

  // Amount by band — wide log-uniform bands rather than tight normals so
  // the test data spans a realistic range (small Bunnings receipts up to
  // mid-five-figure equipment invoices).
  let amount: number;
  if (band === 'rd_critical') {
    amount = Math.exp(rng() * (Math.log(80000) - Math.log(1500)) + Math.log(1500));
  } else if (band === 'rd_supporting') {
    amount = Math.exp(rng() * (Math.log(20000) - Math.log(200)) + Math.log(200));
  } else {
    amount = Math.exp(rng() * (Math.log(5000) - Math.log(40)) + Math.log(40));
  }
  amount = Math.round(amount * 100) / 100;

  const date = randomFyDate(rng).toISOString().slice(0, 10);
  const vendorPrefix = vendor
    .split(/[ /]/)[0]!
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 6)
    .toUpperCase();
  const reference = `${vendorPrefix}-${date.slice(0, 7)}-${String(n).padStart(4, '0')}`;

  return {
    claimIdx: i,
    id: expenditureId(i, n),
    source,
    vendor,
    reference,
    date,
    amount: amount.toFixed(2),
    rd_band: band,
  };
}

type Theme =
  | 'hypothesis'
  | 'observation'
  | 'experiment'
  | 'iteration'
  | 'uncertainty'
  | 'newKnowledge'
  | 'timeLog'
  | 'associateFlag';

const KIND_BY_THEME: Record<Theme, string> = {
  hypothesis: 'HYPOTHESIS',
  observation: 'OBSERVATION',
  experiment: 'EXPERIMENT',
  iteration: 'ITERATION',
  uncertainty: 'UNCERTAINTY',
  newKnowledge: 'NEW_KNOWLEDGE',
  timeLog: 'TIME_LOG',
  associateFlag: 'ASSOCIATE_FLAG',
};

/** Themes contamination is allowed to wear — the corporate-noise pool only
 *  fills the kinds that admin / marketing / refactoring activity could
 *  plausibly impersonate. HYPOTHESIS / UNCERTAINTY / NEW_KNOWLEDGE stay
 *  R&D-only because their linguistic register is science-specific. */
const CONTAMINATION_KINDS: Array<keyof typeof CONTAMINATION_THEMES> = [
  'experiment',
  'iteration',
  'observation',
  'timeLog',
  'associateFlag',
];

/**
 * Pick a kind heuristically based on which theme pool the note was
 * sampled from. classification is null so Agent A's re-run produces
 * the real rationale + statutory anchor + confidence.
 *
 * 30 % of notes are CONTAMINATION — corporate noise that looks
 * structurally like one of the lower-register R&D kinds but is
 * actually non-R&D activity. They carry `payload.rd_band_hint = 'non_rd'`
 * so the scoring CLI can verify Agent A flagged them INELIGIBLE
 * rather than rolling them into the claim. The R&D-relevant 70 % carry
 * `payload.rd_band_hint = 'rd_relevant'`.
 */
function genNote(rng: RandFn, d: Domain, i: number): PendingEvent {
  const isContamination = rng() < CONTAMINATION_RATE;

  let theme: Theme;
  let template: string;
  if (isContamination) {
    const ck = pick(rng, CONTAMINATION_KINDS);
    theme = ck;
    template = pick(rng, CONTAMINATION_THEMES[ck]);
  } else {
    // Weighted theme pick over the R&D-relevant pool — observation /
    // experiment dominate a real claim's evidence stream.
    const r = rng();
    theme =
      r < 0.18
        ? 'hypothesis'
        : r < 0.4
          ? 'observation'
          : r < 0.58
            ? 'experiment'
            : r < 0.68
              ? 'iteration'
              : r < 0.76
                ? 'uncertainty'
                : r < 0.83
                  ? 'newKnowledge'
                  : r < 0.93
                    ? 'timeLog'
                    : 'associateFlag';
    template = pick(rng, d.themes[theme]);
  }
  const kindByTheme = KIND_BY_THEME;
  const params: Record<string, string | number> = {
    n: ri(rng, 1, 30),
    prev: ri(rng, 1, 20),
    next: ri(rng, 5, 40),
    x: ri(rng, 3, 12),
    temp: ri(rng, 600, 900),
    rate: ri(rng, 50, 400),
    rate1: ri(rng, 100, 250),
    rate2: ri(rng, 150, 350),
    window: ri(rng, 20, 120),
    ml: (rng() * 0.05).toFixed(3),
    tol: (rng() * 0.05).toFixed(3),
    dp: ri(rng, 1, 9),
    cs: ri(rng, 1, 99),
    pct: ri(rng, 5, 95),
    ph: (5 + rng() * 4).toFixed(2),
    od: (rng() * 8 + 1).toFixed(1),
    h: ri(rng, 6, 96),
    cert: `${pick(rng, ['CAL', 'CERT', 'TC'])}-${ri(rng, 1000, 9999)}`,
    p50: ri(rng, 20, 300),
    p99: ri(rng, 80, 800),
    qps: ri(rng, 10, 5000),
    qd: ri(rng, 1, 50),
    recover: ri(rng, 1, 30),
    mp: ri(rng, 1, 9),
    mem: ri(rng, 10, 60),
    lambda: ri(rng, 5, 500),
    ver: `v${ri(rng, 1, 12)}.${ri(rng, 0, 30)}`,
    old: ri(rng, 1, 100),
    new: ri(rng, 1, 100),
    ctx: ri(rng, 4, 256),
    titer: ri(rng, 5, 80),
    v: ri(rng, 1, 24),
    solvent: pick(rng, ['MIBK', 'cyclohexanone', 'TBP', 'isoamyl alcohol', '2-octanol']),
    solvent1: 'MIBK',
    solvent2: 'cyclohexanone',
    solvent3: 'TBP',
    rt: (rng() * 12 + 2).toFixed(2),
    do: ri(rng, 20, 80),
    gene: pick(rng, ['ldhA', 'pflB', 'ackA', 'pta', 'tdcE']),
    cap: ri(rng, 200, 4000),
    cyc: ri(rng, 50, 5000),
    ce: (90 + rng() * 10).toFixed(2),
    ret: ri(rng, 60, 99),
    imp: (rng() * 50).toFixed(1),
    ch: `${ri(rng, 1, 96)}-${ri(rng, 1, 96)}`,
    lo: ri(rng, 0, 5),
    hi: ri(rng, 30, 99),
    li: ri(rng, 5, 25),
    loss: ri(rng, 5, 40),
    thick: ri(rng, 20, 200),
    rmse: (rng() * 50).toFixed(1),
    dist: ri(rng, 50, 5000),
    speed: (rng() * 4 + 0.5).toFixed(1),
    r2: (0.6 + rng() * 0.4).toFixed(2),
    kw: ri(rng, 1, 12),
    age: ri(rng, 3, 40),
    gap: (1 + rng() * 4).toFixed(1),
    gap1: '1.6',
    gap2: '3.2',
    mard: (rng() * 15 + 5).toFixed(1),
    ref: ri(rng, 8, 25),
    sens: (rng() * 25 + 70).toFixed(1),
    fpr: (rng() * 10).toFixed(2),
    days: ri(rng, 5, 20),
    nsub: ri(rng, 10, 100),
    nseed: ri(rng, 3, 30),
    day: ri(rng, 3, 14),
    range: ri(rng, 50, 500),
    wind: ri(rng, 5, 25),
    ms: ri(rng, 20, 500),
    fp: ri(rng, 0, 30),
    min: ri(rng, 1, 60),
    cap_: ri(rng, 100, 5000),
    rec: ri(rng, 30, 95),
    acid: ri(rng, 5, 40),
    res: ri(rng, 5, 120),
    mass: ri(rng, 5, 200),
    p10: ri(rng, 10, 60),
    p90: ri(rng, 150, 600),
    k: (rng() * 0.5).toFixed(3),
    fe: ri(rng, 80, 99),
    al: ri(rng, 60, 99),
    mg: ri(rng, 50, 95),
    ph1: (1 + rng()).toFixed(1),
    ph2: (5 + rng() * 4).toFixed(1),
    oldp: pick(rng, ['NaOH', 'Na₂CO₃']),
    newp: pick(rng, ['MgO', 'Ca(OH)₂']),
    batch: ri(rng, 1, 256),
    sess: ri(rng, 10, 200),
    b: `${ri(rng, 1, 20)}.${ri(rng, 0, 99)}`,
    budget: ri(rng, 2, 16),
    load: (rng() * 2 + 0.1).toFixed(2),
    load1: '0.5',
    load2: '1.0',
    load3: '2.0',
    mv: ri(rng, 5, 80),
    ad: (rng() * 3 + 0.5).toFixed(1),
    hfr: (rng() * 200).toFixed(0),
    hours: (rng() * 8 + 0.5).toFixed(1),
    sec: ri(rng, 5, 200),
    deg: ri(rng, 5, 300),
    ncell: ri(rng, 1, 100),
    new1: ri(rng, 1, 20),
    new2: ri(rng, 1, 20),
  };
  // R&D notes get a supplementary paragraph sampled from a sibling
  // theme to make the text feel multi-sentence and organic.
  // Contamination notes stay single-paragraph — corporate noise reads
  // tersely, and pulling a second paragraph from the R&D pool would
  // dilute the ground-truth signal.
  const text = isContamination
    ? fill(template, params)
    : fill(template, params) + '\n\n' + secondaryParagraph(rng, d, theme, params);

  // captured_at within FY26 but biased to the back half of the year
  // (when claims actually wind up — Mar / Apr / May / Jun).
  const captured = randomFyDate(rng);

  return {
    claimIdx: i,
    kind: kindByTheme[theme],
    payload: {
      raw_text: text,
      source: 'consultant-paste',
      auto_kind_hint: kindByTheme[theme].toLowerCase(),
      // Ground truth for the scoring CLI. 'non_rd' means the note is
      // corporate noise that should be flagged INELIGIBLE; 'rd_relevant'
      // means it should be classified to one of the eligible kinds.
      rd_band_hint: isContamination ? 'non_rd' : 'rd_relevant',
    },
    classification: null, // Agent A's job
    captured_at: captured,
  };
}

function secondaryParagraph(
  rng: RandFn,
  d: Domain,
  theme: string,
  params: Record<string, string | number>,
): string {
  // A short supplementary paragraph to make the note multi-sentence —
  // sampled from a sibling theme so the text feels organic.
  const pool =
    theme === 'hypothesis'
      ? d.themes.experiment
      : theme === 'observation'
        ? d.themes.iteration
        : theme === 'experiment'
          ? d.themes.observation
          : theme === 'iteration'
            ? d.themes.observation
            : d.themes.hypothesis;
  return fill(pick(rng, pool), params);
}

function genImage(rng: RandFn, d: Domain, i: number, n: number): PendingEvent {
  const subjectTemplate = pick(rng, d.imageSubjects);
  const params = { n: ri(rng, 1, 60), v: ri(rng, 1, 12), b: `${ri(rng, 1, 20)}.${ri(rng, 0, 99)}` };
  const subject = fill(subjectTemplate, params);
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 40);
  const ext = pick(rng, ['jpg', 'png', 'heic']);
  const filename = `${slug}_${String(n).padStart(4, '0')}.${ext}`;
  const size = ri(rng, 200, 8000) * 1024; // 200 KB – 8 MB
  const captured = randomFyDate(rng);
  return {
    claimIdx: i,
    kind: 'EVIDENCE_UPLOADED',
    payload: {
      filename,
      mime: ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'image/heic',
      size_bytes: size,
      sha256_hex: shortHash(filename + d.slug),
      source: 'claimant-mobile-upload',
    },
    classification: null,
    captured_at: captured,
    extracted_content: {
      // Minimal — the platform's document-analyzer is expected to
      // OCR / vision-extract the actual content. We seed only the
      // subject-line summary to model "the user uploaded it with no
      // caption".
      document_summary: subject,
      activities: [],
    },
  };
}

function genPdf(rng: RandFn, d: Domain, i: number, n: number): PendingEvent {
  const titleTemplate = pick(rng, d.pdfTitles);
  const params = { n: ri(rng, 1, 30), v: ri(rng, 1, 12) };
  const title = fill(titleTemplate, params);
  const filename = `${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 45)}_${String(n).padStart(2, '0')}.pdf`;
  const size = ri(rng, 200, 5000) * 1024;
  return {
    claimIdx: i,
    kind: 'EVIDENCE_UPLOADED',
    payload: {
      filename,
      mime: 'application/pdf',
      size_bytes: size,
      sha256_hex: shortHash(filename + d.slug),
      source: 'consultant-upload',
    },
    classification: null,
    captured_at: randomFyDate(rng),
    extracted_content: {
      document_summary: title,
      pages: [],
    },
  };
}

function genVoice(rng: RandFn, d: Domain, i: number, n: number): PendingEvent {
  const topicTemplate = pick(rng, d.voiceNoteTopics);
  const params = { n: ri(rng, 1, 30) };
  const topic = fill(topicTemplate, params);
  const filename = `${topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 45)}_${String(n).padStart(2, '0')}.m4a`;
  const duration = ri(rng, 15, 240);
  return {
    claimIdx: i,
    kind: 'EVIDENCE_UPLOADED',
    payload: {
      filename,
      mime: 'audio/mp4',
      size_bytes: ri(rng, 150, 1500) * 1024,
      sha256_hex: shortHash(filename + d.slug),
      duration_seconds: duration,
      source: 'claimant-mobile-upload',
    },
    classification: null,
    captured_at: randomFyDate(rng),
    extracted_content: {
      document_summary: topic,
      transcript: '', // intentionally empty — ASR has not run
      speaker: d.user.name,
      language: 'en-AU',
    },
  };
}

function genSpreadsheet(rng: RandFn, d: Domain, i: number, n: number): PendingEvent {
  const subjects = ['timesheet', 'expenditure_roll', 'calculations', 'inventory_log', 'pilot_data'];
  const subject = pick(rng, subjects);
  const filename = `${d.slug}_${subject}_${String(n).padStart(2, '0')}.xlsx`;
  return {
    claimIdx: i,
    kind: 'EVIDENCE_UPLOADED',
    payload: {
      filename,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size_bytes: ri(rng, 20, 500) * 1024,
      sha256_hex: shortHash(filename + d.slug),
      source: 'consultant-upload',
    },
    classification: null,
    captured_at: randomFyDate(rng),
    extracted_content: {
      document_summary: `${subject.replace(/_/g, ' ')} for ${d.project.name}`,
      sheets: [],
    },
  };
}

function genNarrativeDraft(rng: RandFn, d: Domain, i: number): PendingEvent {
  const filename = `${d.slug}_partial_narrative_draft.docx`;
  return {
    claimIdx: i,
    kind: 'EVIDENCE_UPLOADED',
    payload: {
      filename,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size_bytes: ri(rng, 30, 250) * 1024,
      sha256_hex: shortHash(filename + d.slug),
      source: 'consultant-upload',
    },
    classification: null,
    captured_at: randomFyDate(rng),
    extracted_content: {
      document_summary: `Partial narrative draft for ${d.project.name} — only the Hypothesis section is roughed in.`,
      sections: [
        {
          heading: 'Hypothesis',
          text: fill(pick(rng, d.themes.hypothesis), {
            x: ri(rng, 3, 12),
            temp: ri(rng, 600, 900),
            rate: ri(rng, 50, 400),
            window: ri(rng, 20, 120),
            pct: ri(rng, 5, 95),
            n: ri(rng, 1, 30),
            v: ri(rng, 1, 12),
            titer: ri(rng, 5, 80),
            mard: (rng() * 15 + 5).toFixed(1),
            ref: ri(rng, 8, 25),
            sens: (rng() * 25 + 70).toFixed(1),
            fpr: (rng() * 10).toFixed(2),
            cap: ri(rng, 200, 4000),
            cyc: ri(rng, 50, 5000),
            range: ri(rng, 50, 500),
            speed: (rng() * 4 + 0.5).toFixed(1),
            tol: (rng() * 5).toFixed(1),
            wind: ri(rng, 5, 25),
            ms: ri(rng, 20, 500),
            r2: (0.6 + rng() * 0.4).toFixed(2),
            qps: ri(rng, 10, 5000),
            p99: ri(rng, 80, 800),
            batch: ri(rng, 1, 256),
            ctx: ri(rng, 4, 256),
            load: (rng() * 2 + 0.1).toFixed(2),
            mv: ri(rng, 5, 80),
            ad: (rng() * 3 + 0.5).toFixed(1),
            deg: ri(rng, 5, 300),
            ncell: ri(rng, 1, 100),
            rec: ri(rng, 30, 95),
            min: ri(rng, 1, 60),
            day: ri(rng, 3, 14),
            sess: ri(rng, 10, 200),
            budget: ri(rng, 2, 16),
            acid: ri(rng, 5, 40),
            res: ri(rng, 5, 120),
          }),
        },
      ],
    },
  };
}

// ── Per-claim generation pipeline ────────────────────────────────────

interface ClaimResult {
  claimIdx: number;
  domain: Domain;
  expenditures: number;
  events: number;
  band_counts: Record<string, number>;
  kind_counts: Record<string, number>;
  chain_verified: boolean;
  head_hash: string | null;
}

async function generateClaim(claimIdx: number, d: Domain): Promise<ClaimResult> {
  const rng = mulberry32(0x600a + claimIdx * 1009);
  await seedTenantSkeleton(claimIdx, d);

  const expenditures: PendingExpenditure[] = [];
  const events: PendingEvent[] = [];

  // Transactions — generate expenditure row + matching INGESTED chain event.
  for (let n = 1; n <= N_TRANSACTIONS; n++) {
    const exp = genTransaction(rng, d, claimIdx, n);
    expenditures.push(exp);
    events.push({
      claimIdx,
      kind: 'EXPENDITURE_INGESTED',
      payload: {
        expenditure_id: exp.id,
        source: exp.source,
        vendor_name: exp.vendor,
        reference: exp.reference,
        total_amount: exp.amount,
        currency: 'AUD',
        rd_band_hint: exp.rd_band, // hint for the mapping engine's eval
      },
      classification: null,
      captured_at: new Date(
        `${exp.date}T${String(ri(rng, 8, 18)).padStart(2, '0')}:${String(ri(rng, 0, 59)).padStart(2, '0')}:00Z`,
      ),
    });
  }

  // Notes
  for (let n = 0; n < N_NOTES; n++) events.push(genNote(rng, d, claimIdx));

  // Images
  for (let n = 1; n <= N_IMAGES; n++) events.push(genImage(rng, d, claimIdx, n));

  // PDFs / voice / spreadsheets / narrative-drafts
  for (let n = 1; n <= N_PDFS; n++) events.push(genPdf(rng, d, claimIdx, n));
  for (let n = 1; n <= N_VOICE; n++) events.push(genVoice(rng, d, claimIdx, n));
  for (let n = 1; n <= N_SPREADSHEETS; n++) events.push(genSpreadsheet(rng, d, claimIdx, n));
  for (let n = 1; n <= N_NARRATIVE_DRAFTS; n++) events.push(genNarrativeDraft(rng, d, claimIdx));

  // Insert expenditures (no chain involvement) — bulk via UNNEST would be
  // faster, but 500 per claim is well within the budget.
  for (const exp of expenditures) {
    await privilegedSql`
      INSERT INTO expenditure (
        id, tenant_id, subject_tenant_id, claim_id,
        source, vendor_name, reference,
        expenditure_date, total_amount, currency
      )
      VALUES (
        ${exp.id}, ${tenantId(claimIdx)}, ${subjectId(claimIdx)}, ${claimId(claimIdx)},
        ${exp.source}, ${exp.vendor}, ${exp.reference},
        ${exp.date}::date, ${exp.amount}::numeric, 'AUD'
      )
    `;
  }

  // Sort chain events by captured_at ASC so insertEventWithChain's
  // "latest parent" pick lines up with verifyChain's ASC walk (the
  // same chain-integrity invariant the test-cases seed documents).
  events.sort((a, b) => a.captured_at.getTime() - b.captured_at.getTime());

  for (const ev of events) {
    const inserted = await insertEventWithChain({
      tenant_id: tenantId(claimIdx),
      subject_tenant_id: subjectId(claimIdx),
      project_id: projectId(claimIdx),
      kind: ev.kind,
      payload: ev.payload,
      classification: ev.classification,
      captured_at: ev.captured_at,
      captured_by_user_id: userId(claimIdx),
      captured_by_employee_id: null,
      override_of_event_id: null,
      override_new_kind: null,
      override_reason: null,
    });
    if (ev.extracted_content) {
      await privilegedSql`
        UPDATE event
           SET extracted_content = ${JSON.stringify(ev.extracted_content)}::text::jsonb,
               extraction_status = 'complete'
         WHERE id = ${inserted.id}
      `;
    }
  }

  const verify = await verifyChain(subjectId(claimIdx));
  const band_counts: Record<string, number> = { rd_critical: 0, rd_supporting: 0, non_rd: 0 };
  for (const e of expenditures) band_counts[e.rd_band] = (band_counts[e.rd_band] ?? 0) + 1;
  const kind_counts: Record<string, number> = {};
  for (const ev of events) kind_counts[ev.kind] = (kind_counts[ev.kind] ?? 0) + 1;

  return {
    claimIdx,
    domain: d,
    expenditures: expenditures.length,
    events: events.length,
    band_counts,
    kind_counts,
    chain_verified: verify.verified,
    head_hash: verify.head_hash,
  };
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdout.write(
    `Bulk-claims seed — ${DOMAINS.length} firms × ~${
      N_TRANSACTIONS + N_NOTES + N_IMAGES + N_PDFS + N_VOICE + N_SPREADSHEETS + N_NARRATIVE_DRAFTS
    } events each\n`,
  );
  process.stdout.write(`Cleaning prior c0a2* fixtures…\n`);
  await cleanupAll();

  const t0 = Date.now();
  const results: ClaimResult[] = [];
  for (let i = 0; i < DOMAINS.length; i++) {
    const d = DOMAINS[i]!;
    const ts = Date.now();
    process.stdout.write(
      `\n[${(i + 1).toString().padStart(2, '0')}/${DOMAINS.length}] ${d.firm.name} → ${d.claimant.name}\n`,
    );
    process.stdout.write(`      ${d.project.name}\n`);
    const r = await generateClaim(i, d);
    results.push(r);
    process.stdout.write(
      `      seeded · ${r.expenditures} exp · ${r.events} events · chain ${
        r.chain_verified ? 'OK' : 'BROKEN'
      } · ${((Date.now() - ts) / 1000).toFixed(1)}s\n`,
    );
    if (!r.chain_verified) {
      throw new Error(`Chain verification failed for ${d.slug}`);
    }
  }
  const elapsed = (Date.now() - t0) / 1000;

  process.stdout.write('\nSummary\n');
  process.stdout.write('─'.repeat(96) + '\n');
  let totalEv = 0;
  let totalExp = 0;
  for (const r of results) {
    totalEv += r.events;
    totalExp += r.expenditures;
    const kinds = Object.entries(r.kind_counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    process.stdout.write(
      `  ${String(r.claimIdx + 1).padStart(2, '0')}. ${r.domain.firm.name.padEnd(28)} ` +
        `${r.domain.claimant.name.padEnd(36)} ${r.expenditures} exp · ${r.events} ev\n`,
    );
    process.stdout.write(
      `      expenditure bands: critical=${r.band_counts['rd_critical']} ` +
        `supporting=${r.band_counts['rd_supporting']} ` +
        `non-rd=${r.band_counts['non_rd']}\n`,
    );
    process.stdout.write(`      event kinds: ${kinds}\n`);
  }
  process.stdout.write('─'.repeat(96) + '\n');
  process.stdout.write(
    `Totals: ${totalExp} expenditures · ${totalEv} chain events · ${elapsed.toFixed(1)}s\n\n`,
  );
  process.stdout.write(
    'Tenant / claim IDs (visit /claims/<claim_id> once a session cookie is minted):\n',
  );
  for (const r of results) {
    process.stdout.write(
      `  ${String(r.claimIdx + 1).padStart(2, '0')}. tenant=${tenantId(r.claimIdx)}  claim=${claimId(r.claimIdx)}  (${r.domain.claimant.name})\n`,
    );
  }
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
