import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import { buildApp } from '../app.js';
import { _internals } from './compliance.js';

/**
 * P7 Theme D Task D.7 — Form-completeness contract test.
 *
 * Loads the `r-and-d-form-2025-08-15-schema.json` fixture and asserts:
 *   1. Every mandatory dimension in the fixture is checked by the
 *      form-completeness endpoint.
 *   2. When a dimension's data is absent, the endpoint reports it incomplete.
 *   3. When all dimensions are populated, the endpoint reports complete=true.
 *   4. Narrative thresholds in the fixture match the API's internal constants.
 *
 * If a new mandatory field is added to the fixture without corresponding
 * endpoint support, the test fails — this is the "contract" enforcement.
 *
 * UUID segment: d700 — isolates from other suites.
 */

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

// Fixture UUIDs — d700 segment
const TENANT_D7 = '00000000-0000-4000-8000-0000d7000001';
const USER_D7 = '00000000-0000-4000-8000-0000d7000002';
const SUBJECT_D7 = '00000000-0000-4000-8000-0000d7000003';
const PROJECT_D7 = '00000000-0000-4000-8000-0000d7000004';
const CLAIM_D7 = '00000000-0000-4000-8000-0000d7000005';
const ACTIVITY_D7 = '00000000-0000-4000-8000-0000d7000006';
const FY = 'FY25';

let dbAvailable = false;

interface FormSchema {
  dimensions: Record<
    string,
    {
      mandatory: boolean;
      rule: string;
      min_count?: number;
      required_offsets?: number[];
      min_records_per_activity?: number;
      sections?: Record<string, { min_chars: number; max_chars: number }>;
    }
  >;
}

let fixture: FormSchema;

const cleanup = async (): Promise<void> => {
  try {
    await privilegedSql`DELETE FROM narrative_draft WHERE tenant_id = ${TENANT_D7}`;
    await privilegedSql`DELETE FROM rd_forecast WHERE tenant_id = ${TENANT_D7}`;
    await privilegedSql`DELETE FROM r_and_d_facility WHERE tenant_id = ${TENANT_D7}`;
    await privilegedSql`DELETE FROM knowledge_search_record WHERE tenant_id = ${TENANT_D7}`;
    await privilegedSql`DELETE FROM beneficial_ownership WHERE tenant_id = ${TENANT_D7}`;
    await privilegedSql`DELETE FROM activity WHERE tenant_id = ${TENANT_D7}`;
    await privilegedSql`DELETE FROM claim WHERE tenant_id = ${TENANT_D7}`;
    await privilegedSql`DELETE FROM project WHERE tenant_id = ${TENANT_D7}`;
    await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id = ${TENANT_D7}`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_D7}`;
    await sql`DELETE FROM "user" WHERE id = ${USER_D7}`;
    await sql`DELETE FROM tenant WHERE id = ${TENANT_D7}`;
  } catch {
    // ignore — DB unreachable
  }
};

