import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { privilegedSql } from '../client.js';

/**
 * P8 Task T1.4 — Automated RLS coverage audit.
 *
 * Queries pg_class + pg_policy to verify every public-schema table either:
 *   (a) has relrowsecurity=true with at least one policy, OR
 *   (b) is explicitly listed in RLS_EXEMPT_TABLES with documented rationale.
 *
 * Runs on every CI build. New tables missing RLS will fail CI until either
 * RLS is added (preferred) or the exemption list is updated with rationale
 * in docs/iso27001/access-control/rls-coverage.md.
 *
 * DB-gated: skips gracefully when Postgres is unreachable.
 */

/**
 * Tables intentionally NOT RLS-protected. ANY addition requires updating
 * docs/iso27001/access-control/rls-coverage.md with rationale + compensating
 * control description.
 */
const RLS_EXEMPT_TABLES = new Set([
  'tenant', // global identity; tenant_user membership is the RLS gate
  'user', // global identity; ACL via tenant_user + subject_tenant_user
  'system', // system config KV; no tenant scope (P0 bootstrap table)
  'agent_call_cache', // content-addressed by SHA-256; no tenant data (0006)
  'magic_link_token', // lookup by hash before tenant context exists (0008)
  'mobile_session', // accessed via employee_id; transitive RLS via subject_tenant_employee (0008)
  'expenditure_line', // child of expenditure; tenant_id on parent which IS RLS-enforced (0013)
  'narrative_segment', // child of narrative_draft; tenant scope via JOIN to parent (0037)
  '__drizzle_migrations', // migration metadata; admin-only
]);

let dbAvailable = false;

before(async () => {
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  try {
    await privilegedSql.end();
  } catch {
    // ignore
  }
});

const skipIfNoDb = (t: { skip: (msg?: string) => void }): boolean => {
  if (!dbAvailable) {
    t.skip('Postgres not reachable — DB-gated test skipped');
    return true;
  }
  return false;
};

describe('RLS coverage audit (T1.4)', () => {
  test('every public-schema table has RLS enabled or is in exempt list', async (t) => {
    if (skipIfNoDb(t)) return;

    const tables = await privilegedSql<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
       ORDER BY c.relname
    `;

    const missing = tables.filter(
      (tbl) => !tbl.relrowsecurity && !RLS_EXEMPT_TABLES.has(tbl.relname),
    );

    assert.deepEqual(
      missing.map((tbl) => tbl.relname),
      [],
      `${missing.length} tables missing RLS without exempt-list entry: ${missing
        .map((tbl) => tbl.relname)
        .join(', ')}`,
    );
  });

  test('every RLS-enabled table has at least one policy', async (t) => {
    if (skipIfNoDb(t)) return;

    const tables = await privilegedSql<{ relname: string; policy_count: number }[]>`
      SELECT c.relname, COUNT(p.polname)::int AS policy_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relrowsecurity = true
       GROUP BY c.relname
       ORDER BY c.relname
    `;

    const noPolicy = tables.filter((tbl) => tbl.policy_count === 0);
    assert.deepEqual(
      noPolicy.map((tbl) => tbl.relname),
      [],
      `RLS enabled but no policies (default-deny accidental?): ${noPolicy
        .map((tbl) => tbl.relname)
        .join(', ')}`,
    );
  });

  test('exempt list has no phantom entries (every exempt table exists)', async (t) => {
    if (skipIfNoDb(t)) return;

    const tables = await privilegedSql<{ relname: string }[]>`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
       ORDER BY c.relname
    `;

    const tableNames = new Set(tables.map((tbl) => tbl.relname));
    const phantomExemptions = [...RLS_EXEMPT_TABLES].filter((name) => !tableNames.has(name));

    assert.deepEqual(
      phantomExemptions,
      [],
      `Exempt list references non-existent tables: ${phantomExemptions.join(', ')}`,
    );
  });
});
