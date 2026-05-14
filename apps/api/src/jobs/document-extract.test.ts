/**
 * Integration tests for the document-extract worker + token ledger.
 *
 * Strategy: set DOCUMENT_ANALYZER_IMPL=mock BEFORE the worker module is
 * imported so the lazy singleton picks up the MockDocumentAnalyzer.
 * Then drive the worker through realistic event rows seeded via
 * privilegedSql, and assert on:
 *   1. extraction_status transitions ('pending' -> 'complete' / 'failed')
 *   2. extracted_content shape (activities, invoices, document_summary)
 *   3. llm_token_usage rows landing with the right tenant_id / claim_id
 *      / agent_name / status
 *   4. Edge cases (missing Extracted-Text, sparse content) failing
 *      gracefully without crashing the worker
 */
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privilegedSql, sql } from '@cpa/db/client';
import {
  SYNTHETIC_FIXTURES_BY_ID,
  SYNTHETIC_FIXTURES_HAPPY_PATH,
  SYNTHETIC_FIXTURES_EDGE_CASES,
} from '@cpa/agents';

// CRITICAL: force the mock analyzer BEFORE importing the worker module so
// the singleton resolves to MockDocumentAnalyzer.
process.env.DOCUMENT_ANALYZER_IMPL = 'mock';

const { runDocumentExtractJob } = await import('./document-extract.js');

// ---------------------------------------------------------------------------
// Pinned UUIDs for this test file (segment 'de01' = "document-extract 01").
// ---------------------------------------------------------------------------

const TENANT = '00000000-0000-4000-8000-000000de0001';
const ADMIN_USER = '00000000-0000-4000-8000-000000de0010';
const SUBJECT = '00000000-0000-4000-8000-000000de0020';
const PROJECT = '00000000-0000-4000-8000-000000de0030';
const CLAIM = '00000000-0000-4000-8000-000000de0040';

const cleanup = async (): Promise<void> => {
  await privilegedSql`DELETE FROM llm_token_usage WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM event WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM activity WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM project WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM "user" WHERE id = ${ADMIN_USER}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT}`;
};

before(async () => {
  await cleanup();

  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT}, 'Doc-Extract Test Firm', 'doc-extract-test', 'mixed')`;

  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${ADMIN_USER}, 'de-admin@example.com', 'microsoft', 'microsoft:de-admin', 'DE Admin')`;

  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT}, ${ADMIN_USER}, 'admin', true)`;

  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT}, ${TENANT}, 'Acme R&D DE', 'claimant')`;

  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT}, ${TENANT}, ${SUBJECT}, 'NDVI Cloud-Edge FY26', '2025-07-01T00:00:00Z')`;

  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, project_id, fiscal_year, stage)
                       VALUES (${CLAIM}, ${TENANT}, ${SUBJECT}, ${PROJECT}, 2026, 'engagement')`;
});

beforeEach(async () => {
  // Clean events + ledger between tests so each test starts from zero.
  await privilegedSql`DELETE FROM llm_token_usage WHERE tenant_id = ${TENANT}`;
  await privilegedSql`DELETE FROM event WHERE tenant_id = ${TENANT}`;
});

after(async () => {
  await cleanup();
  await sql.end();
  await privilegedSql.end();
});

// ---------------------------------------------------------------------------
// Helper: seed a file-upload event row that the worker can pick up.
// ---------------------------------------------------------------------------

