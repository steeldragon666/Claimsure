#!/usr/bin/env tsx
/**
 * Stress-test seed — 40 synthetic claimants, ~$480M total expenditure,
 * 22.4% note contamination, ~$35.6M ineligible expenditure. Built to
 * benchmark classifier accuracy at 10× the volume of `seed-bulk-claims.ts`
 * (which seeds 10 claimants at ~$48M).
 *
 *   pnpm exec tsx --env-file=../../.env seed-stress-test.ts
 *
 * Coexists with the smaller bulk-claim seed:
 *   - bulk-claims  → 10 claimants, UUID namespace c0a2{ii} — fast (~8 min),
 *     used for CI smoke + dev loop.
 *   - stress-test  → 40 claimants, UUID namespace c0a3{ii} — long (~30 min),
 *     used for accuracy benchmarking and reported via score-stress-test.ts.
 *
 * Per-claim volume:
 *   - 1000 transactions (expenditure rows + EXPENDITURE_INGESTED events)
 *   - 200 notes (22.4% contamination — corporate-noise notes that should
 *     be classified INELIGIBLE)
 *   - 200 images, 5 PDFs, 3 voice transcripts, 2 spreadsheets, 1 narrative
 *
 * Aggregate target shape (deterministic per mulberry32 seeding):
 *   - 40 claimants × 1000 tx = 40 000 expenditures
 *   - 40 × 200 notes = 8000 notes (≈1792 contaminated)
 *   - Total expenditure $: ≈$480M
 *   - Non-R&D expenditure $: ≈$35.6M (7.4% by $)
 *
 * Domain cycling: each of the 40 claimants reuses one of the 10 DOMAINS
 * with a numbered suffix — `<firm> (stress-1)` through `<firm> (stress-4)`.
 * Lower diversity than 40 unique configs but identical stress-on-volume.
 * Up-shift to 40 bespoke domains is tracked separately.
 *
 * Tenant namespace: 00000000-0000-4000-8000-c0a3{ii}{tag}{NNNN} where ii
 * is the 2-digit (1-based) claim index 01..40. Cleanup wipes the
 * namespace before reseeding (idempotent).
 *
 * Code duplication note: this file mirrors seed-bulk-claims.ts deliberately
 * — extracting a shared `runSeed(config)` library would be cleaner, but the
 * existing seed is structured as a script with top-level await. Refactor
 * once the stress seed has shipped and we know what knobs actually need
 * to vary.
 */
import { createHash } from 'node:crypto';
import { insertEventWithChain, verifyChain } from '@cpa/db';
import { privilegedSql, sql } from '@cpa/db/client';
import { CONTAMINATION_THEMES, DOMAINS, type Domain } from './_bulk-claim-domains.js';

// ── Volume per claim (tuned to hit the $480M / $35.6M / 22.4% targets) ─
const N_CLAIMS = 40;
const N_TRANSACTIONS = 1000;
const N_NOTES = 200;
const N_IMAGES = 200;
const N_PDFS = 5;
const N_VOICE = 3;
const N_SPREADSHEETS = 2;
const N_NARRATIVE_DRAFTS = 1;

/**
 * 22.4% of notes are contamination — corporate-noise vocabulary that
 * the classifier must flag INELIGIBLE. The remaining 77.6% are R&D-
 * relevant. 22.4% mirrors the AusIndustry/ATO published error rate for
 * R&DTI claim submissions, so this seed is a realistic-frequency stress
 * test rather than a worst-case adversarial run.
 */
const CONTAMINATION_RATE = 0.224;

/**
 * Per-band expenditure split by COUNT. Tuned alongside the amount
 * ranges below so the dollar-weighted non-R&D share lands near 7.4%
 * (≈$35.6M of ≈$480M).
 */
const BAND_SPLIT = {
  rd_critical: 0.4,
  rd_supporting: 0.376,
  non_rd: 0.224,
} as const;