before(async () => {
  // Load fixture
  const fixturePath = resolve(
    import.meta.dirname ?? '.',
    '../../../../tests/fixtures/r-and-d-form-2025-08-15-schema.json',
  );
  const raw = await readFile(fixturePath, 'utf-8');
  fixture = JSON.parse(raw) as FormSchema;

  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await cleanup();

  // Seed minimal fixtures
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_D7}, 'Form Shape Test', 'form-shape-test', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${USER_D7}, 'form-shape@example.com', 'microsoft', 'microsoft:form-shape', 'Shape Tester')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_D7}, ${USER_D7}, 'consultant', true)`;
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${SUBJECT_D7}, ${TENANT_D7}, 'Form Shape Entity', 'claimant')`;
  await privilegedSql`INSERT INTO project (id, tenant_id, subject_tenant_id, name, started_at)
                       VALUES (${PROJECT_D7}, ${TENANT_D7}, ${SUBJECT_D7}, 'Shape Project', NOW())`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, project_id)
                       VALUES (${CLAIM_D7}, ${TENANT_D7}, ${SUBJECT_D7}, 2025, ${PROJECT_D7})`;
  // `activity` has no subject_tenant_id column — it links to its subject via
  // `claim.subject_tenant_id`. The form-completeness endpoint does the JOIN
  // server-side; the test only needs the (tenant, project, claim, code,
  // kind, title, fy_label, hypothesis_formed_at) NOT NULL columns.
  await privilegedSql`INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title,
                                            fy_label, hypothesis_formed_at)
                       VALUES (${ACTIVITY_D7}, ${TENANT_D7}, ${PROJECT_D7}, ${CLAIM_D7},
                               'FS-01', 'core', 'Form Shape Activity',
                               ${FY}, '2025-01-01T00:00:00Z')`;
});

after(async () => {
  if (dbAvailable) await cleanup();
  try {
    await sql.end();
    await privilegedSql.end();
  } catch {
    // ignore
  }
});

const makeToken = (): Promise<string> =>
  signSession(
    {
      sub: USER_D7,
      email: 'form-shape@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: TENANT_D7,
      activeRole: 'consultant',
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

const skipIfNoDb = (t: { skip: (msg?: string) => void }): boolean => {
  if (!dbAvailable) {
    t.skip('Postgres not reachable — DB-gated test skipped');
    return true;
  }
  return false;
};

// ===========================================================================
// Contract assertions: fixture schema matches API internals
// ===========================================================================

describe('form-completeness contract: fixture ↔ API alignment', () => {
  test('all fixture dimensions map to known endpoint check keys', () => {
    // The endpoint returns a `checks` object with one key per dimension.
    // If the fixture adds a new mandatory dimension, this test fails.
    const fixtureDimensions = Object.keys(fixture.dimensions).sort();
    const endpointDimensions = [
      'knowledge_search',
      'beneficial_ownership',
      'forecast',
      'facilities',
      'narratives',
    ].sort();

    assert.deepEqual(
      fixtureDimensions,
      endpointDimensions,
      'Fixture dimensions must exactly match endpoint check keys. If you added a new dimension to the fixture, implement support in the form-completeness endpoint.',
    );
  });

  test('narrative thresholds in fixture match API NARRATIVE_THRESHOLDS', () => {
    const fixtureSections = fixture.dimensions['narratives']?.sections;
    assert.ok(fixtureSections, 'Fixture must define narrative sections');

    for (const [section, spec] of Object.entries(fixtureSections)) {
      const apiThreshold = _internals.NARRATIVE_THRESHOLDS[section];
      assert.ok(apiThreshold, `API NARRATIVE_THRESHOLDS missing section: ${section}`);
      assert.equal(
        spec.min_chars,
        apiThreshold.min,
        `Fixture min_chars for '${section}' must match API (fixture=${spec.min_chars}, api=${apiThreshold.min})`,
      );
      assert.equal(
        spec.max_chars,
        apiThreshold.max,
        `Fixture max_chars for '${section}' must match API (fixture=${spec.max_chars}, api=${apiThreshold.max})`,
      );
    }
  });

  test('forecast required_offsets in fixture match API FORECAST_OFFSETS', () => {
    const fixtureOffsets = fixture.dimensions['forecast']?.required_offsets;
    assert.ok(fixtureOffsets, 'Fixture must define forecast required_offsets');
    assert.deepEqual(
      [...fixtureOffsets].sort(),
      Array.from(_internals.FORECAST_OFFSETS).sort(),
      'Fixture required_offsets must match API FORECAST_OFFSETS',
    );
  });
});

// ===========================================================================
// DB-gated: dimension-by-dimension contract tests
// ===========================================================================

describe('form-completeness contract: empty state reports all incomplete', () => {
  test('with no compliance data, all dimensions report incomplete', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    await app.ready();
    const token = await makeToken();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/compliance/form-completeness/${SUBJECT_D7}/${FY}`,
      cookies: { cpa_session: token },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      complete: boolean;
      checks: Record<string, { complete: boolean }>;
    };
    assert.equal(body.complete, false, 'Overall completeness must be false with empty data');

    // Each mandatory fixture dimension must map to an incomplete check
    for (const [dim, spec] of Object.entries(fixture.dimensions)) {
      if (!spec.mandatory) continue;
      const check = body.checks[dim];
      assert.ok(check, `Endpoint must report on fixture dimension: ${dim}`);
      assert.equal(
        check.complete,
        false,
        `Dimension '${dim}' must be incomplete when data is absent`,
      );
    }

    await app.close();
  });
});

