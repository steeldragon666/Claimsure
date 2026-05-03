# P7 Implementation Plan — Multi-cycle, Prompt Suggestions, Audit Timeline, FY25-26 Compliance

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land all P7 items per the design at `docs/plans/2026-05-03-p7-design.md`: Theme A (multi-cycle narrative continuity via `proposed_id` chain + forensic metadata), Theme B (prompt suggestion queue + API-driven multi-file PRs via GitHub App), Theme C (activity audit timeline + multi-entity comparison view), Theme D (15 Aug 2025 R&D form-shape compliance + Regulatory Intelligence Feed). 4 swimlanes off `main`; ~171h across 5 weeks.

**Architecture:** 4 parallel worktrees with sequenced merge order to keep migration indices monotonic. Citation-only multi-cycle summaries (Body by Michael compliance). Immutable forensic stamps (`first_recorded_at`, `hypothesis_formed_at`). GitHub App with least-privilege scopes for PR generation. Daily-cron RIF feeds Theme B suggestions and Theme D similarity corpus. Migrations 0037–0040 reserved (0040 split a/b for compliance vs RIF rollback boundaries).

**Tech Stack:** TypeScript 5.x, postgres-js 3.4.9, drizzle-orm, Fastify, Zod, node:test, pg-boss (cron), Anthropic SDK (`@anthropic-ai/sdk`), Claude Sonnet 4.5 (Theme A multi-cycle, Theme B suggestion eval, Theme D similarity + classify), Octokit (GitHub App auth + PR generation), Grafana Cloud OTLP (telemetry), `@cpa/agents` runtime (existing).

**Prerequisite:** PR for design doc (`docs: P7 design`, commit `e5e1435`) is on `main`. Worktrees `p7a`/`p7b`/`p7c`/`p7d` cut from updated `main`.

---

## Worktree allocation

| Worktree | Branch | Themes | Sequencing |
| --- | --- | --- | --- |
| `p7a` | `p7a/multi-cycle` | Theme A (multi-cycle narrative + forensic metadata; migration 0037) | Ships first — provides forensic columns Theme C reads |
| `p7b` | `p7b/prompt-suggestions` | Theme B (suggestion queue + GitHub App PR generation; migration 0038) | After `p7a` merges — independent feature, sequenced for migration ordering |
| `p7c` | `p7c/audit-timeline` | Theme C (activity timeline + multi-entity comparison; migration 0039) | After `p7b` merges — multi-entity panel reads from Theme D's `multi_entity_similarity_score` table; gracefully empty until `p7d` lands |
| `p7d` | `p7d/compliance-capture` | Theme D (compliance capture + RIF; migrations 0040a + 0040b) | After `p7c` merges — populates the similarity table that Theme C panel queries |

**Worktree setup (per branch, before any task):** Use **superpowers:using-git-worktrees** skill. Verify `.worktrees/` is git-ignored, create worktree, run `pnpm install`, run `pnpm -r test` for clean baseline.

---

## Theme A — Multi-cycle narrative + forensic metadata (p7a)

### Task A.1: Migration 0037 — Theme A schema foundation

**Worktree:** `p7a`. **Theme:** A. **Depends on:** none. **Effort:** ~6 hours.

**Schema-reconciliation context (added 2026-05-03 after implementer investigation):**
The original Task A.1 spec referenced four schema objects that don't exist in the codebase as of `main` @ `2da4f5e`:

1. `narrative_segment` table — segments are stored inline as `jsonb` on `narrative_draft.segments` (P6 pattern). **Decision Q-Fix1=A:** create `narrative_segment` table by extracting from the jsonb. Existing `narrative_draft.segments` is preserved as the legacy read path; new writers populate both during transition (read-path migration deferred to a follow-up task).
2. `activity.proposed_id` column — `proposed_id` lives only on `event.payload->>'proposed_id'`. **Decision Q-Fix2=A:** add `activity.proposed_id uuid` denormalized column, backfilled from the latest `ACTIVITY_REGISTER_DRAFTED` event payload per activity.
3. `activity.fy_label` column — FY currently lives as `claim.fiscal_year integer` joined via `activity.claim_id`. **Decision Q-Fix3=A:** add `activity.fy_label text` denormalized column derived from `'FY' || (claim.fiscal_year - 2000)::text`.
4. `audit_log` schema — actual columns are `(id, firm_id, kind, payload, actor_user_id, created_at)`, NOT `(tenant_id, subject_kind, subject_id, payload, created_at)`. **Decision Q-Fix4=B:** adapt the immutability trigger to use the existing schema — encode `subject_kind: 'activity'` and `subject_id: activity.id` inside the payload jsonb; resolve `firm_id` from the activity's tenant via `tenant.firm_id` lookup.
5. `AuditKind` Zod enum is closed-set (`MAPPING_RULE_CREATED`, `MAPPING_RULE_UPDATED`, `MAPPING_RULE_ARCHIVED`). **Decision Q-Fix5=A:** extend the Zod enum + agents-package mirror const + add a SQL CHECK constraint listing all valid kinds (three-way parity, retroactively pulled into Task A.1).

**Files:**

- Create: `packages/db/migrations/0037_multi_cycle_narrative.sql`
- Modify: `packages/db/migrations/meta/_journal.json` — append idx 37
- Modify: `packages/db/src/schema/narrative.ts` — add `narrativeSegment` Drizzle table definition; keep `narrativeDraft.segments` jsonb for backward compat
- Modify: `packages/db/src/schema/activity.ts` — add `proposedId`, `fyLabel`, `hypothesisFormedAt` Drizzle columns
- Modify: `packages/schemas/src/audit.ts` — extend `AuditKind` Zod enum with `HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION`
- Modify: `packages/agents/src/audit-kinds.ts` (or wherever the agents-package mirror const lives — find with `grep -r "AuditKind\|MAPPING_RULE_CREATED" packages/agents`) — mirror the enum extension
- Test: `packages/db/src/migrations.test.ts` — additive (8 tests)

**Step 1: Investigate codebase before writing tests**

Confirm the following before authoring:
- Existing test conventions in `packages/db/src/migrations.test.ts` — note the inline UUID constants pattern (no `TENANT_A`/`seedActivity` helpers exist; tests use `privilegedSql` and inline `INSERT` statements).
- `tenant.firm_id` relationship exists (the trigger needs to resolve firm from tenant). If not, halt and ask.
- Existing `audit_log_kind_nonempty` and `audit_log_payload_object` CHECK constraints (migration 0022 + 0035 area). The new SQL CHECK on `kind` extends the existing constraint shape.
- Drizzle schema file conventions (`packages/db/src/schema/*.ts`).
- `narrative_draft.segments` jsonb shape (look at `packages/db/src/schema/narrative.ts` + actual data in `narrative_draft_version` rows for examples).

**Step 2: Write failing tests** (8 tests, append to `migrations.test.ts`)