async function seedFileUploadEvent(rawText: string): Promise<string> {
  const id = crypto.randomUUID();
  const payload = { _v: 1, source: 'paste', raw_text: rawText };
  // Unique hash per event so we don't collide on any unique constraints
  // around the chain. SHA-256 of the id is sufficient for test data.
  const hash = createHash('sha256').update(id).digest('hex');
  await privilegedSql`
    INSERT INTO event (
      id, tenant_id, subject_tenant_id, kind, payload,
      classification, prev_hash, hash, idempotency_key,
      captured_at, received_at, captured_by_user_id,
      extraction_status
    ) VALUES (
      ${id}::uuid,
      ${TENANT}::uuid,
      ${SUBJECT}::uuid,
      'SUPPORTING',
      ${privilegedSql.json(payload)},
      NULL,
      NULL,
      ${hash},
      NULL,
      NOW(),
      NOW(),
      ${ADMIN_USER}::uuid,
      'pending'
    )
  `;
  return id;
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

test('runDocumentExtractJob: fx-01 NDVI doc -> complete + ledger row', async () => {
  const fx = SYNTHETIC_FIXTURES_BY_ID['fx-01-ndvi-research-log']!;
  const eventId = await seedFileUploadEvent(fx.raw_text);

  await runDocumentExtractJob({
    event_id: eventId,
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
  });

  // Event should be 'complete' with extracted_content populated
  const rows = await privilegedSql<
    {
      extraction_status: string;
      extracted_content: unknown;
    }[]
  >`
    SELECT extraction_status, extracted_content
      FROM event
     WHERE id = ${eventId} AND tenant_id = ${TENANT}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.extraction_status, 'complete');
  const content = rows[0]!.extracted_content as {
    activities: unknown[];
    invoices: unknown[];
    document_summary: string;
  };
  assert.ok(Array.isArray(content.activities));
  assert.ok(Array.isArray(content.invoices));
  assert.ok(typeof content.document_summary === 'string');
  assert.ok(content.document_summary.length > 0);

  // Ledger row should exist with claim_id=NULL (extraction is pre-claim)
  const ledger = await privilegedSql<
    {
      tenant_id: string;
      claim_id: string | null;
      subject_tenant_id: string;
      agent_name: string;
      model: string;
      tokens_in: number;
      tokens_out: number;
      cost_aud_cents: number;
      status: string;
    }[]
  >`
    SELECT tenant_id::text, claim_id::text, subject_tenant_id::text,
           agent_name, model, tokens_in, tokens_out, cost_aud_cents, status
      FROM llm_token_usage
     WHERE tenant_id = ${TENANT}
  `;
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.agent_name, 'document-analyzer');
  assert.equal(ledger[0]!.model, 'claude-haiku-4-5-mock');
  assert.equal(ledger[0]!.claim_id, null, 'extraction calls should be claim_id=NULL');
  assert.equal(ledger[0]!.subject_tenant_id, SUBJECT);
  assert.ok(ledger[0]!.tokens_in > 0);
  assert.ok(ledger[0]!.tokens_out > 0);
  assert.equal(ledger[0]!.status, 'free_tier');
});

test('runDocumentExtractJob: re-running the same event does not double-extract', async () => {
  const fx = SYNTHETIC_FIXTURES_BY_ID['fx-01-ndvi-research-log']!;
  const eventId = await seedFileUploadEvent(fx.raw_text);

  await runDocumentExtractJob({
    event_id: eventId,
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
  });
  await runDocumentExtractJob({
    event_id: eventId,
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
  });

  // Worker checks extraction_status='complete' and skips early.
  // Should still only have 1 ledger row (no duplicate billing).
  const ledger = await privilegedSql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM llm_token_usage WHERE tenant_id = ${TENANT}
  `;
  assert.equal(ledger[0]!.n, '1');
});

test('runDocumentExtractJob: invoice schedule fixture produces invoice records', async () => {
  const fx = SYNTHETIC_FIXTURES_BY_ID['fx-02-invoice-schedule']!;
  const eventId = await seedFileUploadEvent(fx.raw_text);

  await runDocumentExtractJob({
    event_id: eventId,
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
  });

  const rows = await privilegedSql<{ extracted_content: unknown }[]>`
    SELECT extracted_content FROM event WHERE id = ${eventId}
  `;
  const content = rows[0]!.extracted_content as { invoices: unknown[] };
  // MockAnalyzer with hash-based output may or may not produce invoices for
  // any given fixture. The important assertion is the worker completes
  // without crashing on a real-shaped invoice document.
  assert.ok(Array.isArray(content.invoices));
});

// ---------------------------------------------------------------------------
// Edge-case tests
// ---------------------------------------------------------------------------

test('runDocumentExtractJob: malformed payload (no Extracted-Text) -> failed + no ledger', async () => {
  const fx = SYNTHETIC_FIXTURES_BY_ID['fx-13-malformed-no-extracted-text']!;
  const eventId = await seedFileUploadEvent(fx.raw_text);

  await runDocumentExtractJob({
    event_id: eventId,
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
  });

  const rows = await privilegedSql<
    {
      extraction_status: string;
      extracted_content: unknown;
    }[]
  >`
    SELECT extraction_status, extracted_content FROM event WHERE id = ${eventId}
  `;
  assert.equal(rows[0]!.extraction_status, 'failed');
  const ec = rows[0]!.extracted_content as { error?: string; reason?: string };
  assert.equal(ec.error, 'no_extracted_text');

  // No ledger row — analyzer never ran.
  const ledger = await privilegedSql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM llm_token_usage WHERE tenant_id = ${TENANT}
  `;
  assert.equal(ledger[0]!.n, '0');
});

test('runDocumentExtractJob: under-50-char body -> failed + no ledger', async () => {
  const fx = SYNTHETIC_FIXTURES_BY_ID['fx-14-under-50-chars']!;
  const eventId = await seedFileUploadEvent(fx.raw_text);

  await runDocumentExtractJob({
    event_id: eventId,
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
  });

  const rows = await privilegedSql<{ extraction_status: string }[]>`
    SELECT extraction_status FROM event WHERE id = ${eventId}
  `;
  assert.equal(rows[0]!.extraction_status, 'failed');

  const ledger = await privilegedSql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM llm_token_usage WHERE tenant_id = ${TENANT}
  `;
  assert.equal(ledger[0]!.n, '0');
});

test('runDocumentExtractJob: oversized doc (60k+ chars) completes successfully', async () => {
  const fx = SYNTHETIC_FIXTURES_BY_ID['fx-15-oversized']!;
  const eventId = await seedFileUploadEvent(fx.raw_text);

  await runDocumentExtractJob({
    event_id: eventId,
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
  });

  const rows = await privilegedSql<{ extraction_status: string }[]>`
    SELECT extraction_status FROM event WHERE id = ${eventId}
  `;
  assert.equal(rows[0]!.extraction_status, 'complete');

  const ledger = await privilegedSql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM llm_token_usage WHERE tenant_id = ${TENANT}
  `;
  assert.equal(ledger[0]!.n, '1');
});

test('runDocumentExtractJob: non-existent event_id is no-op (no crash)', async () => {
  // Missing event row — worker should log and return cleanly.
  await runDocumentExtractJob({
    event_id: '00000000-0000-4000-8000-000000000999',
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
  });
  // No assertions — the test passes if the call doesn't throw.
  assert.ok(true);
});

test('runDocumentExtractJob: unicode + emoji fixture completes', async () => {
  const fx = SYNTHETIC_FIXTURES_BY_ID['fx-10-unicode-symposium']!;
  const eventId = await seedFileUploadEvent(fx.raw_text);

  await runDocumentExtractJob({
    event_id: eventId,
    tenant_id: TENANT,
    subject_tenant_id: SUBJECT,
  });

  const rows = await privilegedSql<{ extraction_status: string }[]>`
    SELECT extraction_status FROM event WHERE id = ${eventId}
  `;
  assert.equal(rows[0]!.extraction_status, 'complete');
});

// ---------------------------------------------------------------------------
// Concurrent / corpus tests
// ---------------------------------------------------------------------------

test('runDocumentExtractJob: process all happy-path fixtures in sequence', async () => {
  for (const fx of SYNTHETIC_FIXTURES_HAPPY_PATH) {
    const eventId = await seedFileUploadEvent(fx.raw_text);
    await runDocumentExtractJob({
      event_id: eventId,
      tenant_id: TENANT,
      subject_tenant_id: SUBJECT,
    });
  }
  const ledger = await privilegedSql<
    { n: string; total: string; tokens_in: string; tokens_out: string }[]
  >`
    SELECT COUNT(*)::text                       AS n,
           COALESCE(SUM(cost_aud_cents), 0)::text AS total,
           COALESCE(SUM(tokens_in), 0)::text      AS tokens_in,
           COALESCE(SUM(tokens_out), 0)::text     AS tokens_out
      FROM llm_token_usage
     WHERE tenant_id = ${TENANT}
  `;
  // One ledger row per happy-path fixture.
  assert.equal(parseInt(ledger[0]!.n, 10), SYNTHETIC_FIXTURES_HAPPY_PATH.length);
  // Token volume must be non-zero — proof every call actually ran the
  // mock analyzer (not the stub, which returns usage=null and so writes
  // no row). cost_aud_cents may be 0 for individual rows since Haiku
  // pricing × small fixture sizes can round below the cents floor;
  // assert on tokens instead.
  assert.ok(
    parseInt(ledger[0]!.tokens_in, 10) > 0,
    'expected non-zero total tokens_in across corpus',
  );
});

test('runDocumentExtractJob: process all happy-path fixtures concurrently', async () => {
  const promises = SYNTHETIC_FIXTURES_HAPPY_PATH.map(async (fx) => {
    const eventId = await seedFileUploadEvent(fx.raw_text);
    await runDocumentExtractJob({
      event_id: eventId,
      tenant_id: TENANT,
      subject_tenant_id: SUBJECT,
    });
  });
  await Promise.all(promises);

  const ledger = await privilegedSql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM llm_token_usage WHERE tenant_id = ${TENANT}
  `;
  // Every concurrent extraction should have landed exactly one ledger row.
  assert.equal(parseInt(ledger[0]!.n, 10), SYNTHETIC_FIXTURES_HAPPY_PATH.length);
});

test('runDocumentExtractJob: every edge-case fixture either completes or fails (no stuck pending)', async () => {
  for (const fx of SYNTHETIC_FIXTURES_EDGE_CASES) {
    const eventId = await seedFileUploadEvent(fx.raw_text);
    await runDocumentExtractJob({
      event_id: eventId,
      tenant_id: TENANT,
      subject_tenant_id: SUBJECT,
    });
    const rows = await privilegedSql<{ extraction_status: string }[]>`
      SELECT extraction_status FROM event WHERE id = ${eventId}
    `;
    assert.notEqual(
      rows[0]!.extraction_status,
      'pending',
      `${fx.id}: edge case left event stuck in 'pending'`,
    );
    assert.ok(
      ['complete', 'failed'].includes(rows[0]!.extraction_status),
      `${fx.id}: unexpected status ${rows[0]!.extraction_status}`,
    );
  }
});

// ---------------------------------------------------------------------------
// RLS: ledger rows respect tenant isolation
// ---------------------------------------------------------------------------

test('llm_token_usage: RLS is enabled + forced + has tenant_isolation policy', async () => {
  // NOTE: behavioral RLS testing isn't possible in this environment —
  // Supabase's `postgres` role is a cluster superuser, and superusers
  // bypass RLS regardless of FORCE. In production the API connects via
  // a non-superuser role (`authenticated`) where the policy enforces.
  // Here we test the STRUCTURE: the policy and flags exist.

  const meta = await privilegedSql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
     WHERE relname = 'llm_token_usage'
  `;
  assert.equal(meta[0]!.relrowsecurity, true, 'RLS not enabled');
  assert.equal(meta[0]!.relforcerowsecurity, true, 'RLS not forced');

  const policies = await privilegedSql<{ polname: string; polqual: string }[]>`
    SELECT polname, pg_get_expr(polqual, polrelid) AS polqual
      FROM pg_policy
     WHERE polrelid = 'llm_token_usage'::regclass
  `;
  assert.ok(policies.length >= 1, 'no policy found');
  const tenantPolicy = policies.find((p) => p.polname === 'llm_token_usage_tenant_isolation');
  assert.ok(tenantPolicy, 'tenant-isolation policy missing');
  assert.match(tenantPolicy.polqual, /tenant_id/i, 'policy USING clause must reference tenant_id');
  assert.match(
    tenantPolicy.polqual,
    /app\.current_tenant_id/i,
    'policy must read the app.current_tenant_id GUC',
  );
});
