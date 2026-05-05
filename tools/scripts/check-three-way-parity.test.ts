import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { privilegedSql } from '@cpa/db/client';
import {
  BENEFICIAL_OWNERSHIP_OWNER_KINDS,
  MULTI_ENTITY_SIMILARITY_KINDS,
  MULTI_ENTITY_REVIEWER_DISPOSITIONS,
  RD_FORECAST_CONFIDENCES,
  REGULATORY_SOURCE_PARSER_KINDS,
  REGULATORY_SOURCE_POLLED_STATUSES,
  REGULATORY_EVENT_KINDS,
  REGULATORY_EVENT_SEVERITIES,
} from '@cpa/db/schema';

/**
 * P7 Theme D — Three-way parity enforcement tests.
 *
 * Verifies that the SQL CHECK constraint values for each enum column match
 * the corresponding TypeScript const arrays in @cpa/db. A future leg will
 * add Zod enum coverage once @cpa/schemas exports these types.
 *
 * DB-gated: skip gracefully when Postgres is unreachable (CI without services).
 */

// DB-gated: skip gracefully when Postgres is unreachable (CI without services).
let dbAvailable = true;
before(async () => {
  try {
    await privilegedSql`SELECT 1`;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await privilegedSql.end();
});

/**
 * Queries pg_constraint for a named CHECK constraint on the given table and
 * extracts the quoted string literals from the constraint definition.
 *
 * Returns the extracted values sorted ascending for stable comparison.
 */
async function getCheckValues(constraintName: string, tableName: string): Promise<string[]> {
  const rows = await privilegedSql<{ pg_get_constraintdef: string }[]>`
    SELECT pg_get_constraintdef(oid) AS pg_get_constraintdef
    FROM pg_constraint
    WHERE conname = ${constraintName}
      AND conrelid = ${tableName}::regclass
  `;
  assert.equal(rows.length, 1, `Expected exactly 1 CHECK constraint named ${constraintName}`);
  // Extract quoted string literals from the CHECK definition
  const matches = rows[0]!.pg_get_constraintdef.match(/'([^']+)'/g) ?? [];
  return matches.map((s) => s.slice(1, -1)).sort();
}

test('three-way parity: beneficial_ownership.owner_kind — SQL CHECK ↔ TS const', async () => {
  if (!dbAvailable) return;
  const sqlValues = await getCheckValues(
    'beneficial_ownership_owner_kind_valid',
    'beneficial_ownership',
  );
  assert.deepEqual(
    sqlValues,
    Array.from(BENEFICIAL_OWNERSHIP_OWNER_KINDS).sort(),
    'SQL ↔ TS const mismatch for BENEFICIAL_OWNERSHIP_OWNER_KINDS',
  );
});

test('three-way parity: multi_entity_similarity_score.similarity_kind — SQL CHECK ↔ TS const', async () => {
  if (!dbAvailable) return;
  const sqlValues = await getCheckValues(
    'multi_entity_similarity_score_kind_valid',
    'multi_entity_similarity_score',
  );
  assert.deepEqual(
    sqlValues,
    Array.from(MULTI_ENTITY_SIMILARITY_KINDS).sort(),
    'SQL ↔ TS const mismatch for MULTI_ENTITY_SIMILARITY_KINDS',
  );
});

test('three-way parity: multi_entity_similarity_score.reviewer_disposition — SQL CHECK ↔ TS const', async () => {
  if (!dbAvailable) return;
  const sqlValues = await getCheckValues(
    'multi_entity_similarity_score_disposition_valid',
    'multi_entity_similarity_score',
  );
  assert.deepEqual(
    sqlValues,
    Array.from(MULTI_ENTITY_REVIEWER_DISPOSITIONS).sort(),
    'SQL ↔ TS const mismatch for MULTI_ENTITY_REVIEWER_DISPOSITIONS',
  );
});

test('three-way parity: rd_forecast.confidence — SQL CHECK ↔ TS const', async () => {
  if (!dbAvailable) return;
  const sqlValues = await getCheckValues('rd_forecast_confidence_valid', 'rd_forecast');
  assert.deepEqual(
    sqlValues,
    Array.from(RD_FORECAST_CONFIDENCES).sort(),
    'SQL ↔ TS const mismatch for RD_FORECAST_CONFIDENCES',
  );
});

// ---------------------------------------------------------------------------
// D.8 RIF enums
// ---------------------------------------------------------------------------

test('three-way parity: regulatory_source.parser_kind — SQL CHECK ↔ TS const', async () => {
  if (!dbAvailable) return;
  const sqlValues = await getCheckValues(
    'regulatory_source_parser_kind_valid',
    'regulatory_source',
  );
  assert.deepEqual(
    sqlValues,
    Array.from(REGULATORY_SOURCE_PARSER_KINDS).sort(),
    'SQL ↔ TS const mismatch for REGULATORY_SOURCE_PARSER_KINDS',
  );
});

test('three-way parity: regulatory_source.last_polled_status — SQL CHECK ↔ TS const', async () => {
  if (!dbAvailable) return;
  const sqlValues = await getCheckValues(
    'regulatory_source_last_polled_status_valid',
    'regulatory_source',
  );
  assert.deepEqual(
    sqlValues,
    Array.from(REGULATORY_SOURCE_POLLED_STATUSES).sort(),
    'SQL ↔ TS const mismatch for REGULATORY_SOURCE_POLLED_STATUSES',
  );
});

test('three-way parity: regulatory_event.classification_kind — SQL CHECK ↔ TS const', async () => {
  if (!dbAvailable) return;
  const sqlValues = await getCheckValues(
    'regulatory_event_classification_kind_valid',
    'regulatory_event',
  );
  assert.deepEqual(
    sqlValues,
    Array.from(REGULATORY_EVENT_KINDS).sort(),
    'SQL ↔ TS const mismatch for REGULATORY_EVENT_KINDS',
  );
});

test('three-way parity: regulatory_event.classification_severity — SQL CHECK ↔ TS const', async () => {
  if (!dbAvailable) return;
  const sqlValues = await getCheckValues(
    'regulatory_event_classification_severity_valid',
    'regulatory_event',
  );
  assert.deepEqual(
    sqlValues,
    Array.from(REGULATORY_EVENT_SEVERITIES).sort(),
    'SQL ↔ TS const mismatch for REGULATORY_EVENT_SEVERITIES',
  );
});