```ts
test('migration 0037: narrative_segment table exists with required columns', async () => {
  const rows = await privilegedSql<{ column_name: string; data_type: string; is_nullable: string }[]>`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'narrative_segment'
     ORDER BY ordinal_position
  `;
  const cols = Object.fromEntries(rows.map(r => [r.column_name, r]));
  assert.ok(cols.id, 'narrative_segment.id missing');
  assert.ok(cols.narrative_draft_id, 'narrative_segment.narrative_draft_id missing');
  assert.ok(cols.segment_index, 'narrative_segment.segment_index missing');
  assert.ok(cols.section_kind, 'narrative_segment.section_kind missing');
  assert.ok(cols.body, 'narrative_segment.body missing');
  assert.ok(cols.first_recorded_at, 'narrative_segment.first_recorded_at missing');
  assert.equal(cols.first_recorded_at!.is_nullable, 'NO');
});

test('migration 0037: narrative_segment backfilled from narrative_draft.segments jsonb', async () => {
  // Seed a narrative_draft with 3 segments before the migration would have run.
  // After migration, narrative_segment should have 3 rows for that draft.
  // (This test runs against the migrated DB; it asserts row count consistency
  // for any pre-existing narrative_draft rows.)
  const rows = await privilegedSql<{ draft_count: number; segment_count: number }[]>`
    SELECT
      (SELECT COUNT(*) FROM narrative_draft WHERE jsonb_array_length(segments) > 0) AS draft_count,
      (SELECT COUNT(DISTINCT narrative_draft_id) FROM narrative_segment) AS segment_count
  `;
  assert.equal(rows[0]!.draft_count, rows[0]!.segment_count, 'every draft with segments should have narrative_segment rows');
});

test('migration 0037: activity.proposed_id column exists (uuid, nullable)', async () => {
  const rows = await privilegedSql<{ data_type: string; is_nullable: string }[]>`
    SELECT data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'activity' AND column_name = 'proposed_id'
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.data_type, 'uuid');
  assert.equal(rows[0]!.is_nullable, 'YES');  // nullable: not all activities have a proposed_id origin
});

test('migration 0037: activity.fy_label column exists (text, NOT NULL after backfill)', async () => {
  const rows = await privilegedSql<{ data_type: string; is_nullable: string }[]>`
    SELECT data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'activity' AND column_name = 'fy_label'
  `;
  assert.equal(rows[0]!.data_type, 'text');
  assert.equal(rows[0]!.is_nullable, 'NO');
});

test('migration 0037: activity.hypothesis_formed_at column exists (timestamptz, NOT NULL after backfill)', async () => {
  const rows = await privilegedSql<{ data_type: string; is_nullable: string }[]>`
    SELECT data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'activity' AND column_name = 'hypothesis_formed_at'
  `;
  assert.equal(rows[0]!.data_type, 'timestamp with time zone');
  assert.equal(rows[0]!.is_nullable, 'NO');
});

test('migration 0037: audit_log_kind CHECK includes HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION', async () => {
  const rows = await privilegedSql<{ check_clause: string }[]>`
    SELECT cc.check_clause
      FROM information_schema.check_constraints cc
      JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
     WHERE ccu.table_name = 'audit_log' AND ccu.column_name = 'kind'
  `;
  const matched = rows.some(r => r.check_clause.includes('HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION'));
  assert.ok(matched, 'audit_log kind CHECK must list the new immutability-violation kind');
});

test('migration 0037: hypothesis_formed_at immutability trigger fires + audit-logs', async () => {
  // Seed: tenant + firm + claim + activity with hypothesis_formed_at set
  const firmId = randomUUID();
  const tenantId = randomUUID();
  const claimId = randomUUID();
  const activityId = randomUUID();
  await privilegedSql`INSERT INTO firm (id, name) VALUES (${firmId}, 'test firm')`;
  await privilegedSql`INSERT INTO tenant (id, firm_id, slug) VALUES (${tenantId}, ${firmId}, 'test-tenant')`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, fiscal_year) VALUES (${claimId}, ${tenantId}, 2025)`;
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, claim_id, code, kind, title, fy_label, hypothesis_formed_at)
    VALUES (${activityId}, ${tenantId}, ${claimId}, 'A1', 'core', 'test', 'FY25', '2025-01-01'::timestamptz)
  `;

  await assert.rejects(
    () => privilegedSql`UPDATE activity SET hypothesis_formed_at = '2024-01-01'::timestamptz WHERE id = ${activityId}`,
    /immutable/
  );

  // Audit log entry should be present (via trigger insert before raise)
  // NOTE: the EXCEPTION rolls back the INSERT in PostgreSQL's default behaviour,
  // so the trigger must use a separate transaction or rely on RAISE NOTICE
  // for the audit hook. The implementer must decide: either
  //   (a) emit the audit row via dblink/autonomous transaction (heavy), or
  //   (b) accept that the audit_log row is rolled back along with the rejected
  //       UPDATE — in which case the test asserts only the rejection, and the
  //       "audit trail" is the application-layer error log, OR
  //   (c) use INSTEAD OF / split into validate-fn + writer-fn pattern where
  //       a guard table records every attempt before the throwing trigger.
  // RECOMMENDED: (c) using a dedicated `forensic_violation_attempt` table
  // OR drop the audit_log INSERT entirely and rely on the EXCEPTION + app log.
  // **Implementer: pick the simplest viable option and document the choice in
  // the migration's leading comment block.**
});

