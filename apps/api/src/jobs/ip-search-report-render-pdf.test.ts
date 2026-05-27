/**
 * Integration tests for the ip-search-report-render-pdf pg-boss job.
 *
 * Strategy: seed a fully-populated claim with hypothesis/run/hit/verdict
 * fixtures via privilegedSql (RLS-bypass), then invoke the job handler
 * directly and assert on:
 *   - happy path with one hypothesis + one approved verdict
 *   - multi-hypothesis path with 5 approved verdicts
 *   - idempotency: second run reports `already_generated` and does not
 *     create a second media_artefact
 *   - early-return when no approved verdicts exist
 *
 * The tests do NOT need pg-boss running — they call
 * `runIpSearchReportRenderPdfJob` directly, bypassing the queue.
 */
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { privilegedSql, sql } from '@cpa/db/client';
import { runIpSearchReportRenderPdfJob } from './ip-search-report-render-pdf.js';

// ---------------------------------------------------------------------------
// Pinned UUIDs (segment `7d0` = "task 07 doc 0").
// ---------------------------------------------------------------------------

const TENANT = '00000000-0000-4000-8000-0000007d0001';
const ADMIN_USER = '00000000-0000-4000-8000-0000007d0002';
const APPROVER_USER = '00000000-0000-4000-8000-0000007d0003';
const SUBJECT = '00000000-0000-4000-8000-0000007d0010';
const EMPLOYEE = '00000000-0000-4000-8000-0000007d0011';
const PROJECT = '00000000-0000-4000-8000-0000007d0020';

// Two claims so the happy-path and multi-hypothesis paths don't collide.
const CLAIM_SINGLE = '00000000-0000-4000-8000-0000007d0030';
const CLAIM_MULTI = '00000000-0000-4000-8000-0000007d0031';
const CLAIM_EMPTY = '00000000-0000-4000-8000-0000007d0032';

