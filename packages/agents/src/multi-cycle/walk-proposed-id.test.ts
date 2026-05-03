import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  walkProposedIdChain,
  type ActivityHistoryRow,
  type ChainWalkExecutor,
} from './walk-proposed-id.js';

/**
 * Unit-test style — matches the existing `@cpa/agents` precedent
 * (classifier-expenditure, synthesizer-register) of pure unit tests
 * with no DB dependency. The executor is injected via DI so the test
 * asserts on:
 *   1. SQL shape (the JOIN + filter + ORDER BY clauses)
 *   2. Parameter binding (tenantId + rootProposedId reach the query)
 *   3. Tenant isolation (caller-passed tenantId is the one that lands
 *      in the SQL, not anything the executor invents)
 *   4. Result passthrough (the rows the executor returns are what the
 *      caller sees, in order)
 *
 * Integration coverage (real Postgres + activity_proposed_id_fy_idx
 * usage) lands separately under the migration test harness when Docker
 * is available in CI; this file exercises the SQL builder + DI seam.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

interface CapturedCall {
  text: string;
  values: unknown[];
}

/**
 * Build a stub executor that captures every tagged-template call and
 * returns the supplied rows. The captured `text` is the joined
 * template string with `?N` markers in place of each interpolated
 * value, which is enough to assert on SQL shape without coupling to
 * postgres-js's internal parameter rendering.
 */
function makeStubExecutor(rows: ActivityHistoryRow[]): {
  executor: ChainWalkExecutor;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const executor: ChainWalkExecutor = (template, ...values) => {
    const text = template.reduce(
      (acc, chunk, i) => acc + chunk + (i < values.length ? `?${i + 1}` : ''),
      '',
    );
    calls.push({ text, values });
    return Promise.resolve(rows as readonly ActivityHistoryRow[]);
  };
  return { executor, calls };
}

function row(overrides: Partial<ActivityHistoryRow> = {}): ActivityHistoryRow {
  return {
    activity_id: randomUUID(),
    fy_label: 'FY25',
    hypothesis_formed_at: new Date('2025-08-01T00:00:00Z'),
    proposed_id: randomUUID(),
    narrative_draft_id: randomUUID(),
    content_hash: 'a'.repeat(64),
    ...overrides,
  };
}

test('walkProposedIdChain returns all FY rows for a proposed_id, sorted by hypothesis_formed_at', async () => {
  const proposedId = randomUUID();
  // Stub returns rows in the order the SQL `ORDER BY` would emit them
  // (FY24 then FY25). The walker is a thin passthrough — its job is
  // to issue the right query and surface the rows the executor
  // returns; sorting itself happens in Postgres.
  const fy24 = row({
    proposed_id: proposedId,
    fy_label: 'FY24',
    hypothesis_formed_at: new Date('2024-08-01T00:00:00Z'),
  });
  const fy25 = row({
    proposed_id: proposedId,
    fy_label: 'FY25',
    hypothesis_formed_at: new Date('2025-08-01T00:00:00Z'),
  });
  const { executor } = makeStubExecutor([fy24, fy25]);

  const chain = await walkProposedIdChain(proposedId, TENANT_A, executor);

  assert.equal(chain.length, 2);
  assert.equal(chain[0]!.fy_label, 'FY24');
  assert.equal(chain[1]!.fy_label, 'FY25');
});

test('walkProposedIdChain respects tenant isolation (tenantId reaches the WHERE clause)', async () => {
  const proposedId = randomUUID();
  const { executor, calls } = makeStubExecutor([]);

  await walkProposedIdChain(proposedId, TENANT_A, executor);

  assert.equal(calls.length, 1);
  // Both bound parameters land — tenantId is parameter #1 (first
  // interpolation in the WHERE clause), proposedId is parameter #2.
  assert.deepEqual(calls[0]!.values, [TENANT_A, proposedId]);
  // SQL shape sanity: the tenant filter is present, parametrised, and
  // not collapsed into a string literal.
  assert.match(calls[0]!.text, /WHERE\s+a\.tenant_id\s*=\s*\?1/);
  assert.match(calls[0]!.text, /AND\s+a\.proposed_id\s*=\s*\?2/);
});

test('walkProposedIdChain orders by (fy_label ASC, hypothesis_formed_at ASC)', async () => {
  const proposedId = randomUUID();
  const { executor, calls } = makeStubExecutor([]);

  await walkProposedIdChain(proposedId, TENANT_A, executor);

  assert.match(calls[0]!.text, /ORDER BY\s+a\.fy_label\s+ASC,\s*a\.hypothesis_formed_at\s+ASC/);
});

test('walkProposedIdChain joins narrative_draft via activity_id (INNER JOIN per design)', async () => {
  const proposedId = randomUUID();
  const { executor, calls } = makeStubExecutor([]);

  await walkProposedIdChain(proposedId, TENANT_A, executor);

  // INNER JOIN (the bare `JOIN` keyword) — activities without a
  // narrative_draft are intentionally elided per design Section 2.3.
  assert.match(calls[0]!.text, /FROM activity a/);
  assert.match(calls[0]!.text, /JOIN narrative_draft nd ON nd\.activity_id = a\.id/);
  // Composite-PK aware: narrative_draft's PK is (tenant_id, id), and
  // tenant_id must be carried across the JOIN so a cross-tenant draft
  // (impossible under RLS, but defence-in-depth) cannot leak in.
  assert.match(calls[0]!.text, /AND nd\.tenant_id = a\.tenant_id/);
});

test('walkProposedIdChain selects all six chain columns', async () => {
  const proposedId = randomUUID();
  const { executor, calls } = makeStubExecutor([]);

  await walkProposedIdChain(proposedId, TENANT_A, executor);

  const text = calls[0]!.text;
  assert.match(text, /a\.id AS activity_id/);
  assert.match(text, /a\.fy_label/);
  assert.match(text, /a\.hypothesis_formed_at/);
  assert.match(text, /a\.proposed_id/);
  assert.match(text, /nd\.id AS narrative_draft_id/);
  assert.match(text, /nd\.content_hash/);
});

test('walkProposedIdChain returns empty array when no rows match', async () => {
  const { executor } = makeStubExecutor([]);
  const chain = await walkProposedIdChain(randomUUID(), TENANT_A, executor);
  assert.deepEqual(chain, []);
});

test('walkProposedIdChain only queries one tenant — TENANT_B rows from same proposed_id never bleed in', async () => {
  // Simulates the "tenant_b also has an activity with this proposed_id"
  // race: the executor (real or stub) is contractually bound to filter
  // on the tenantId we passed. Here we verify by inspecting the SQL —
  // the stub doesn't do filtering itself.
  const proposedId = randomUUID();
  const { executor, calls } = makeStubExecutor([]);

  await walkProposedIdChain(proposedId, TENANT_A, executor);

  assert.equal(calls[0]!.values[0], TENANT_A);
  assert.notEqual(calls[0]!.values[0], TENANT_B);
});

test('walkProposedIdChain returns a fresh array (not the executor result reference)', async () => {
  // Defensive: callers should be able to mutate the returned array
  // without poisoning a downstream cache. The walker spreads into a
  // new array.
  const proposedId = randomUUID();
  const sourceRows = [row({ proposed_id: proposedId })];
  const { executor } = makeStubExecutor(sourceRows);

  const chain = await walkProposedIdChain(proposedId, TENANT_A, executor);

  assert.notStrictEqual(chain, sourceRows);
  assert.equal(chain.length, sourceRows.length);
  assert.equal(chain[0]!.proposed_id, proposedId);
});
