import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagOverlappingManualEntries, type SqlClient } from './time-entry-conflict.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000c01';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000c02';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000c03';

type StubResult = Array<{ id: string }>;
type CapturedQuery = { sql: string; params: unknown[] };

function makeSqlStub(result: StubResult): {
  sql: SqlClient;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const rendered = strings.join('?');
    queries.push({ sql: rendered, params: values });
    return Promise.resolve(result);
  }) as unknown as SqlClient;
  return { sql: fn, queries };
}

test('flagOverlappingManualEntries: 1 manual entry overlapping → returns 1', async () => {
  // Stub returns a single row id → helper reports 1 flagged.
  const { sql, queries } = makeSqlStub([{ id: 'manual-entry-1' }]);
  const flagged = await flagOverlappingManualEntries({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    employee_id: EMPLOYEE_ID,
    period_start: '2026-04-25T09:00:00Z',
    period_end: '2026-04-25T17:00:00Z',
    sql_client: sql,
  });
  assert.equal(flagged, 1);
  assert.equal(queries.length, 1);
  // Sanity-check the SQL shape: tstzrange overlap on (started_at,
  // ended_at) intersected with the supplied period, restricted to
  // unflagged manual rows.
  const q = queries[0]!.sql;
  assert.ok(q.includes('UPDATE time_entry'));
  assert.ok(q.includes("source = 'manual'"));
  assert.ok(q.includes('flagged_at IS NULL'));
  assert.ok(q.includes('tstzrange(started_at, ended_at)'));
  assert.ok(q.includes('&&'));
});

test('flagOverlappingManualEntries: no overlapping entries → returns 0', async () => {
  // Stub returns empty — RETURNING produced no rows because nothing
  // matched the WHERE clause.
  const { sql } = makeSqlStub([]);
  const flagged = await flagOverlappingManualEntries({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    employee_id: EMPLOYEE_ID,
    period_start: '2026-04-26T09:00:00Z',
    period_end: '2026-04-26T17:00:00Z',
    sql_client: sql,
  });
  assert.equal(flagged, 0);
});

test('flagOverlappingManualEntries: idempotent — already-flagged rows excluded', async () => {
  // The helper's WHERE clause has `flagged_at IS NULL`, so on a re-run
  // a previously-flagged row is excluded server-side. Stub returns
  // empty (no rows matched the predicate this round) and the helper
  // reports 0 flagged — confirming the second invocation is a no-op.
  const { sql, queries } = makeSqlStub([]);
  const flagged = await flagOverlappingManualEntries({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    employee_id: EMPLOYEE_ID,
    period_start: '2026-04-25T09:00:00Z',
    period_end: '2026-04-25T17:00:00Z',
    sql_client: sql,
  });
  assert.equal(flagged, 0);
  // Confirm only ONE UPDATE was issued (helper doesn't double-issue).
  assert.equal(queries.length, 1);
});

test('flagOverlappingManualEntries: forwards period bounds as parameters', async () => {
  // Tagged-template parameter binding — the period bounds must arrive
  // as the literal ISO strings the caller supplied (no Date coercion,
  // no normalisation). subject_tenant_id and employee_id likewise.
  const { sql, queries } = makeSqlStub([{ id: 'm1' }]);
  await flagOverlappingManualEntries({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    employee_id: EMPLOYEE_ID,
    period_start: '2026-04-25T09:00:00Z',
    period_end: '2026-04-25T17:00:00Z',
    sql_client: sql,
  });
  const q = queries[0]!;
  assert.deepEqual(q.params, [
    SUBJECT_ID,
    EMPLOYEE_ID,
    '2026-04-25T09:00:00Z',
    '2026-04-25T17:00:00Z',
  ]);
});

test('flagOverlappingManualEntries: multiple overlapping rows → returns count', async () => {
  // Several manual entries within the same payroll-pulled period —
  // common after a long weekend where the employee back-filled
  // multiple shifts before the payroll sync ran.
  const { sql } = makeSqlStub([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
  const flagged = await flagOverlappingManualEntries({
    tenant_id: TENANT_ID,
    subject_tenant_id: SUBJECT_ID,
    employee_id: EMPLOYEE_ID,
    period_start: '2026-04-25T00:00:00Z',
    period_end: '2026-04-26T00:00:00Z',
    sql_client: sql,
  });
  assert.equal(flagged, 3);
});