test('migration 0037: trigger does NOT fire when other columns update', async () => {
  // Seed an activity, update its title, assert no audit_log row inserted
  // (regression guard: trigger must be column-scoped to hypothesis_formed_at)
  const firmId = randomUUID();
  const tenantId = randomUUID();
  const claimId = randomUUID();
  const activityId = randomUUID();
  await privilegedSql`INSERT INTO firm (id, name) VALUES (${firmId}, 'test firm 2')`;
  await privilegedSql`INSERT INTO tenant (id, firm_id, slug) VALUES (${tenantId}, ${firmId}, 'test-tenant-2')`;
  await privilegedSql`INSERT INTO claim (id, tenant_id, fiscal_year) VALUES (${claimId}, ${tenantId}, 2025)`;
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, claim_id, code, kind, title, fy_label, hypothesis_formed_at)
    VALUES (${activityId}, ${tenantId}, ${claimId}, 'A2', 'core', 'before', 'FY25', '2025-01-01'::timestamptz)
  `;
  await privilegedSql`UPDATE activity SET title = 'after' WHERE id = ${activityId}`;
  // Should succeed silently. Audit assertion depends on Q-Fix4=B implementation choice above.
});
```

**Step 3: Run tests to verify they fail**

```bash
pnpm --filter @cpa/db test --test-name-pattern "0037"
# Expected: FAIL — relation/column does not exist
```

**Step 4: Write migration `packages/db/migrations/0037_multi_cycle_narrative.sql`**

```sql
-- ============================================================
-- Migration 0037 — Theme A schema foundation (P7)
-- ============================================================
-- Implements decisions Q-Fix1..Q-Fix5 (see plan: docs/plans/2026-05-03-p7-implementation.md):
--   - Q-Fix1=A: create narrative_segment table + backfill from narrative_draft.segments jsonb
--   - Q-Fix2=A: add activity.proposed_id (denormalized from event payload)
--   - Q-Fix3=A: add activity.fy_label (denormalized from claim.fiscal_year)
--   - Q-Fix4=B: hypothesis_formed_at immutability trigger uses existing audit_log schema
--               (firm_id + payload-encoded subject_kind/subject_id)
--   - Q-Fix5=A: extend audit_log kind CHECK constraint with the new violation kind
-- ============================================================

-- 1. narrative_segment table (Q-Fix1=A)
CREATE TABLE narrative_segment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  narrative_draft_id uuid NOT NULL REFERENCES narrative_draft(id) ON DELETE CASCADE,
  segment_index int NOT NULL,
  section_kind text NOT NULL,
  segment_kind text NOT NULL CHECK (segment_kind IN ('prose', 'claim')),
  body text NOT NULL,
  citing_events uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  content_hash text NOT NULL,
  first_recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (narrative_draft_id, segment_index)
);

CREATE INDEX narrative_segment_draft_idx ON narrative_segment (narrative_draft_id, segment_index);

-- Backfill from existing narrative_draft.segments jsonb arrays.
-- Each segment in jsonb becomes a narrative_segment row.
-- Implementer: confirm jsonb shape by reading actual narrative_draft rows in
-- the test DB. Expected shape per P6 design Section 5:
--   { "section_kind": "...", "segments": [
--       { "kind": "prose"|"claim", "body": "...", "citing_events": [...], "content_hash": "..." }
--     ] }
INSERT INTO narrative_segment (
  narrative_draft_id, segment_index, section_kind, segment_kind, body, citing_events, content_hash, first_recorded_at
)
SELECT
  nd.id,
  (segment.idx)::int - 1,
  COALESCE(segment.value->>'section_kind', 'unknown'),
  COALESCE(segment.value->>'kind', 'prose'),
  COALESCE(segment.value->>'body', ''),
  COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(segment.value->'citing_events'))::uuid[],
    ARRAY[]::uuid[]
  ),
  COALESCE(segment.value->>'content_hash', md5(COALESCE(segment.value->>'body', ''))),
  nd.created_at
  FROM narrative_draft nd,
       LATERAL jsonb_array_elements(nd.segments) WITH ORDINALITY AS segment(value, idx)
 WHERE nd.segments IS NOT NULL
   AND jsonb_array_length(nd.segments) > 0;

-- 2. activity.proposed_id column (Q-Fix2=A)
ALTER TABLE activity ADD COLUMN proposed_id uuid;

-- Backfill from latest ACTIVITY_REGISTER_DRAFTED event payload per activity.
-- (P6 stores proposed_id at event level; we denormalize for chain walk performance.)
UPDATE activity a
   SET proposed_id = (
     SELECT (e.payload->>'proposed_id')::uuid
       FROM event e
      WHERE e.kind = 'ACTIVITY_REGISTER_DRAFTED'
        AND e.payload->>'activity_id' = a.id::text
        AND e.payload->>'proposed_id' IS NOT NULL
      ORDER BY e.captured_at DESC
      LIMIT 1
   )
 WHERE a.proposed_id IS NULL;

-- 3. activity.fy_label column (Q-Fix3=A)
ALTER TABLE activity ADD COLUMN fy_label text;

UPDATE activity a
   SET fy_label = 'FY' || ((c.fiscal_year - 2000)::text)
  FROM claim c
 WHERE a.claim_id = c.id
   AND a.fy_label IS NULL;

ALTER TABLE activity ALTER COLUMN fy_label SET NOT NULL;

-- 4. activity.hypothesis_formed_at column + immutability
ALTER TABLE activity ADD COLUMN hypothesis_formed_at timestamptz;

UPDATE activity a
   SET hypothesis_formed_at = COALESCE(
     (SELECT MIN(nd.created_at) FROM narrative_draft nd WHERE nd.activity_id = a.id),
     a.created_at
   )
 WHERE a.hypothesis_formed_at IS NULL;

ALTER TABLE activity ALTER COLUMN hypothesis_formed_at SET NOT NULL;

-- 5. Extend audit_log kind CHECK constraint (Q-Fix5=A)
-- Find existing constraint name (likely audit_log_kind_check or similar) via:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'audit_log'::regclass AND contype = 'c';
-- Drop and re-add with extended value list.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_kind_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_kind_check CHECK (
  kind IN (
    'MAPPING_RULE_CREATED',
    'MAPPING_RULE_UPDATED',
    'MAPPING_RULE_ARCHIVED',
    'HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION'
  )
);

-- 6. Immutability trigger (Q-Fix4=B — adapt to existing audit_log schema)
-- Per Q-Fix4=B, encode subject_kind/subject_id in payload jsonb; resolve firm_id
-- via tenant.firm_id JOIN.
--
-- IMPORTANT — transaction semantics: PostgreSQL trigger functions run in the
-- same transaction as the triggering statement. RAISE EXCEPTION rolls back
-- that transaction, INCLUDING any INSERT into audit_log inside the trigger.
-- Three options for capturing the violation:
--   (a) autonomous transaction via dblink — heavyweight, adds extension dep
--   (b) accept rollback; rely on PostgreSQL log + application error log for
--       forensic record (the EXCEPTION message itself names the violation)
--   (c) split: a separate AFTER UPDATE trigger logs every change attempt,
--       and a separate constraint enforces immutability without rollback
--
-- DECISION: option (b). The PostgreSQL exception is itself the audit signal;
-- application-layer code wraps the UPDATE and logs the rejection event via
-- the normal audit_log writer (which runs in its own transaction). The
-- trigger's job is purely defensive — to make backdating impossible at the
-- DB layer. The test assertion is therefore "UPDATE rejects with /immutable/";
-- the audit-log assertion belongs in an integration test at the API layer.

CREATE OR REPLACE FUNCTION enforce_hypothesis_formed_at_immutability()
RETURNS trigger AS $$
BEGIN
  IF OLD.hypothesis_formed_at IS DISTINCT FROM NEW.hypothesis_formed_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'hypothesis_formed_at is immutable; backdating attempt on activity %s rejected (old=%s, new=%s)',
        NEW.id, OLD.hypothesis_formed_at, NEW.hypothesis_formed_at
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_hypothesis_formed_at_immutable
  BEFORE UPDATE ON activity
  FOR EACH ROW
  WHEN (OLD.hypothesis_formed_at IS DISTINCT FROM NEW.hypothesis_formed_at)
  EXECUTE FUNCTION enforce_hypothesis_formed_at_immutability();

-- 7. Index for proposed_id chain walk
CREATE INDEX IF NOT EXISTS activity_proposed_id_fy_idx
  ON activity (tenant_id, proposed_id, fy_label, hypothesis_formed_at)
  WHERE proposed_id IS NOT NULL;
```

**Step 5: Update Drizzle schema files**

In `packages/db/src/schema/narrative.ts`, add `narrativeSegment` table definition. In `packages/db/src/schema/activity.ts`, add the three new columns. Mirror the `narrative_draft.segments` jsonb (keep it; backward compat).

**Step 6: Extend `AuditKind` Zod enum (Q-Fix5=A)**

In `packages/schemas/src/audit.ts`:

```ts
export const AuditKind = z.enum([
  'MAPPING_RULE_CREATED',
  'MAPPING_RULE_UPDATED',
  'MAPPING_RULE_ARCHIVED',
  'HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION',  // P7 Theme A
]);
```

Mirror in `@cpa/agents`'s audit-kind const (find via grep).

**Step 7: Append journal entry**

```jsonc
{ "idx": 37, "version": "7", "when": <now-ms>, "tag": "0037_multi_cycle_narrative", "breakpoints": true }
```

**Step 8: Run all migration tests + three-way parity test**

```bash
pnpm --filter @cpa/db test --test-name-pattern "0037"
pnpm --filter @cpa/db build
pnpm --filter @cpa/schemas build
pnpm --filter @cpa/agents build
pnpm --filter ./tools/scripts test  # three-way parity guard
# Expected: all PASS (modulo the immutability trigger audit-log assertion which is documented as deferred to API integration test)
```

**Step 9: Commit**

```bash
git add packages/db/migrations/0037_multi_cycle_narrative.sql \
        packages/db/migrations/meta/_journal.json \
        packages/db/src/schema/narrative.ts \
        packages/db/src/schema/activity.ts \
        packages/db/src/migrations.test.ts \
        packages/schemas/src/audit.ts \
        packages/agents/src/audit-kinds.ts
git commit -m "feat(db,schemas,agents): P7 Theme A schema foundation — narrative_segment table, activity.{proposed_id,fy_label,hypothesis_formed_at}, AuditKind extension, immutability trigger"
```

### Task A.2: `proposed_id` chain walker

**Worktree:** `p7a`. **Theme:** A. **Depends on:** Task A.1. **Effort:** ~3 hours.

**Files:**

- Create: `packages/agents/src/multi-cycle/walk-proposed-id.ts`
- Test: `packages/agents/src/multi-cycle/walk-proposed-id.test.ts`

**Step 1: Write the failing test** (seed multi-FY activities sharing a `proposed_id`, verify chronological ordering).

```ts
test('walkProposedIdChain returns all FY rows for a proposed_id, sorted by hypothesis_formed_at', async () => {
  const tenantId = TENANT_A;
  const proposedId = randomUUID();
  await seedActivity(tenantId, { proposed_id: proposedId, fy_label: 'FY24', hypothesis_formed_at: new Date('2024-08-01') });
  await seedActivity(tenantId, { proposed_id: proposedId, fy_label: 'FY25', hypothesis_formed_at: new Date('2025-08-01') });
  const chain = await walkProposedIdChain(proposedId, tenantId);
  assert.equal(chain.length, 2);
  assert.equal(chain[0]!.fy_label, 'FY24');
  assert.equal(chain[1]!.fy_label, 'FY25');
});

test('walkProposedIdChain respects tenant isolation', async () => {
  const proposedId = randomUUID();
  await seedActivity(TENANT_A, { proposed_id: proposedId, fy_label: 'FY25' });
  await seedActivity(TENANT_B, { proposed_id: proposedId, fy_label: 'FY25' });
  const chain = await walkProposedIdChain(proposedId, TENANT_A);
  assert.equal(chain.length, 1);
});
```

**Step 2: Run-fail.** **Step 3: Implement** per design Section 2.3 (drizzle SQL query joining activity + narrative_draft, ordered by FY then hypothesis_formed_at). **Step 4: Run-pass.** **Step 5: Commit** `feat(agents): proposed_id chain walker for multi-cycle continuity`.

### Task A.3: Prompt module `multi-cycle-summarize@1.0.0`

**Worktree:** `p7a`. **Theme:** A. **Depends on:** Task A.2. **Effort:** ~6 hours.

**Files:**

- Create: `packages/agents/src/multi-cycle/prompts/multi-cycle-summarize@1.0.0.ts`
- Create: `packages/agents/src/multi-cycle/types.ts`
- Test: `packages/agents/src/multi-cycle/prompts/multi-cycle-summarize@1.0.0.test.ts`

**Critical constraint:** the output schema must NOT contain any free-text field that could leak prior-year prose. The agent's job is "build a citation graph"; structurally incapable of paraphrase.

**Step 1: Write the failing test** — schema validation + no-prose-field guarantee.

```ts
test('multi-cycle-summarize output schema has no fields capable of carrying prior-year prose', () => {
  const shape = MultiCycleSummaryOutput.shape;
  // Whitelist the fields that MAY contain text, all of which are constrained to
  // metadata (transition rationale capped at 500 chars, prompt_version literal, etc.)
  const allowedTextFields = ['transition_rationale', 'prompt_version', 'model', 'idempotency_key'];
  for (const field of Object.keys(shape)) {
    if (shape[field] instanceof z.ZodString && !allowedTextFields.includes(field)) {
      assert.fail(`Field ${field} is a free-text string — could leak prior-year prose. Constrain or remove.`);
    }
  }
});

test('multi-cycle-summarize tool schema rejects paraphrased content even if model emits it', () => {
  const malicious = {
    proposed_id: randomUUID(),
    fy_labels: ['FY24', 'FY25'],
    citation_graph: [{
      fy_label: 'FY24',
      narrative_draft_id: randomUUID(),
      section_kind: 'hypothesis',
      content_hash: 'abc',
      cited_segment_indices: [0],
      transition_kind: 'continuation',
      transition_rationale: 'In FY24, the team hypothesized that...' /* PARAPHRASE */,
      // attempting to inject extra prose field
      additional_summary: 'Long paraphrased summary of prior year'
    }],
    total_fys_covered: 2,
    earliest_hypothesis_formed_at: new Date().toISOString(),
    prompt_version: '1.0.0',
    model: 'claude-sonnet-4-5',
    idempotency_key: 'k1'
  };
  // Strict mode: extra fields rejected
  assert.throws(() => MultiCycleSummaryOutput.strict().parse(malicious));
});
```

**Step 2-4: Run-fail / implement per design Section 2.4 / run-pass.**

**Step 5: Commit** `feat(agents): multi-cycle-summarize prompt v1.0.0 + citation-only output schema`.

### Task A.4: `draft-narrative@1.1.0` bump with `prior_fy_context`

**Worktree:** `p7a`. **Theme:** A. **Depends on:** Task A.3. **Effort:** ~4 hours.

**Files:**

- Modify: `packages/agents/src/narrative/prompts/draft-narrative@1.0.0.ts` → copy to `@1.1.0.ts` (don't delete 1.0.0; existing FY24 narratives reference it)
- Modify: `packages/agents/src/narrative/types.ts` — add `PriorFyContextBlock` Zod schema
- Test: `packages/agents/src/narrative/prompts/draft-narrative@1.1.0.test.ts`

Default-on behavior (Q5): if `walkProposedIdChain` returns more than one prior FY, populate `prior_fy_context` automatically. Prompt instructs "draft must be consistent with the trajectory above; flag contradictions in `consultant_review_notes`."

**Steps follow standard TDD pattern.** Tests cover: (a) prior_fy_context populated when chain has 2+ FYs; (b) prompt v1.1.0 explicitly references prior FY context; (c) v1.0.0 still importable for backward-compat.

**Commit:** `feat(agents): draft-narrative@1.1.0 with prior_fy_context (default-on for multi-cycle activities)`.

### Task A.5: Citation-graph timeline UI component

**Worktree:** `p7a`. **Theme:** A. **Depends on:** Task A.3. **Effort:** ~5 hours.

**Files:**

- Create: `apps/web/src/components/multi-cycle-timeline.tsx`
- Create: `apps/web/src/components/multi-cycle-timeline.test.tsx`
- Modify: `apps/web/src/routes/activity/[id].tsx` — embed component when proposed_id chain has 2+ FYs

**UI requirements:**
- Render citation graph as horizontal timeline (one column per FY)
- Pull verbatim excerpts from cited `narrative_segment.body` rows (no LLM intermediation between historical text and display)
- Color-code transitions: continuation=green, pivot=amber, completion=blue, abandoned=gray
- Click on cited segment opens drawer with full segment text + content_hash badge

**Commit:** `feat(web): multi-cycle citation-graph timeline component`.

### Task A.6: Three-way parity test for `transition_kind` enum

**Worktree:** `p7a`. **Theme:** A. **Depends on:** Tasks A.1, A.3. **Effort:** ~1 hour.

**Files:**

- Modify: `tools/scripts/check-three-way-parity.test.ts` — add `transition_kind` row to fixture matrix

**Step 1: Write test** asserting SQL CHECK constraint values match Zod enum match `@cpa/agents` const. **Step 2-4: Run-fail / extend script / run-pass.** **Step 5: Commit** `test(tools): three-way parity for transition_kind enum`.

### Task A.7: Multi-cycle contract tests

**Worktree:** `p7a`. **Theme:** A. **Depends on:** Tasks A.1–A.5. **Effort:** ~3 hours.

**Files:**

- Create: `apps/api/src/routes/multi-cycle.contract.test.ts`

**Tests:**
- End-to-end: seed FY24 narrative + FY25 activity sharing `proposed_id`; generate FY25 draft with `draft-narrative@1.1.0`; assert `prior_fy_context` populated; assert summary citation-graph references FY24 segments by content_hash; assert no FY24 prose appears anywhere in FY25 summary output (regex over response body for known FY24 fixtures).
- Immutability: attempt to update `hypothesis_formed_at` via API; assert 4xx + audit_log row inserted.
- `proposed_id` walker tenant isolation: seed cross-tenant rows with same `proposed_id`; assert leak-proof.

**Commit:** `test(api): multi-cycle continuity contract tests (Body by Michael compliance)`.

### Task A.8: Open PR for p7a

After Tasks A.1–A.7 are committed and pushed, open PR titled `feat(p7a): multi-cycle narrative continuity + forensic metadata` against `main`. Body cites design doc Section 2 + Body by Michael compliance argument. CI must pass before `p7b` rebases onto the merge.

---

## Theme B — Prompt suggestion queue + GitHub App PRs (p7b)

### Task B.1: Migration 0038 — `prompt_suggestion` + `prompt_suggestion_review` + `prompt_suggestion_pr` tables

**Worktree:** `p7b`. **Theme:** B. **Depends on:** `p7a` merged. **Effort:** ~3 hours.

**Files:**

- Create: `packages/db/migrations/0038_prompt_suggestion_queue.sql` (DDL per design Section 3.2)
- Modify: `packages/db/migrations/meta/_journal.json` — append idx 38
- Test: `packages/db/src/migrations.test.ts` — column-existence + RLS-policy tests

**Steps:** standard migration TDD. Three tables, all RLS-protected by `tenant_id`, `prompt_suggestion` has 4 enum CHECK constraints (`source_kind`, `status`, `triage_classification`, `disposition` on review table).

**Commit:** `feat(db): migration 0038 — prompt suggestion queue tables`.

### Task B.2: GitHub App registration + JWT auth helper + installation-token cache

**Worktree:** `p7b`. **Theme:** B. **Depends on:** none (env-config task). **Effort:** ~4 hours.

**Files:**

- Create: `packages/integrations/src/github-app/jwt.ts` — RS256 JWT signer (10-min expiry, `iss=app_id`)
- Create: `packages/integrations/src/github-app/installation-token.ts` — exchanges JWT for installation token, caches with 50-min TTL (token actually lasts 60min; refresh 10min early)
- Create: `packages/integrations/src/github-app/octokit-factory.ts` — returns authenticated Octokit instance
- Test: `packages/integrations/src/github-app/installation-token.test.ts`

**Manual setup (one-time, doc only):**
- Register GitHub App at `https://github.com/settings/apps/new`
- Permissions: Contents R+W, Pull requests R+W, Metadata R
- Webhook URL: `${APP_BASE_URL}/webhooks/github` (configured in Task B.6)
- Install on `cpa-platform` repo
- Save `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM via secret manager), `GITHUB_APP_INSTALLATION_ID` to env

**Step 1: Write the failing test** — JWT signer produces valid RS256 token decodable with public key.

```ts
test('createAppJwt produces RS256 token with iss=app_id and 10-min exp', async () => {
  const token = await createAppJwt({ appId: '123', privateKey: TEST_PEM });
  const decoded = jwt.verify(token, TEST_PEM_PUBLIC, { algorithms: ['RS256'] }) as JwtPayload;
  assert.equal(decoded.iss, '123');
  assert.ok(decoded.exp! - decoded.iat! <= 600);
});

test('getInstallationToken caches across calls within TTL', async () => {
  const fetchMock = mock.fn(() => ({ token: 'tok_xyz', expires_at: '...' }));
  const t1 = await getInstallationToken({ ..., fetch: fetchMock });
  const t2 = await getInstallationToken({ ..., fetch: fetchMock });
  assert.equal(t1, t2);
  assert.equal(fetchMock.mock.calls.length, 1);
});
```

**Step 2-5: Run-fail / implement / run-pass / commit** `feat(integrations): GitHub App JWT auth + installation token cache`.

### Task B.3: API endpoints (flag / list / triage / generate-pr / webhook receiver)

**Worktree:** `p7b`. **Theme:** B. **Depends on:** Tasks B.1, B.2. **Effort:** ~8 hours.

**Files:**

- Create: `apps/api/src/routes/prompt-suggestions.ts`
  - `POST /v1/suggestions` — flag new suggestion (consultant clicks "this output is wrong")
  - `GET /v1/suggestions` — list, filter by status/source_kind
  - `GET /v1/suggestions/:id` — detail view
  - `POST /v1/suggestions/:id/triage` — set classification + status
  - `POST /v1/suggestions/:id/review` — reviewer disposition
  - `POST /v1/suggestions/:id/generate-pr` — kicks off PR generation (Task B.5)
- Create: `apps/api/src/routes/prompt-suggestions.test.ts`

**Per-endpoint TDD pattern.** RLS enforced via `setTenantContext()` middleware.

**Commit:** `feat(api): prompt-suggestion CRUD + triage + generate-pr endpoints`.

### Task B.4: `prompt-suggestion-evaluate@1.0.0` agent + repo-read tooling

**Worktree:** `p7b`. **Theme:** B. **Depends on:** Tasks B.1, B.2. **Effort:** ~10 hours.

**Files:**

- Create: `packages/agents/src/suggestion-evaluator/prompts/prompt-suggestion-evaluate@1.0.0.ts`
- Create: `packages/agents/src/suggestion-evaluator/repo-tools.ts` — Anthropic tool definitions for `read_file`, `search_code`, `list_directory`, `run_contract_test_subprocess`
- Create: `packages/agents/src/suggestion-evaluator/types.ts` — Zod schemas per design Section 3.5
- Test: `packages/agents/src/suggestion-evaluator/prompts/prompt-suggestion-evaluate@1.0.0.test.ts`

**Critical:** the agent has tool access to read but NOT write. The API layer applies the change set to a branch (Task B.5). Test asserts agent never produces a tool-use call for a write/edit action.

**Commit:** `feat(agents): prompt-suggestion-evaluate v1.0.0 + repo-read tools`.

### Task B.5: Multi-file commit choreography

**Worktree:** `p7b`. **Theme:** B. **Depends on:** Tasks B.2, B.4. **Effort:** ~6 hours.

**Files:**

- Create: `packages/integrations/src/github-app/pr-choreography.ts` — implements design Section 3.4 verbatim
- Test: `packages/integrations/src/github-app/pr-choreography.test.ts`

**Critical correctness requirements:**
- All file changes in a single commit (atomic)
- Branch deleted on failure (rollback)
- Cross-file consistency check runs BEFORE PR opens (sandboxed `pnpm test --filter <affected-package>` in subprocess; if test fails, abort and delete branch)
- PR body includes structured suggestion context + change-set rationale + reviewer info

**Step 1: Write the failing test** — happy path (3-file change set → 1 commit → 1 PR opened) and rollback path (forced contract-test failure → branch deleted, no PR).

**Step 2-5: Run-fail / implement / run-pass / commit** `feat(integrations): multi-file PR choreography with atomic commit + rollback`.

### Task B.6: GitHub webhook receiver + PR-status sync

**Worktree:** `p7b`. **Theme:** B. **Depends on:** Tasks B.1, B.5. **Effort:** ~3 hours.

**Files:**

- Create: `apps/api/src/routes/webhooks/github.ts` — receives `pull_request.merged`, `pull_request.closed`; updates `prompt_suggestion_pr.merged_at`, sets `prompt_suggestion.status = 'pr_merged'`
- Create: `apps/api/src/routes/webhooks/github.test.ts` — signed-payload verification, idempotency
- Create: background reconciler `tools/scripts/reconcile-prompt-suggestion-prs.ts` — periodic catchup for missed webhooks

**Webhook security:** verify `X-Hub-Signature-256` header against `GITHUB_WEBHOOK_SECRET` shared secret (configured at app installation).

**Commit:** `feat(api): GitHub webhook receiver + PR-status sync + reconciler`.

### Task B.7: Suggestion queue UI

**Worktree:** `p7b`. **Theme:** B. **Depends on:** Tasks B.1, B.3. **Effort:** ~8 hours.

**Files:**

- Create: `apps/web/src/routes/suggestions/index.tsx` — list view
- Create: `apps/web/src/routes/suggestions/[id].tsx` — detail view + reviewer actions
- Create: `apps/web/src/components/pr-tracking-widget.tsx` — live PR status from Task B.6 webhooks
- Create: `apps/web/src/routes/suggestions/index.test.tsx` + `[id].test.tsx`

**Includes "flag this output" button on agent-output displays** (narrative draft viewer, register draft viewer, classifier confidence badges) — opens modal that POSTs to `/v1/suggestions`.

**Commit:** `feat(web): prompt suggestion queue UI + PR tracking widget`.

### Task B.8: Theme B contract tests

**Worktree:** `p7b`. **Theme:** B. **Depends on:** Tasks B.1–B.7. **Effort:** ~3 hours.

**Files:**

- Create: `apps/api/src/routes/prompt-suggestions.contract.test.ts`

**Tests:**
- Mocked GitHub App + Octokit returns expected sequence: createRef → createTree → createCommit → updateRef → createPR.
- Failure path: contract-test subprocess fails → branch deleted via deleteRef → no PR opened → suggestion status reverted to `triaged`.
- Webhook idempotency: same `pull_request.merged` payload twice → only one DB update.
- Three-way parity for `source_kind`, `status`, `triage_classification`, `disposition` enums.

**Commit:** `test(api): prompt-suggestion choreography + idempotency contract tests`.

### Task B.9: Open PR for p7b

After Tasks B.1–B.8 committed + pushed, open PR titled `feat(p7b): prompt suggestion queue + GitHub App PR generation` against `main`. Note that Theme C's multi-entity panel ships empty until `p7d` lands.

---

## Theme C — Activity audit timeline + multi-entity comparison (p7c)

### Task C.1: Timeline endpoint + `verifyChain` integration

**Worktree:** `p7c`. **Theme:** C. **Depends on:** `p7b` merged. **Effort:** ~4 hours.

**Files:**

- Create: `apps/api/src/routes/audit-timeline.ts` — `GET /v1/audit/activity/:activityId/timeline`
- Test: `apps/api/src/routes/audit-timeline.test.ts`

**Critical:** batch `verifyChain()` over the timeline's event set; do not run per-row (R-C1 from risk register). Cache per request lifetime.

**Step 1: Write the failing test** — seed activity with 5 events + 3 narrative versions + 2 audit log rows; assert timeline returns 10 rows in chronological order; assert `chain_verified=true` on all event rows.

**Step 2-4: Run-fail / implement / run-pass.** Implementation joins `event` ∪ `narrative_draft_version` ∪ `audit_log` ∪ `prompt_suggestion` ∪ `multi_entity_similarity_score` (the last via `to_regclass` existence check; returns empty until p7d lands).

**Step 5: Commit** `feat(api): activity audit timeline endpoint with batched chain verification`.

### Task C.2: Timeline UI component

**Worktree:** `p7c`. **Theme:** C. **Depends on:** Task C.1. **Effort:** ~4 hours.

**Files:**

- Create: `apps/web/src/components/audit-timeline.tsx`
- Create: `apps/web/src/components/audit-timeline.test.tsx`
- Modify: `apps/web/src/routes/activity/[id].tsx` — embed timeline tab

**UI:** vertical timeline, icon per `kind` (event=📥, narrative_version=✏️, audit_log=🔍, suggestion=💡, similarity_flag=⚠️), green checkmark for `chain_verified=true`, red X if false.

**Commit:** `feat(web): activity audit timeline component`.

### Task C.3: Forensic metadata display

**Worktree:** `p7c`. **Theme:** C. **Depends on:** Task C.2. **Effort:** ~2 hours.

**Files:**

- Modify: `apps/web/src/components/audit-timeline.tsx` — add hover-card showing `first_recorded_at`, `content_hash` (truncated), `chain_position`, `edit_count`
- Modify: `apps/web/src/components/narrative-version-diff.tsx` — show `first_recorded_at` on each version

**Commit:** `feat(web): forensic metadata hover-cards on audit timeline`.

### Task C.4: Multi-entity comparison panel

**Worktree:** `p7c`. **Theme:** C. **Depends on:** Task C.1. **Effort:** ~5 hours.

**Files:**

- Create: `apps/api/src/routes/multi-entity-comparison.ts` — `GET /v1/multi-entity-comparison/:proposed_id_or_activity_filter`
- Create: `apps/web/src/routes/multi-entity-comparison.tsx`
- Test: both `.test.ts` files

**Endpoint behavior:** queries activities across the consultant's accessible `subject_tenant_id` set (RLS handles filtering), joins `multi_entity_similarity_score` if it exists (otherwise returns null scores). Returns grid layout: 1 row per activity, 1 column per entity.

**UI:** sparkline-style heatmap, yellow ⚠ on similarity ≥ 0.75, click opens side-by-side diff. Empty state ("No similarity scans yet — install Theme D to enable") shown until `p7d` lands.

**Commit:** `feat(web,api): multi-entity comparison panel (gracefully empty pre-p7d)`.

### Task C.5: Drilldown views

**Worktree:** `p7c`. **Theme:** C. **Depends on:** Task C.4. **Effort:** ~2 hours.

**Files:**

- Create: `apps/web/src/components/event-detail-drawer.tsx`
- Create: `apps/web/src/components/narrative-version-diff.tsx`
- Create: `apps/web/src/components/similarity-side-by-side.tsx`

Standard component creation + tests.

**Commit:** `feat(web): timeline drilldown components (event detail, narrative diff, similarity side-by-side)`.

### Task C.6: Theme C contract test

**Worktree:** `p7c`. **Theme:** C. **Depends on:** Tasks C.1–C.5. **Effort:** ~1 hour.

**Files:**

- Create: `apps/api/src/routes/audit-timeline.contract.test.ts`

**Tests:** seeded chain with verified anchor returns `chain_verified=true`; tampered anchor returns `chain_verified=false`; multi-entity endpoint returns empty similarity_score column when `multi_entity_similarity_score` table doesn't exist (pre-p7d state).

**Commit:** `test(api): audit-timeline + multi-entity contract tests`.

### Task C.7: Open PR for p7c

After Tasks C.1–C.6 committed + pushed, open PR titled `feat(p7c): activity audit timeline + multi-entity comparison panel` against `main`. PR body notes: "multi-entity panel ships empty until p7d's `multi_entity_similarity_score` table lands."

---

## Theme D — Compliance capture + Regulatory Intelligence Feed (p7d)

### Task D.1: Migration 0040a — 5 compliance tables

**Worktree:** `p7d`. **Theme:** D. **Depends on:** `p7c` merged. **Effort:** ~4 hours.

**Files:**

- Create: `packages/db/migrations/0040a_compliance_capture.sql` (DDL per design Section 4.5.2 verbatim)
- Modify: `packages/db/migrations/meta/_journal.json` — append idx 40 (single entry; 0040a + 0040b deploy as a pair)
- Test: `packages/db/src/migrations.test.ts` — additive

**Tests cover:** 5 tables exist with correct columns; RLS enabled on all; `ta_2023_4_flag` and `ta_2023_5_flag` are GENERATED stored columns; CHECK constraint on `multi_entity_similarity_score.activity_pair_ordered`; UNIQUE constraint on `rd_forecast (subject_tenant_id, base_fy_label, forecast_year_offset)`.

**Commit:** `feat(db): migration 0040a — compliance capture tables (beneficial_ownership, knowledge_search, multi_entity_similarity, facilities, forecast)`.

### Task D.2: Compliance API endpoints (8 routes)

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Task D.1. **Effort:** ~10 hours.

**Files:**

- Create: `apps/api/src/routes/compliance.ts` — 8 endpoints per design Section 4.5.7
- Create: `apps/api/src/routes/compliance.test.ts`

**One TDD cycle per endpoint.** Each gets: write failing test → run-fail → implement → run-pass → commit. 8 commits total, e.g.:

- `feat(api): POST /compliance/beneficial-ownership endpoint`
- `feat(api): GET /compliance/beneficial-ownership/:subject/:fy endpoint`
- ... (6 more)

The `GET /compliance/form-completeness/:subject/:fy` endpoint is the most complex — it cross-checks: all activities have ≥1 `knowledge_search_record`; beneficial_ownership populated for the FY; rd_forecast populated for offsets 1+2+3; r_and_d_facility populated; narrative char counts within 15 Aug 2025 form min/max thresholds.

### Task D.3: `multi-entity-similarity@1.0.0` agent + corpus loader

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Task D.1. **Effort:** ~6 hours.

**Files:**

- Create: `packages/agents/src/multi-entity-similarity/prompts/multi-entity-similarity@1.0.0.ts`
- Create: `packages/agents/src/multi-entity-similarity/corpus-loader.ts` — loads historical-rejection corpus from `regulatory_event` rows where `classification_kind IN ('aat_decision','art_decision')` and severity indicates rejection
- Create: `packages/agents/src/multi-entity-similarity/scorer.ts` — orchestrates pairwise scan
- Test: full unit + integration coverage

**Steps follow standard TDD pattern.** Tests cover: known-similar activity pair → score ≥ 0.75; known-disjoint pair → score < 0.5; activity vs historical-rejection corpus row → produces `vs_historical_rejection` similarity_kind row.

**Commit:** `feat(agents): multi-entity-similarity v1.0.0 + corpus loader + pairwise scorer`.

### Task D.4: Compliance UI — 6 sub-panels

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Tasks D.2, D.3. **Effort:** ~14 hours.

**Files:**

- Create: `apps/web/src/routes/compliance/[subject]/[fy]/index.tsx` — outer page
- Create: `apps/web/src/components/compliance/beneficial-ownership-matrix.tsx`
- Create: `apps/web/src/components/compliance/knowledge-search-record-form.tsx`
- Create: `apps/web/src/components/compliance/facilities-map.tsx`
- Create: `apps/web/src/components/compliance/forecast-spreadsheet.tsx`
- Create: `apps/web/src/components/compliance/multi-entity-similarity-dashboard.tsx`
- Create: `apps/web/src/components/compliance/form-completeness-gauge.tsx`
- Create: full `.test.tsx` companions

**One commit per sub-panel.** The form-completeness gauge is the keystone: subscribes to `/compliance/form-completeness` endpoint, renders a colored progress bar with checkboxes per requirement category, blocks the "submit form" CTA when not green.

### Task D.5: At-risk + clawback calculator

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Task D.2. **Effort:** ~3 hours.

**Files:**

- Create: `packages/audit-score/src/clawback-calculator.ts` — engine: given an activity's claimed expenditure + offset model, computes "if rejected today" claim drop and "if rejected after 4 years" clawback (claim drop + interest at ATO general interest charge rate)
- Create: `apps/web/src/components/compliance/at-risk-summary.tsx` — UI panel
- Test: both `.test.ts` files

**Commit:** `feat(audit-score,web): at-risk + clawback calculator`.

### Task D.6: Three-way parity tests for new enums

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Tasks D.1, D.8. **Effort:** ~2 hours.

**Files:**

- Modify: `tools/scripts/check-three-way-parity.test.ts` — add 9 new enum rows: `owner_kind`, `similarity_kind`, `reviewer_disposition`, `forecast_confidence`, `regulatory_event_kind`, `regulatory_event_severity`, `regulatory_source_parser_kind`, `regulatory_source_last_polled_status`, `prompt_suggestion_review_disposition` (added retroactively for completeness).

**Commit:** `test(tools): three-way parity for Theme D + RIF enums`.

### Task D.7: Form-completeness contract test

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Task D.2. **Effort:** ~2 hours.

**Files:**

- Create: `apps/api/src/routes/compliance.form-shape.test.ts`
- Create: `tests/fixtures/r-and-d-form-2025-08-15-schema.json` — captured snapshot of 15 Aug 2025 form fields, min/max char rules, mandatory-field flags

**Test:** exhaustively iterate through every mandatory field in the snapshot; for each, assert that the `form-completeness` endpoint returns "missing" when the corresponding DB row is absent and "present" when populated. CI fails if any new fixture field is added without endpoint support.

**Commit:** `test(api): form-completeness contract test against 15 Aug 2025 form schema fixture`.

### Task D.8: Migration 0040b — RIF tables

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Task D.1. **Effort:** ~1 hour.

**Files:**

- Create: `packages/db/migrations/0040b_regulatory_intelligence.sql` (DDL per design Section 4.5.3 verbatim, including seed `regulatory_source` rows)
- Modify: `packages/db/migrations/meta/_journal.json` — extend idx 40 entry or add idx 41 (decide based on local journal convention)
- Test: standard migration verification

**Commit:** `feat(db): migration 0040b — regulatory_event + regulatory_source tables`.

### Task D.9: Daily cron + source connectors framework

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Task D.8. **Effort:** ~4 hours.

**Files:**

- Create: `tools/scripts/scrape-regulatory.ts` — main entry per design Section 4.5.4
- Create: `packages/integrations/src/regulatory/source-connector.ts` — abstract `ISourceConnector` interface
- Create: `packages/integrations/src/regulatory/connector-factory.ts` — dispatches based on `regulatory_source.parser_kind`
- Create: `packages/integrations/src/regulatory/error-classifier.ts` — maps fetch errors to `last_polled_status` enum values
- Test: integration test asserts cron processes seeded sources in correct order

**Cron registration:** uses pg-boss (existing dependency) `boss.schedule('rif-daily-scrape', '0 3 * * *', 'Australia/Sydney')`.

**Commit:** `feat(integrations,tools): RIF daily-cron framework + abstract source connector`.

### Task D.10: `regulatory-classify@1.0.0` agent

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Task D.9. **Effort:** ~3 hours.

**Files:**

- Create: `packages/agents/src/regulatory-classifier/prompts/regulatory-classify@1.0.0.ts`
- Create: `packages/agents/src/regulatory-classifier/types.ts` — Zod per design Section 4.5.5
- Test: standard pattern; fixture inputs from public ATO TA texts.

**Commit:** `feat(agents): regulatory-classify v1.0.0`.

### Task D.11: Theme B + Theme D webhook dispatch

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Tasks D.9, D.10, plus `p7b` features (suggestion queue inserts). **Effort:** ~3 hours.

**Files:**

- Create: `packages/integrations/src/regulatory/webhook-dispatch.ts` — dispatches classified events to:
  - Theme B: `INSERT INTO prompt_suggestion (source_kind='rif_event', source_payload=jsonb_build_object('regulatory_event_id', e.id), affected_prompt_module=cls.affects_prompt_modules[0], ...)`
  - Theme D: if `classification_kind IN ('aat_decision','art_decision')` and event indicates rejection → invoke `multi-entity-similarity` corpus refresh; if `affects_compliance_fields` non-empty → flag affected claims via insert to `prompt_suggestion` with `triage_classification='schema_change'`
- Test: fixture event → verify suggestion + similarity rows inserted within 5s assertion window.

**Commit:** `feat(integrations): RIF webhook dispatch to Theme B + Theme D`.

### Task D.12: RIF UI (`/intelligence` route)

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Task D.10. **Effort:** ~5 hours.

**Files:**

- Create: `apps/web/src/routes/intelligence/index.tsx` — sortable, filterable feed list
- Create: `apps/web/src/components/intelligence-event-card.tsx` — per-event card with severity badge, classification chips, drilldown link
- Create: `apps/web/src/components/intelligence-stale-source-banner.tsx` — surfaces if any source's `last_polled_at` > 7 days
- Test: `.test.tsx` companions

**Commit:** `feat(web): /intelligence route + RIF event feed UI`.

### Task D.13: Source connectors implementation

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Task D.9. **Effort:** ~8 hours.

**Files:**

- Create: `packages/integrations/src/regulatory/connectors/ato-rss.ts`
- Create: `packages/integrations/src/regulatory/connectors/austlii-html.ts` — handles AAT + ART pages with R&DTI keyword filter
- Create: `packages/integrations/src/regulatory/connectors/business-gov-au-html.ts`
- Create: `packages/integrations/src/regulatory/connectors/isa-html.ts`
- Create: `packages/integrations/src/regulatory/connectors/industry-rss.ts` — RSM AU + Big-4 feeds (URLs configured via `RIF_INDUSTRY_RSS_FEEDS`)
- Test: each connector has fixture-based test (captured RSS XML / HTML snapshots in `tests/fixtures/regulatory/`)

**One commit per connector.** Test fixtures captured manually once and committed alongside.

### Task D.14: Historical backfill (AAT/ART 2015+, ATO TAs 2018+)

**Worktree:** `p7d`. **Theme:** D. **Depends on:** Tasks D.10, D.13. **Effort:** ~6 hours.

**Files:**

- Create: `tools/scripts/backfill-regulatory-history.ts` — one-shot script that walks AustLII AAT/ART R&DTI keyword filter back to 2015 and ATO TAs back to 2018; ingests, classifies, persists
- Create: `tools/scripts/backfill-regulatory-history.test.ts` — small-scale fixture run

**Run instructions** documented in `docs/runbooks/2026-05-DD-rif-backfill.md` (created as part of this task).

**Commit:** `feat(tools): RIF historical backfill (AAT/ART 2015+, ATO TAs 2018+)`.

### Task D.15: Open PR for p7d

After Tasks D.1–D.14 committed + pushed, open PR titled `feat(p7d): compliance capture + Regulatory Intelligence Feed` against `main`. PR body notes: "Multi-entity similarity scans run nightly via pg-boss cron; Theme C's panel becomes live on merge."

---

## Cross-cutting tasks (woven into each theme)

The 12h cross-cutting budget is distributed across themes:

- Migration choreography: handled by branch sequencing + each migration's idx reservation (above)
- Three-way parity expansion: Tasks A.6 + D.6
- Telemetry spans: each agent task adds OTLP spans per design Section 5.4
- Form-completeness contract test: Task D.7
- Risk register doc: lives in design doc, no separate task

---

## Sequencing checklist (controller follows this order)

1. **Pre-flight per branch:** create worktree via **superpowers:using-git-worktrees** skill; verify clean baseline (`pnpm -r test`).
2. **`p7a` work, sequenced within branch:** Task A.1 → A.2 → A.3 → A.4 → A.5 → A.6 → A.7 → A.8 (PR open). Wait for PR to merge.
3. **`p7b` work** (cuts off post-`p7a`-merge `main`): Tasks B.1 → B.2 → B.3 → B.4 → B.5 → B.6 → B.7 → B.8 → B.9 (PR open). Wait for merge.
4. **`p7c` work** (cuts off post-`p7b`-merge `main`): Tasks C.1 → C.2 → C.3 → C.4 → C.5 → C.6 → C.7 (PR open). Wait for merge.
5. **`p7d` work** (cuts off post-`p7c`-merge `main`): Tasks D.1 → D.2 → D.3 → ... → D.15 (PR open). Wait for merge.
6. **Final smoke test** post-`p7d`-merge: end-to-end multi-cycle + multi-entity scan + RIF event ingest → suggestion auto-create → PR generated → consultant merges. Document in `docs/retros/2026-MM-DD-p7-retro.md`.

Each task uses TDD pattern from P5/P6 (write failing test → run-fail → implement → run-pass → commit → push). Each worktree opens a single PR for its theme, NOT per-task.

| PR # (expected) | Branch | Themes | Lands after |
| --- | --- | --- | --- |
| #23 | `p7a/multi-cycle` | A | PR for design doc (`e5e1435`) |
| #24 | `p7b/prompt-suggestions` | B | #23 |
| #25 | `p7c/audit-timeline` | C | #24 |
| #26 | `p7d/compliance-capture` | D + RIF | #25 |

---

## Risk register (carried from design doc Section 5.6)

See `docs/plans/2026-05-03-p7-design.md` Section 5.6. Highest-leverage risks:

1. **R-D1 Body by Michael (HIGH):** Task A.1's immutability trigger + Task A.7's contract test are mandatory. Don't skip the trigger test — backdating attempts MUST audit-log + raise.
2. **R-D2 DISR pattern-matching (HIGH):** Task D.3's similarity scorer + Task D.4's multi-entity dashboard + the `reviewer_disposition` workflow are mandatory before any FY25 form submission ships through the platform.
3. **R-A1 multi-cycle paraphrase leak (MEDIUM):** Task A.3's schema-strictness test + Task A.7's no-prose regex assertion are mandatory.
4. **R-B1 GitHub App key leak (MEDIUM):** Task B.2's PEM must come from secret manager; quarterly rotation tested before Phase-2 rollout.
5. **R-D3 source ToS / rate-limit changes (MEDIUM):** Task D.9's `last_polled_status` enum + Task D.12's stale-source banner are mandatory.

---

## Open follow-ups deferred to P8 (do NOT implement in P7)

- Phone / email / Slack alerting layer over RIF events (Q-D4 deferred)
- Severity-threshold calibration based on first-30-day feed data
- ASX paid disclosure feed integration
- Email-to-inbox parser for newsletters without RSS
- Project-level audit dashboard (Q8 deferred)
- Multi-entity similarity model fine-tuning on accumulated `reviewer_disposition` data

End of P7 implementation plan.
