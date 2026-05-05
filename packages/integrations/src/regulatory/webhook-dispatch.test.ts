import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { privilegedSql, sql } from '@cpa/db/client';
import type { RegulatoryClassificationType } from '@cpa/agents/regulatory-classifier';
import { dispatchClassifiedEvent } from './webhook-dispatch.js';

/**
 * D.11 — Webhook dispatch tests.
 *
 * DB-gated: skip gracefully when Postgres is unreachable.
 * UUID segment: d110 — isolates from other suites.
 */

const TENANT_D11 = '00000000-0000-4000-8000-0000d1100001';
const USER_D11 = '00000000-0000-4000-8000-0000d1100002';
const EVENT_D11 = '00000000-0000-4000-8000-0000d1100003';

let dbAvailable = false;

const cleanup = async (): Promise<void> => {
  try {
    await privilegedSql`DELETE FROM prompt_suggestion WHERE tenant_id = ${TENANT_D11}`;
    await privilegedSql`DELETE FROM tenant_user WHERE tenant_id = ${TENANT_D11}`;
    await sql`DELETE FROM "user" WHERE id = ${USER_D11}`;
    await sql`DELETE FROM tenant WHERE id = ${TENANT_D11}`;
  } catch {
    // ignore
  }
};

before(async () => {
  try {
    await privilegedSql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await cleanup();
  // Seed tenant + user for FK satisfaction
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_D11}, 'Dispatch Test', 'dispatch-test', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
            VALUES (${USER_D11}, 'dispatch@example.com', 'microsoft', 'microsoft:dispatch', 'Dispatcher')`;
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (gen_random_uuid(), ${TENANT_D11}, ${USER_D11}, 'consultant', true)`;
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

const skipIfNoDb = (t: { skip: (msg?: string) => void }): boolean => {
  if (!dbAvailable) {
    t.skip('Postgres not reachable — DB-gated test skipped');
    return true;
  }
  return false;
};

const makeClassification = (
  overrides: Partial<RegulatoryClassificationType> = {},
): RegulatoryClassificationType => ({
  event_id: EVENT_D11,
  classification_kind: 'tax_alert',
  severity: 'high',
  affects_prompt_modules: ['draft-narrative@1.1.0'],
  affects_compliance_fields: [],
  precedent_strength: 'informational',
  retroactive: false,
  summary:
    'ATO issues guidance on R&D expenditure categorisation affecting forecast requirements for current and future fiscal years.',
  prompt_version: '1.0.0',
  model: 'claude-sonnet-4-5-20250514',
  ...overrides,
});

describe('dispatchClassifiedEvent', () => {
  test('inserts prompt_suggestion for high-severity event with affected modules', async (t) => {
    if (skipIfNoDb(t)) return;
    const classification = makeClassification();
    const result = await dispatchClassifiedEvent({
      eventId: EVENT_D11,
      tenantId: TENANT_D11,
      flaggedByUserId: USER_D11,
      classification,
    });
    assert.equal(result.suggestions_inserted, 1);
    assert.equal(result.corpus_refresh_signalled, false);

    // Verify row exists
    const rows = await privilegedSql`
      SELECT source_kind, issue_summary FROM prompt_suggestion
      WHERE tenant_id = ${TENANT_D11}
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.source_kind, 'rif_event');

    // Cleanup for next test
    await privilegedSql`DELETE FROM prompt_suggestion WHERE tenant_id = ${TENANT_D11}`;
  });

  test('skips suggestion for low-severity events', async (t) => {
    if (skipIfNoDb(t)) return;
    const classification = makeClassification({ severity: 'low' });
    const result = await dispatchClassifiedEvent({
      eventId: EVENT_D11,
      tenantId: TENANT_D11,
      flaggedByUserId: USER_D11,
      classification,
    });
    assert.equal(result.suggestions_inserted, 0);
  });

  test('signals corpus refresh for aat_decision', async (t) => {
    if (skipIfNoDb(t)) return;
    const classification = makeClassification({
      classification_kind: 'aat_decision',
      severity: 'medium',
      precedent_strength: 'persuasive',
    });
    const result = await dispatchClassifiedEvent({
      eventId: EVENT_D11,
      tenantId: TENANT_D11,
      flaggedByUserId: USER_D11,
      classification,
    });
    assert.equal(result.corpus_refresh_signalled, true);
    assert.equal(result.suggestions_inserted, 1);

    await privilegedSql`DELETE FROM prompt_suggestion WHERE tenant_id = ${TENANT_D11}`;
  });

  test('inserts schema_change suggestion for compliance field changes', async (t) => {
    if (skipIfNoDb(t)) return;
    const classification = makeClassification({
      affects_compliance_fields: [
        'beneficial_ownership.is_foreign_related',
        'rd_forecast.projected_spend_aud',
      ],
    });
    const result = await dispatchClassifiedEvent({
      eventId: EVENT_D11,
      tenantId: TENANT_D11,
      flaggedByUserId: USER_D11,
      classification,
    });
    // 1 for the prompt module + 1 for the compliance fields
    assert.equal(result.suggestions_inserted, 2);

    const rows = await privilegedSql<{ triage_classification: string | null }[]>`
      SELECT triage_classification FROM prompt_suggestion
      WHERE tenant_id = ${TENANT_D11}
      ORDER BY triage_classification ASC NULLS FIRST
    `;
    assert.equal(rows.length, 2);
    // One null (the prompt module suggestion) and one 'schema_change'
    assert.equal(rows[0]!.triage_classification, null);
    assert.equal(rows[1]!.triage_classification, 'schema_change');

    await privilegedSql`DELETE FROM prompt_suggestion WHERE tenant_id = ${TENANT_D11}`;
  });

  test('skips suggestion when no affected prompt modules', async (t) => {
    if (skipIfNoDb(t)) return;
    const classification = makeClassification({
      affects_prompt_modules: [],
      affects_compliance_fields: [],
    });
    const result = await dispatchClassifiedEvent({
      eventId: EVENT_D11,
      tenantId: TENANT_D11,
      flaggedByUserId: USER_D11,
      classification,
    });
    assert.equal(result.suggestions_inserted, 0);
  });
});