/**
 * Per-band amount ranges (log-uniform). Mean ≈ (b - a) / ln(b/a):
 *   rd_critical   [$2K, $100K]  → $25K avg → 400 × $25K = $10.0M / claim
 *   rd_supporting [$200, $20K]  →  $4.3K avg → 376 × $4.3K = $1.6M / claim
 *   non_rd        [$500, $13K]  →  $3.8K avg → 224 × $3.8K = $0.86M / claim
 *
 * Per claim: ≈$12.5M  → 40 claims ≈ $500M (within 4% of $480M target).
 * Non-R&D per claim: ≈$860K  → 40 × $860K ≈ $34.4M (within 4% of $35.6M).
 *
 * Actual realised values vary slightly from the mean (single-claim
 * variance of log-uniform draws) but stay near these expectations
 * because every claim independently draws 224 non-R&D rows.
 */
const AMOUNT_RANGES = {
  rd_critical: { lo: 2000, hi: 100000 },
  rd_supporting: { lo: 200, hi: 20000 },
  non_rd: { lo: 500, hi: 13000 },
} as const;

/** Same per-band reference descriptors as the small seed — gives the
 *  expenditure classifier the semantic signal it needs to disambiguate
 *  dual-use SaaS rows by line-item description. */
const REFERENCE_DESCRIPTORS: Record<'rd_critical' | 'rd_supporting' | 'non_rd', string[]> = {
  rd_critical: [
    'R&D experimental supplies',
    'lab consumables for testing',
    'specimen analysis service',
    'instrumentation calibration',
    'research-grade reagents',
    'prototype materials',
    'experimental rig components',
    'R&D pilot-batch inputs',
  ],
  rd_supporting: [
    'R&D engineering team workspace',
    'R&D compute resources',
    'developer tooling for the research team',
    'R&D supporting service',
    'simulation cluster runtime',
    'engineering team subscription',
  ],
  non_rd: [
    'annual PI premium renewal',
    'sales team CRM seats',
    'corporate travel — conference booking',
    'office stationery and supplies',
    'tax preparation handover',
    'company secretarial services',
    'fleet fuel card',
    'office lease renewal',
    'admin team subscription',
    'marketing agency retainer',
    'payroll system fees',
    'general counsel hours',
    'sales team workspace',
    'marketing site hosting',
    'board pack production',
  ],
};

// FY26: 1 Jul 2025 — 30 Jun 2026.
const FY_START = new Date('2025-07-01T00:00:00Z');
const FY_END = new Date('2026-06-30T23:59:59Z');

// ── Deterministic PRNG (Mulberry32) ──────────────────────────────────
function mulberry32(a: number): () => number {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 40 claimants = 10 DOMAINS × 4 cycles with a suffix ───────────────
// claimIdx 0..9   → DOMAINS[0..9]  suffix "(stress-1)"
// claimIdx 10..19 → DOMAINS[0..9]  suffix "(stress-2)"
// claimIdx 20..29 → DOMAINS[0..9]  suffix "(stress-3)"
// claimIdx 30..39 → DOMAINS[0..9]  suffix "(stress-4)"
function cycleIndex(claimIdx: number): number {
  return Math.floor(claimIdx / DOMAINS.length) + 1;
}
function suffixedDomain(claimIdx: number): Domain {
  const base = DOMAINS[claimIdx % DOMAINS.length]!;
  const cycle = cycleIndex(claimIdx);
  return {
    ...base,
    firm: { ...base.firm, slug: `${base.firm.slug}-stress-${cycle}` },
  };
}
function displayFirmName(claimIdx: number): string {
  return `${DOMAINS[claimIdx % DOMAINS.length]!.firm.name} (stress-${cycleIndex(claimIdx)})`;
}
function displayClaimantName(claimIdx: number): string {
  return `${DOMAINS[claimIdx % DOMAINS.length]!.claimant.name} (S${cycleIndex(claimIdx)})`;
}

// ── Per-claim IDs in the c0a3 namespace ──────────────────────────────
function id(claimIdx: number, tag: string, n = 0): string {
  const ii = (claimIdx + 1).toString().padStart(2, '0');
  const nn = n.toString(16).padStart(4, '0');
  return `00000000-0000-4000-8000-c0a3${ii}${tag}${nn}`;
}
const tenantId = (i: number) => id(i, '01');
const userId = (i: number) => id(i, '02');
const subjectId = (i: number) => id(i, '03');
const projectId = (i: number) => id(i, '04');
const claimIdOf = (i: number) => id(i, '05');
const expenditureId = (i: number, n: number) => id(i, '06', n);

// ── Utilities ────────────────────────────────────────────────────────
type RandFn = () => number;
function ri(rng: RandFn, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}
function pick<T>(rng: RandFn, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
function logUniform(rng: RandFn, lo: number, hi: number): number {
  return Math.exp(rng() * (Math.log(hi) - Math.log(lo)) + Math.log(lo));
}
function randomFyDate(rng: RandFn): Date {
  const span = FY_END.getTime() - FY_START.getTime();
  return new Date(FY_START.getTime() + rng() * span);
}
function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match: string, k: string) => {
    const v = params[k];
    return v === undefined ? '?' : String(v);
  });
}
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
  date: string;
  amount: string;
  rd_band: 'rd_critical' | 'rd_supporting' | 'non_rd';
}