describe('form-completeness contract: full state reports complete', () => {
  test('with all compliance data populated, reports complete=true', async (t) => {
    if (skipIfNoDb(t)) return;
    const app = buildApp();
    await app.ready();
    const token = await makeToken();

    // Seed all dimensions
    // (a) knowledge_search_record — columns per migration 0039:
    //     subject_tenant_id NOT NULL, search_query (not "search_terms"),
    //     sources_consulted jsonb (not "search_source" text), finding_summary
    //     NOT NULL.
    await privilegedSql`INSERT INTO knowledge_search_record
      (id, tenant_id, subject_tenant_id, activity_id, search_date,
       search_query, sources_consulted, finding_summary)
      VALUES (gen_random_uuid(), ${TENANT_D7}, ${SUBJECT_D7}, ${ACTIVITY_D7},
              CURRENT_DATE, 'polymer blend prior art',
              ${JSON.stringify(['Google Scholar', 'IEEE Xplore'])}::text::jsonb,
              'No prior art identified for the specific blend ratio.')`;

    // (b) beneficial_ownership
    await privilegedSql`INSERT INTO beneficial_ownership
      (id, tenant_id, subject_tenant_id, fy_label, owner_kind, owner_name, ownership_pct, is_associate, is_foreign_related)
      VALUES (gen_random_uuid(), ${TENANT_D7}, ${SUBJECT_D7}, ${FY}, 'individual', 'Jane Smith', 100.00, false, false)`;

    // (c) forecast offsets 1, 2, 3
    for (const offset of [1, 2, 3]) {
      await privilegedSql`INSERT INTO rd_forecast
        (id, tenant_id, subject_tenant_id, base_fy_label, forecast_year_offset, projected_spend_aud, projected_headcount, confidence)
        VALUES (gen_random_uuid(), ${TENANT_D7}, ${SUBJECT_D7}, ${FY}, ${offset}, 500000.00, 5, 'medium')`;
    }

    // (d) r_and_d_facility — column is `address` (not "address_text") and
    //     `is_owned` is NOT NULL with no default.
    await privilegedSql`INSERT INTO r_and_d_facility
      (id, tenant_id, subject_tenant_id, fy_label, facility_name, address, is_owned, used_for_activity_ids)
      VALUES (gen_random_uuid(), ${TENANT_D7}, ${SUBJECT_D7}, ${FY},
              'Main Lab', '123 Research St', true,
              ARRAY[${ACTIVITY_D7}]::uuid[])`;

    // (e) narrative_draft for all required sections.
    //     `narrative_draft` stores content as a jsonb `segments` array of
    //     NarrativeSegment shapes — there is no flat `content` column. All
    //     of (current_version, status, content_hash, model, prompt_version,
    //     created_by_user_id) are NOT NULL with no default. The completeness
    //     endpoint sums LENGTH(segments[i]->>'text') across the array, so
    //     a single prose segment of `min_chars` characters satisfies the
    //     threshold.
    const sections = Object.entries(fixture.dimensions['narratives']?.sections ?? {});
    for (const [section, spec] of sections) {
      const text = 'A'.repeat(spec.min_chars);
      const segments = JSON.stringify([{ type: 'prose', text }]);
      await privilegedSql`INSERT INTO narrative_draft
        (id, tenant_id, activity_id, section_kind, segments, content_hash,
         model, prompt_version, current_version, status, created_by_user_id)
        VALUES (gen_random_uuid(), ${TENANT_D7}, ${ACTIVITY_D7}, ${section},
                ${segments}::text::jsonb,
                ${'h_' + section.padEnd(62, '0')},
                'claude-sonnet-4-5', 'draft-narrative@1.0.0',
                1, 'complete', ${USER_D7})`;
    }

    const res = await app.inject({
      method: 'GET',
      url: `/v1/compliance/form-completeness/${SUBJECT_D7}/${FY}`,
      cookies: { cpa_session: token },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      complete: boolean;
      checks: Record<string, { complete: boolean }>;
    };
    assert.equal(body.complete, true, 'Overall completeness must be true when all data present');

    for (const [dim, spec] of Object.entries(fixture.dimensions)) {
      if (!spec.mandatory) continue;
      const check = body.checks[dim];
      assert.ok(check, `Endpoint must report on fixture dimension: ${dim}`);
      assert.equal(
        check.complete,
        true,
        `Dimension '${dim}' must be complete when data is populated`,
      );
    }

    await app.close();
  });
});