const ACTIVITY_SINGLE = '00000000-0000-4000-8000-0000007d0040';
// Five activities for the multi-hypothesis case — one verdict per
// activity matches how the wizard captures one hypothesis per activity
// in v1. (The schema supports multiple hypotheses per activity; we just
// don't seed that to keep the test corpus focused on the cardinality
// that matters for the job — "many verdicts in one claim".)
const ACTIVITIES_MULTI = [
  '00000000-0000-4000-8000-0000007d0050',
  '00000000-0000-4000-8000-0000007d0051',
  '00000000-0000-4000-8000-0000007d0052',
  '00000000-0000-4000-8000-0000007d0053',
  '00000000-0000-4000-8000-0000007d0054',
];

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM ip_search_verdict WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM ip_search_hit
                       WHERE search_run_id IN (
                         SELECT id FROM ip_search_run WHERE tenant_id = ${TENANT}
                       )`;
  await privilegedSql`DELETE FROM ip_search_run WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM media_artefact WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant_employee WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM project WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE id = ${SUBJECT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM "user" WHERE id IN (${ADMIN_USER}, ${APPROVER_USER})`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

before(async () => {
  await cleanup();

  await sql`
    INSERT INTO tenant (id, name, slug, primary_idp)
    VALUES (${TENANT}, 'IP-Report Test Firm', 'ip-report-test', 'mixed')
  `;
  await sql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES
      (${ADMIN_USER}, 'ip-report-admin@example.com', 'microsoft', 'microsoft:ip-report-admin', 'Report Admin'),
      (${APPROVER_USER}, 'ip-report-approver@example.com', 'microsoft', 'microsoft:ip-report-approver', 'Audrey Approver')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name, kind)
    VALUES (${SUBJECT}, ${TENANT}, 'IP-Report Claimant Co', 'claimant')
  `;
  await privilegedSql`
    INSERT INTO subject_tenant_employee (id, subject_tenant_id, tenant_id, email, name, invited_by_user_id)
    VALUES (${EMPLOYEE}, ${SUBJECT}, ${TENANT}, 'ip-report-emp@example.com', 'IP-Report Employee', ${ADMIN_USER})
  `;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
    VALUES (${PROJECT}, ${TENANT}, ${SUBJECT}, 'IP-Report Project', '2025-07-01T00:00:00Z')
  `;
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
    VALUES
      (${CLAIM_SINGLE}, ${TENANT}, ${SUBJECT}, ${PROJECT}, 2024, 'engagement'),
      (${CLAIM_MULTI},  ${TENANT}, ${SUBJECT}, ${PROJECT}, 2025, 'engagement'),
      (${CLAIM_EMPTY},  ${TENANT}, ${SUBJECT}, ${PROJECT}, 2026, 'engagement')
  `;
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, fy_label, hypothesis_formed_at)
    VALUES (${ACTIVITY_SINGLE}, ${TENANT}, ${PROJECT}, ${CLAIM_SINGLE},
            'CA-01', 'core', 'Single-hypothesis activity', 'FY25', '2025-01-01T00:00:00Z')
  `;
  // Seed 5 activities under CLAIM_MULTI.
  for (let i = 0; i < ACTIVITIES_MULTI.length; i += 1) {
    const id = ACTIVITIES_MULTI[i]!;
    const code = `CA-${String(i + 1).padStart(2, '0')}`;
    const title = `Multi activity ${i + 1}`;
    await privilegedSql`
      INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title, fy_label, hypothesis_formed_at)
      VALUES (${id}, ${TENANT}, ${PROJECT}, ${CLAIM_MULTI},
              ${code}, ${i === 0 ? 'core' : 'supporting'}, ${title}, 'FY25', '2025-01-01T00:00:00Z')
    `;
  }
});

beforeEach(async () => {
  // Wipe IP-search state + media between tests; keep tenant/users/etc.
  await privilegedSql`DELETE FROM ip_search_verdict WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM ip_search_hit
                       WHERE search_run_id IN (
                         SELECT id FROM ip_search_run WHERE tenant_id = ${TENANT}
                       )`;
  await privilegedSql`DELETE FROM ip_search_run WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM media_artefact WHERE tenant_id = ${TENANT}`;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedVerdict(args: {
  claimId: string;
  activityId: string;
  hypothesisText: string;
  databases: Array<'ip_australia' | 'semantic_scholar' | 'pubmed' | 'arxiv'>;
}): Promise<void> {
  // One run + 2 hits per database, then one approved verdict.
  for (const db of args.databases) {
    const runId = crypto.randomUUID();
    await privilegedSql`
      INSERT INTO ip_search_run (
        id, tenant_id, claim_id, activity_id,
        hypothesis_text, hypothesis_hash, database_name, query, query_source,
        raw_response, result_count, ran_by_user_id
      ) VALUES (
        ${runId}, ${TENANT}, ${args.claimId}, ${args.activityId},
        ${args.hypothesisText}, 'beefcafe0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        ${db}, ${'q for ' + db}, 'llm',
        ${{}}, 2, ${APPROVER_USER}
      )
    `;
    for (let i = 0; i < 2; i += 1) {
      await privilegedSql`
        INSERT INTO ip_search_hit (id, search_run_id, external_id, title, url, relevance_score)
        VALUES (
          gen_random_uuid(), ${runId},
          ${db + '-ext-' + i},
          ${'Hit ' + i + ' from ' + db},
          ${'https://example.invalid/' + db + '/' + i},
          ${(0.9 - i * 0.1).toFixed(2)}
        )
      `;
    }
  }
  await privilegedSql`
    INSERT INTO ip_search_verdict (
      id, tenant_id, claim_id, activity_id,
      hypothesis_text, verdict, draft_verdict, analysis_markdown,
      approved_by_user_id, approved_at
    ) VALUES (
      gen_random_uuid(), ${TENANT}, ${args.claimId}, ${args.activityId},
      ${args.hypothesisText}, 'pass', 'pass',
      ${'Analyst concludes no blocking prior art for hypothesis: ' + args.hypothesisText + '.\n\nSecondary paragraph.'},
      ${APPROVER_USER}, now()
    )
  `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('happy path: 1 hypothesis + 1 verdict renders PDF and links every verdict to one media_artefact', async () => {
  await seedVerdict({
    claimId: CLAIM_SINGLE,
    activityId: ACTIVITY_SINGLE,
    hypothesisText: 'Novel thermal-stable graphene anode coating',
    databases: ['ip_australia', 'pubmed'],
  });

  const result = await runIpSearchReportRenderPdfJob({ claim_id: CLAIM_SINGLE });
  assert.equal(result.status, 'rendered');
  if (result.status !== 'rendered') return;
  assert.equal(result.verdict_count, 1);
  assert.ok(result.media_artefact_id);

  // Verdict.pdf_evidence_id should point at the new media_artefact.
  const verdicts = await privilegedSql<{ pdf_evidence_id: string | null }[]>`
    SELECT pdf_evidence_id::text AS pdf_evidence_id
      FROM ip_search_verdict
     WHERE claim_id = ${CLAIM_SINGLE}
  `;
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.pdf_evidence_id, result.media_artefact_id);

  // media_artefact row exists with the right mime + size.
  const artefacts = await privilegedSql<
    {
      mime_type: string;
      size_bytes: number | string;
      s3_key: string;
    }[]
  >`
    SELECT mime_type, size_bytes, s3_key
      FROM media_artefact
     WHERE id = ${result.media_artefact_id}
  `;
  assert.equal(artefacts.length, 1);
  assert.equal(artefacts[0]!.mime_type, 'application/pdf');
  const sizeBytes =
    typeof artefacts[0]!.size_bytes === 'string'
      ? Number(artefacts[0]!.size_bytes)
      : artefacts[0]!.size_bytes;
  // A non-trivial PDF — the renderer emits at minimum a few KB even
  // for a single hypothesis.
  assert.ok(sizeBytes > 1000, `expected PDF size > 1KB, got ${sizeBytes}`);
  assert.ok(artefacts[0]!.s3_key.includes('/ip-search-reports/'));
});

test('multi-hypothesis path: 5 approved verdicts fan out to the same media_artefact', async () => {
  for (let i = 0; i < ACTIVITIES_MULTI.length; i += 1) {
    await seedVerdict({
      claimId: CLAIM_MULTI,
      activityId: ACTIVITIES_MULTI[i]!,
      hypothesisText: `Multi-claim hypothesis ${i + 1}`,
      // Vary database mix per hypothesis so the queries-table renderer
      // exercises grouping.
      databases:
        i % 2 === 0 ? ['ip_australia', 'semantic_scholar'] : ['pubmed', 'arxiv', 'ip_australia'],
    });
  }

  const result = await runIpSearchReportRenderPdfJob({ claim_id: CLAIM_MULTI });
  assert.equal(result.status, 'rendered');
  if (result.status !== 'rendered') return;
  assert.equal(result.verdict_count, 5);

  // All 5 verdicts share the same pdf_evidence_id.
  const verdicts = await privilegedSql<{ pdf_evidence_id: string | null }[]>`
    SELECT pdf_evidence_id::text AS pdf_evidence_id
      FROM ip_search_verdict
     WHERE claim_id = ${CLAIM_MULTI}
  `;
  assert.equal(verdicts.length, 5);
  const uniqueIds = new Set(verdicts.map((v) => v.pdf_evidence_id));
  assert.equal(uniqueIds.size, 1, 'all 5 verdicts should share one pdf_evidence_id');
  assert.equal([...uniqueIds][0], result.media_artefact_id);
});

test('idempotency: re-running the job no-ops and does not insert a second media_artefact', async () => {
  await seedVerdict({
    claimId: CLAIM_SINGLE,
    activityId: ACTIVITY_SINGLE,
    hypothesisText: 'Idempotency hypothesis',
    databases: ['ip_australia'],
  });

  const first = await runIpSearchReportRenderPdfJob({ claim_id: CLAIM_SINGLE });
  assert.equal(first.status, 'rendered');
  if (first.status !== 'rendered') return;

  const second = await runIpSearchReportRenderPdfJob({ claim_id: CLAIM_SINGLE });
  assert.equal(second.status, 'already_generated');
  if (second.status !== 'already_generated') return;
  assert.equal(second.media_artefact_id, first.media_artefact_id);
  assert.equal(second.verdict_count, 1);

  // Only one media_artefact row for this tenant for the IP-search prefix.
  const arts = await privilegedSql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n
      FROM media_artefact
     WHERE tenant_id = ${TENANT}
       AND s3_key LIKE '%/ip-search-reports/%'
  `;
  assert.equal(arts[0]!.n, '1');
});

test('no approved verdicts → status: no_verdicts (terminal, not failed)', async () => {
  // CLAIM_EMPTY has no verdicts at all.
  const result = await runIpSearchReportRenderPdfJob({ claim_id: CLAIM_EMPTY });
  assert.equal(result.status, 'no_verdicts');
});

test('unknown claim id → status: claim_not_found (terminal, not failed)', async () => {
  const result = await runIpSearchReportRenderPdfJob({
    claim_id: '00000000-0000-4000-8000-0000007d09ff',
  });
  assert.equal(result.status, 'claim_not_found');
});

test('invalid input shape → status: failed (does not throw)', async () => {
  const result = await runIpSearchReportRenderPdfJob({ claim_id: 'not-a-uuid' });
  assert.equal(result.status, 'failed');
});