// ── Cleanup + base seed ──────────────────────────────────────────────
async function cleanupAll(): Promise<void> {
  for (let i = 0; i < N_CLAIMS; i++) {
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
  const cycle = cycleIndex(i);
  const tenantName = `${d.firm.name} (stress-${cycle})`;
  const claimantName = displayClaimantName(i);
  const userEmail = d.user.email.replace('@', `+stress${cycle}@`);
  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${tenantId(i)}, ${tenantName}, ${d.firm.slug}, 'mixed')
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES (${userId(i)}, ${userEmail}, 'microsoft', ${`ms:${d.firm.slug}`}, ${d.user.name})
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${tenantId(i)}, ${userId(i)}, 'admin', true)
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name, kind)
    VALUES (${subjectId(i)}, ${tenantId(i)}, ${claimantName}, 'claimant')
  `;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, description, started_at)
    VALUES (${projectId(i)}, ${tenantId(i)}, ${subjectId(i)}, ${d.project.name}, ${d.project.summary}, ${FY_START.toISOString()}::timestamptz)
  `;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
    VALUES (${claimIdOf(i)}, ${tenantId(i)}, ${subjectId(i)}, ${projectId(i)}, 2026, 'engagement')
  `;
}

// ── Generators ───────────────────────────────────────────────────────
function genTransaction(rng: RandFn, d: Domain, i: number, n: number): PendingExpenditure {
  const r = rng();
  const band: PendingExpenditure['rd_band'] =
    r < BAND_SPLIT.rd_critical
      ? 'rd_critical'
      : r < BAND_SPLIT.rd_critical + BAND_SPLIT.rd_supporting
        ? 'rd_supporting'
        : 'non_rd';
  const pool =
    band === 'rd_critical'
      ? d.vendors.rdCritical
      : band === 'rd_supporting'
        ? d.vendors.rdSupporting
        : d.vendors.nonRd;
  const vendor = pick(rng, pool);

  const sr = rng();
  const source: PendingExpenditure['source'] =
    sr < 0.5 ? 'xero_invoice' : sr < 0.8 ? 'xero_bank_tx' : 'xero_receipt';

  const range = AMOUNT_RANGES[band];
  const amount = Math.round(logUniform(rng, range.lo, range.hi) * 100) / 100;

  const date = randomFyDate(rng).toISOString().slice(0, 10);
  const vendorPrefix = vendor
    .split(/[ /]/)[0]!
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 6)
    .toUpperCase();
  const descriptor = pick(rng, REFERENCE_DESCRIPTORS[band]);
  const reference = `${vendorPrefix}-${date.slice(0, 7)}-${String(n).padStart(4, '0')} — ${descriptor}`;

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

const CONTAMINATION_KINDS: Array<keyof typeof CONTAMINATION_THEMES> = [
  'experiment',
  'iteration',
  'observation',
  'timeLog',
  'associateFlag',
];

function genNote(rng: RandFn, d: Domain, i: number): PendingEvent {
  const isContamination = rng() < CONTAMINATION_RATE;

  let theme: Theme;
  let template: string;
  if (isContamination) {
    const ck = pick(rng, CONTAMINATION_KINDS);
    theme = ck;
    template = pick(rng, CONTAMINATION_THEMES[ck]);
  } else {
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

  const text = isContamination
    ? fill(template, params)
    : fill(template, params) + '\n\n' + secondaryParagraph(rng, d, theme, params);

  return {
    claimIdx: i,
    kind: KIND_BY_THEME[theme],
    payload: {
      raw_text: text,
      source: 'consultant-paste',
      auto_kind_hint: KIND_BY_THEME[theme].toLowerCase(),
      rd_band_hint: isContamination ? 'non_rd' : 'rd_relevant',
    },
    classification: null,
    captured_at: randomFyDate(rng),
  };
}

function secondaryParagraph(
  rng: RandFn,
  d: Domain,
  theme: string,
  params: Record<string, string | number>,
): string {
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
  const size = ri(rng, 200, 8000) * 1024;
  return {
    claimIdx: i,
    kind: 'EVIDENCE_UPLOADED',
    payload: {
      filename,
      mime: ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'image/heic',
      size_bytes: size,
      sha256_hex: shortHash(filename + d.firm.slug),
      source: 'claimant-mobile-upload',
    },
    classification: null,
    captured_at: randomFyDate(rng),
    extracted_content: {
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
  return {
    claimIdx: i,
    kind: 'EVIDENCE_UPLOADED',
    payload: {
      filename,
      mime: 'application/pdf',
      size_bytes: ri(rng, 200, 5000) * 1024,
      sha256_hex: shortHash(filename + d.firm.slug),
      source: 'consultant-upload',
    },
    classification: null,
    captured_at: randomFyDate(rng),
    extracted_content: { document_summary: title, pages: [] },
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
  return {
    claimIdx: i,
    kind: 'EVIDENCE_UPLOADED',
    payload: {
      filename,
      mime: 'audio/mp4',
      size_bytes: ri(rng, 150, 1500) * 1024,
      sha256_hex: shortHash(filename + d.firm.slug),
      duration_seconds: ri(rng, 15, 240),
      source: 'claimant-mobile-upload',
    },
    classification: null,
    captured_at: randomFyDate(rng),
    extracted_content: {
      document_summary: topic,
      transcript: '',
      speaker: d.user.name,
      language: 'en-AU',
    },
  };
}

function genSpreadsheet(rng: RandFn, d: Domain, i: number, n: number): PendingEvent {
  const subjects = ['timesheet', 'expenditure_roll', 'calculations', 'inventory_log', 'pilot_data'];
  const subject = pick(rng, subjects);
  const filename = `${d.firm.slug}_${subject}_${String(n).padStart(2, '0')}.xlsx`;
  return {
    claimIdx: i,
    kind: 'EVIDENCE_UPLOADED',
    payload: {
      filename,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size_bytes: ri(rng, 20, 500) * 1024,
      sha256_hex: shortHash(filename + d.firm.slug),
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
  const filename = `${d.firm.slug}_partial_narrative_draft.docx`;
  return {
    claimIdx: i,
    kind: 'EVIDENCE_UPLOADED',
    payload: {
      filename,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size_bytes: ri(rng, 30, 250) * 1024,
      sha256_hex: shortHash(filename + d.firm.slug),
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
  band_dollars: Record<string, number>;
  kind_counts: Record<string, number>;
  contaminated_notes: number;
  total_notes: number;
  chain_verified: boolean;
  head_hash: string | null;
}

async function generateClaim(claimIdx: number, d: Domain): Promise<ClaimResult> {
  // Distinct PRNG seed per claim (different from the bulk seed's 0x600a
  // base so the two seeds don't shadow each other on the same domain).
  const rng = mulberry32(0xa11ce + claimIdx * 7919);
  await seedTenantSkeleton(claimIdx, d);

  const expenditures: PendingExpenditure[] = [];
  const events: PendingEvent[] = [];

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
        rd_band_hint: exp.rd_band,
      },
      classification: null,
      captured_at: new Date(
        `${exp.date}T${String(ri(rng, 8, 18)).padStart(2, '0')}:${String(ri(rng, 0, 59)).padStart(2, '0')}:00Z`,
      ),
    });
  }

  let contaminated_notes = 0;
  for (let n = 0; n < N_NOTES; n++) {
    const ev = genNote(rng, d, claimIdx);
    if (ev.payload.rd_band_hint === 'non_rd') contaminated_notes++;
    events.push(ev);
  }

  for (let n = 1; n <= N_IMAGES; n++) events.push(genImage(rng, d, claimIdx, n));
  for (let n = 1; n <= N_PDFS; n++) events.push(genPdf(rng, d, claimIdx, n));
  for (let n = 1; n <= N_VOICE; n++) events.push(genVoice(rng, d, claimIdx, n));
  for (let n = 1; n <= N_SPREADSHEETS; n++) events.push(genSpreadsheet(rng, d, claimIdx, n));
  for (let n = 1; n <= N_NARRATIVE_DRAFTS; n++) events.push(genNarrativeDraft(rng, d, claimIdx));

  for (const exp of expenditures) {
    await privilegedSql`
      INSERT INTO expenditure (
        id, tenant_id, subject_tenant_id, claim_id,
        source, vendor_name, reference,
        expenditure_date, total_amount, currency
      )
      VALUES (
        ${exp.id}, ${tenantId(claimIdx)}, ${subjectId(claimIdx)}, ${claimIdOf(claimIdx)},
        ${exp.source}, ${exp.vendor}, ${exp.reference},
        ${exp.date}::date, ${exp.amount}::numeric, 'AUD'
      )
    `;
  }

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
  const band_dollars: Record<string, number> = { rd_critical: 0, rd_supporting: 0, non_rd: 0 };
  for (const e of expenditures) {
    band_counts[e.rd_band] = (band_counts[e.rd_band] ?? 0) + 1;
    band_dollars[e.rd_band] = (band_dollars[e.rd_band] ?? 0) + parseFloat(e.amount);
  }
  const kind_counts: Record<string, number> = {};
  for (const ev of events) kind_counts[ev.kind] = (kind_counts[ev.kind] ?? 0) + 1;

  return {
    claimIdx,
    domain: d,
    expenditures: expenditures.length,
    events: events.length,
    band_counts,
    band_dollars,
    kind_counts,
    contaminated_notes,
    total_notes: N_NOTES,
    chain_verified: verify.verified,
    head_hash: verify.head_hash,
  };
}

// ── main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  process.stdout.write(
    `Stress-test seed — ${N_CLAIMS} claimants × ~${
      N_TRANSACTIONS + N_NOTES + N_IMAGES + N_PDFS + N_VOICE + N_SPREADSHEETS + N_NARRATIVE_DRAFTS
    } events each\n`,
  );
  process.stdout.write(
    `Targets: ≈$480M total · ≈$35.6M ineligible (7.4%) · 22.4% note contamination\n\n`,
  );
  process.stdout.write(`Cleaning prior c0a3* fixtures…\n`);
  await cleanupAll();

  const t0 = Date.now();
  const results: ClaimResult[] = [];
  for (let i = 0; i < N_CLAIMS; i++) {
    const d = suffixedDomain(i);
    const ts = Date.now();
    process.stdout.write(
      `[${(i + 1).toString().padStart(2, '0')}/${N_CLAIMS}] ${displayFirmName(i)} → ${displayClaimantName(i)}\n`,
    );
    const r = await generateClaim(i, d);
    results.push(r);
    process.stdout.write(
      `      seeded · ${r.expenditures} exp · ${r.events} events · chain ${
        r.chain_verified ? 'OK' : 'BROKEN'
      } · ${((Date.now() - ts) / 1000).toFixed(1)}s\n`,
    );
    if (!r.chain_verified) {
      throw new Error(`Chain verification failed for claim ${i + 1}`);
    }
  }
  const elapsed = (Date.now() - t0) / 1000;

  // ── Aggregate report ───────────────────────────────────────────────
  process.stdout.write('\nAggregate summary\n');
  process.stdout.write('─'.repeat(96) + '\n');

  let totalEv = 0;
  let totalExp = 0;
  let totalContaminatedNotes = 0;
  let totalNotes = 0;
  const totalBandCounts: Record<string, number> = { rd_critical: 0, rd_supporting: 0, non_rd: 0 };
  const totalBandDollars: Record<string, number> = { rd_critical: 0, rd_supporting: 0, non_rd: 0 };
  for (const r of results) {
    totalEv += r.events;
    totalExp += r.expenditures;
    totalContaminatedNotes += r.contaminated_notes;
    totalNotes += r.total_notes;
    for (const b of ['rd_critical', 'rd_supporting', 'non_rd'] as const) {
      totalBandCounts[b] = (totalBandCounts[b] ?? 0) + (r.band_counts[b] ?? 0);
      totalBandDollars[b] = (totalBandDollars[b] ?? 0) + (r.band_dollars[b] ?? 0);
    }
  }
  const totalDollars =
    (totalBandDollars.rd_critical ?? 0) +
    (totalBandDollars.rd_supporting ?? 0) +
    (totalBandDollars.non_rd ?? 0);
  const contaminationRate = (totalContaminatedNotes / totalNotes) * 100;

  process.stdout.write(`  Tenants:                ${N_CLAIMS}\n`);
  process.stdout.write(`  Total expenditure rows: ${totalExp}\n`);
  process.stdout.write(`  Total chain events:     ${totalEv}\n`);
  process.stdout.write(`  Total notes:            ${totalNotes}\n`);
  process.stdout.write(
    `  Contaminated notes:     ${totalContaminatedNotes} (${contaminationRate.toFixed(2)}% — target 22.40%)\n`,
  );
  process.stdout.write(
    `  Total expenditure $:    $${totalDollars.toLocaleString('en-AU', { maximumFractionDigits: 0 })} (target ≈ $480,000,000)\n`,
  );
  process.stdout.write(
    `  Non-R&D expenditure $:  $${(totalBandDollars.non_rd ?? 0).toLocaleString('en-AU', { maximumFractionDigits: 0 })} ` +
      `(${(((totalBandDollars.non_rd ?? 0) / totalDollars) * 100).toFixed(2)}% — target ≈ $35,600,000 / 7.42%)\n`,
  );
  process.stdout.write(
    `  R&D-critical $:         $${(totalBandDollars.rd_critical ?? 0).toLocaleString('en-AU', { maximumFractionDigits: 0 })}\n`,
  );
  process.stdout.write(
    `  R&D-supporting $:       $${(totalBandDollars.rd_supporting ?? 0).toLocaleString('en-AU', { maximumFractionDigits: 0 })}\n`,
  );
  process.stdout.write(`  Elapsed:                ${elapsed.toFixed(1)}s\n`);
  process.stdout.write('─'.repeat(96) + '\n');
  process.stdout.write(
    'Tenant / claim IDs (visit /claims/<claim_id> once a session cookie is minted):\n',
  );
  for (const r of results) {
    process.stdout.write(
      `  ${String(r.claimIdx + 1).padStart(2, '0')}. tenant=${tenantId(r.claimIdx)}  claim=${claimIdOf(r.claimIdx)}  (${displayClaimantName(r.claimIdx)})\n`,
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
    process.exit(1);
  });
