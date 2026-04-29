# P5 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land all Wide-scope P5 items per the design at `docs/plans/2026-04-30-p5-design.md`: data model denormalization (Theme 1), API surface gaps (Theme 4), audit_log table for firm-scoped events (Theme 2), deferred event emissions (Theme 5), types relocation (Theme 3), spec/comments cleanup (Theme 6), polish (Theme 7).

**Architecture:** Approach A per-item dispatch across 4 worktrees (`p5a`, `p5b`, `p5c`, `p5d`). Hybrid sequencing — parallel for independent items, single-stream for Theme 2 keystone and Theme 5 chain. No NOT NULL on `claim.project_id`. Separate `audit_log` table (no chain in v1). Apply-rules as a separate endpoint, not a `commit:true` flag.

**Tech Stack:** TypeScript 5.x, postgres-js, Drizzle ORM, Fastify, Zod, node:test, @react-pdf/renderer, Playwright.

**Prerequisite:** PR #4 must land on `main` before any P5 work begins. Worktrees `p5a`/`p5b`/`p5c`/`p5d` cut from updated main.

---

## Worktree allocation

| Worktree | Branch | Themes |
|----------|--------|--------|
| `p5a` | `p5a/denormalization` | Theme 1 (1.1, 1.2, 1.3) |
| `p5b` | `p5b/audit-log` | Theme 2 (2.1, 2.2, 2.3, 2.4) — single-stream |
| `p5c` | `p5c/event-emissions` | Theme 5 (5.1, 5.2, 5.4) — chains on Theme 1+2 |
| `p5d` | `p5d/polish` | Themes 3, 4, 6, 7 — independent items |

---

## Theme 1 — Data model denormalization

### Task 1.1: Add `claim.project_id`

**Worktree**: `p5a`. **Theme**: 1. **Depends on**: none. **Effort**: ~3 hours.

**Files:**
- Create: `packages/db/migrations/0018_claim_project_id.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append idx 18)
- Modify: `packages/db/src/schema/claim.ts` (add column)
- Test: `packages/db/src/migrations.test.ts` (add round-trip assertion)

**Step 1: Write the failing migration test**

```ts
test('migration 0018: claim.project_id is nullable + indexed + backfills from activity', async () => {
  await applyMigrations({ uptoIdx: 18 });
  // Seed firm + subject_tenant + project + claim + activity (activity has project_id)
  const claim = await privilegedSql`
    SELECT project_id FROM claim WHERE id = ${claimId}
  `;
  expect(claim[0].project_id).toBe(projectId); // backfilled
});
```

**Step 2: Run to confirm fail**

```bash
pnpm --filter @cpa/db test src/migrations.test.ts -- -t "migration 0018"
# Expected: FAIL — migration 0018 does not exist
```

**Step 3: Write migration SQL**

```sql
-- 0018_claim_project_id.sql
ALTER TABLE claim ADD COLUMN project_id uuid REFERENCES project(id);
CREATE INDEX claim_project_id_idx ON claim (project_id);

-- Backfill from activity.project_id (each claim's activities share one project_id)
UPDATE claim SET project_id = (
  SELECT DISTINCT a.project_id
  FROM activity a
  WHERE a.claim_id = claim.id
  LIMIT 1
)
WHERE project_id IS NULL;
```

**Step 4: Update Drizzle schema**

```ts
// packages/db/src/schema/claim.ts — add to existing pgTable definition:
projectId: uuid('project_id').references(() => project.id),
```

**Step 5: Append journal entry**

```json
// packages/db/migrations/meta/_journal.json
{ "idx": 18, "tag": "0018_claim_project_id", ... }
```

**Step 6: Run test, confirm pass**

```bash
pnpm --filter @cpa/db test src/migrations.test.ts -- -t "migration 0018"
# Expected: PASS
```

**Step 7: Commit**

```bash
git add packages/db/migrations/0018_claim_project_id.sql packages/db/migrations/meta/_journal.json packages/db/src/schema/claim.ts packages/db/src/migrations.test.ts
git commit -m "feat(db): add claim.project_id (nullable, indexed) + backfill from activity"
git push origin p5a/denormalization
```

---

### Task 1.2: Add `expenditure.claim_id`

**Worktree**: `p5a`. **Theme**: 1. **Depends on**: none. **Effort**: ~2 hours.

**Files:**
- Create: `packages/db/migrations/0019_expenditure_claim_id.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append idx 19)
- Modify: `packages/db/src/schema/expenditure.ts`

**Step 1: Test** — round-trip insert with `claim_id` set; query by claim_id returns row.

**Step 2: Migration**

```sql
-- 0019_expenditure_claim_id.sql
ALTER TABLE expenditure ADD COLUMN claim_id uuid REFERENCES claim(id);
CREATE INDEX expenditure_claim_id_idx ON expenditure (claim_id);
-- No backfill — unmapped expenditures are a real state. Populated by Theme 5.
```

**Step 3: Drizzle schema** — add `claimId: uuid('claim_id').references(() => claim.id)`.

**Step 4: Run test, commit**

```bash
git commit -m "feat(db): add expenditure.claim_id (nullable, indexed)"
```

---

### Task 1.3: Add `expenditure_line.line_number` + update preview-rules callsites

**Worktree**: `p5a`. **Theme**: 1. **Depends on**: none (but Theme 5 uses it). **Effort**: ~2 hours.

**Files:**
- Create: `packages/db/migrations/0020_expenditure_line_number.sql`
- Modify: `apps/api/src/routes/preview-rules.ts:286, 415` (the two `ORDER BY id ASC` callsites — replace with `ORDER BY line_number ASC, id ASC`)

**Step 1: Test** — multi-line expenditure returns first line by `line_number`, not by UUID.

```ts
test('preview-rules: multi-line expenditure picks line_number=1, not UUID-first', async () => {
  // Seed expenditure with 3 lines: line_numbers 1,2,3 in random insertion order
  const result = await previewRules(expenditureId, ...);
  expect(result.matches[0].rule_id).toMatchExpectedRule_for_line_1();
});
```

**Step 2: Migration**

```sql
-- 0020_expenditure_line_number.sql
ALTER TABLE expenditure_line ADD COLUMN line_number integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX expenditure_line_number_unique
  ON expenditure_line (expenditure_id, line_number);
-- DEFAULT 1 backfills all existing rows; per-expenditure uniqueness only matters
-- when multi-line expenditures are inserted going forward.
```

**Step 3: Update Drizzle schema + the two preview-rules callsites:**

```ts
// preview-rules.ts:286 and :415 — replace `ORDER BY id ASC` with:
ORDER BY el.line_number ASC, el.id ASC
```

**Step 4: Test, commit**

```bash
git commit -m "feat(db,api): add expenditure_line.line_number + use in preview-rules ordering"
```

---

## Theme 4 — API surface gaps

### Task 4.1: `?status=` filter on `GET /v1/projects`

**Worktree**: `p5d`. **Theme**: 4. **Depends on**: none. **Effort**: ~2 hours.

**Files:**
- Modify: `apps/api/src/routes/projects.ts` (extend Zod query schema; add `WHERE archived_at IS NULL/NOT NULL/either`)
- Modify: `apps/api/src/routes/projects.test.ts` (add 3 tests: status=active, status=archived, status=all)

**Step 1: Test (representative)**

```ts
test('GET /v1/projects?status=archived returns only archived projects', async () => {
  await seedProject({ archivedAt: new Date() });
  await seedProject({ archivedAt: null });
  const response = await fetch(`/v1/projects?status=archived`, { headers: signedHeaders(ADMIN) });
  const body = await response.json();
  expect(body.projects).toHaveLength(1);
  expect(body.projects[0].archived_at).toBeTruthy();
});
```

**Step 2: Extend Zod schema**

```ts
// apps/api/src/routes/projects.ts
const listProjectsQuery = z.object({
  status: z.enum(['active', 'archived', 'all']).optional().default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: Uuid.optional(),
});
```

**Step 3: Update SQL**

```ts
const archivedClause = status === 'active' ? sql`AND archived_at IS NULL`
                     : status === 'archived' ? sql`AND archived_at IS NOT NULL`
                     : sql``; // 'all'
```

**Step 4: Test, commit**

```bash
git commit -m "feat(api): add ?status= filter to GET /v1/projects"
```

---

### Task 4.2: `?project_id=` filter on `GET /v1/claims`

**Worktree**: `p5d`. **Theme**: 4. **Depends on**: 1.1 (`claim.project_id` column). **Effort**: ~2 hours.

**Files:** `apps/api/src/routes/claims.ts` + `claims.test.ts`.

**Step 1: Test** — seed 2 projects each with claims; query `?project_id=A` returns only A's claims.

**Step 2: Zod + SQL**

```ts
const listClaimsQuery = z.object({
  subject_tenant_id: Uuid.optional(),
  project_id: Uuid.optional(),  // NEW
  // ... existing
}).refine(d => d.subject_tenant_id || d.project_id, {
  message: 'Either subject_tenant_id or project_id is required',
});

// in handler:
const projectClause = parsed.data.project_id 
  ? sql`AND project_id = ${parsed.data.project_id}` 
  : sql``;
```

**Step 3: Test, commit**

```bash
git commit -m "feat(api): add ?project_id= filter to GET /v1/claims (uses 1.1 denormalized FK)"
```

---

### Task 4.3: `?project_id=` filter on `GET /v1/events`

**Worktree**: `p5d`. **Theme**: 4. **Depends on**: 1.1. **Effort**: ~2 hours.

Mirrors 4.2. Events table doesn't have `project_id` directly — JOIN through `claim`:

```ts
// SQL fragment when project_id is provided:
AND e.subject_tenant_id IN (
  SELECT subject_tenant_id FROM claim WHERE project_id = ${project_id}
)
```

```bash
git commit -m "feat(api): add ?project_id= filter to GET /v1/events"
```

---

## Theme 2 — Firm-scoped events / audit_log (single-stream)

### Task 2.1: `audit_log` table + RLS + GUC plumbing

**Worktree**: `p5b`. **Theme**: 2. **Depends on**: none. **Effort**: ~6 hours.

**Files:**
- Create: `packages/db/migrations/0021_audit_log_table.sql`
- Create: `packages/db/src/schema/audit_log.ts`
- Modify: `apps/api/src/auth/middleware.ts` (set `app.current_firm_id` GUC alongside existing `app.current_tenant_id`)
- Create: `apps/api/src/routes/audit-log.test.ts` (RLS positive-control test — NEW PRECEDENT)

**Step 1: Write the failing RLS positive-control test (the new pattern this task establishes)**

```ts
test('audit_log RLS: FIRM_A session cannot read FIRM_B rows', async () => {
  await seedFirm(FIRM_A);
  await seedFirm(FIRM_B);
  // Insert directly via privilegedSql under each firm's id
  await privilegedSql`INSERT INTO audit_log (firm_id, kind, payload, actor_user_id) VALUES (${FIRM_A}, 'TEST_KIND', '{}'::jsonb, ${ADMIN_A})`;
  await privilegedSql`INSERT INTO audit_log (firm_id, kind, payload, actor_user_id) VALUES (${FIRM_B}, 'TEST_KIND', '{}'::jsonb, ${ADMIN_B})`;

  // Sign in as FIRM_A admin; query
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_firm_id', ${FIRM_A}, true)`;
    return tx`SELECT firm_id FROM audit_log WHERE kind = 'TEST_KIND'`;
  });

  expect(rows).toHaveLength(1);
  expect(rows[0].firm_id).toBe(FIRM_A);  // FIRM_B row is INVISIBLE
});

test('audit_log RLS: GUC unset → query returns no rows', async () => {
  // No set_config; FIRM_A row exists in seed
  const rows = await privilegedSql`
    SELECT firm_id FROM audit_log WHERE kind = 'TEST_KIND'
  `; // privilegedSql bypasses RLS — but normal sql() should return 0
  // ... assertion that with GUC unset, the policy denies
});
```

**Step 2: Run, confirm fail (table doesn't exist)**

**Step 3: Migration**

```sql
-- 0021_audit_log_table.sql
CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  actor_user_id uuid REFERENCES "user"(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_kind_nonempty CHECK (kind <> ''),
  CONSTRAINT audit_log_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX audit_log_firm_idx ON audit_log (firm_id, created_at DESC);
CREATE INDEX audit_log_kind_idx ON audit_log (firm_id, kind, created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_firm_isolation ON audit_log
  USING (firm_id = current_setting('app.current_firm_id', true)::uuid)
  WITH CHECK (firm_id = current_setting('app.current_firm_id', true)::uuid);

GRANT SELECT, INSERT ON audit_log TO cpa_app;
```

**Step 4: Drizzle schema (`audit_log.ts`)** — standard pgTable, plus `import type { AuditPayload } from '@cpa/schemas/audit'` for `payload.$type<AuditPayload>()`.

**Step 5: Auth middleware** — set `app.current_firm_id` GUC in `sql.begin` based on session's `firm_id`.

```ts
// apps/api/src/auth/middleware.ts — inside the request handler that opens sql.begin:
await tx`SELECT set_config('app.current_tenant_id', ${session.tenantId}::text, true)`;
await tx`SELECT set_config('app.current_firm_id', ${session.firmId}::text, true)`;  // NEW
```

**Step 6: Test, commit**

```bash
git commit -m "feat(db,api): add audit_log table + RLS + firm_id GUC plumbing"
```

---

### Task 2.2: Move `MAPPING_RULE_*` kinds from `event` to `audit`

**Worktree**: `p5b`. **Theme**: 2. **Depends on**: 2.1. **Effort**: ~3 hours.

**Files:**
- Create: `packages/schemas/src/audit.ts` (new — `AUDIT_KINDS`, payload Zod schemas)
- Modify: `packages/schemas/src/event.ts` (remove the three `MAPPING_RULE_*` entries from `evidenceKind`)
- Modify: `packages/db/src/schema/event.ts` (remove from `EVIDENCE_KINDS`)
- Create: `packages/db/migrations/0022_remove_mapping_rule_from_event_kinds.sql`

**Migration**

```sql
-- 0022_remove_mapping_rule_from_event_kinds.sql
-- The event_kind_valid CHECK constraint was rebuilt in 0017 to include MAPPING_RULE_*.
-- Now rebuild it to exclude them.
ALTER TABLE event DROP CONSTRAINT event_kind_valid;
ALTER TABLE event ADD CONSTRAINT event_kind_valid CHECK (kind IN (
  -- ... full list MINUS the three MAPPING_RULE_* entries
));
```

**Step**: Test that an attempt to insert a MAPPING_RULE_CREATED into `event` now fails with CHECK violation.

```bash
git commit -m "refactor(schemas,db): move MAPPING_RULE_* kinds from event to audit_log"
```

---

### Task 2.3: `insertAuditLog()` writer helper

**Worktree**: `p5b`. **Theme**: 2. **Depends on**: 2.1, 2.2. **Effort**: ~2 hours.

**Files:**
- Create: `packages/db/src/audit-log.ts`
- Test: `packages/db/src/audit-log.test.ts`

```ts
// audit-log.ts
import { type AuditKind, type AuditPayload } from '@cpa/schemas/audit';

export async function insertAuditLog(opts: {
  tx: TransactionClient;          // accept caller's tx so insert participates in same transaction
  firmId: Uuid;
  kind: AuditKind;
  payload: AuditPayload;
  actorUserId: Uuid | null;
}): Promise<{ id: Uuid; created_at: Date }> {
  const result = await opts.tx`
    INSERT INTO audit_log (firm_id, kind, payload, actor_user_id)
    VALUES (${opts.firmId}, ${opts.kind}, ${JSON.stringify(opts.payload)}::jsonb, ${opts.actorUserId})
    RETURNING id, created_at
  `;
  return result[0];
}
```

**Tests**: round-trip insert, ON DELETE CASCADE behaviour, RLS gate (the positive-control test from 2.1 stays as the canonical RLS check).

```bash
git commit -m "feat(db): add insertAuditLog writer helper for firm-scoped events"
```

---

### Task 2.4: Wire `MAPPING_RULE_*` emissions in `mapping-rules.ts`

**Worktree**: `p5b`. **Theme**: 2. **Depends on**: 2.3. **Effort**: ~3 hours.

**Files:**
- Modify: `apps/api/src/routes/mapping-rules.ts` (POST/PATCH/DELETE handlers — replace the `TODO(P4-followup): emit MAPPING_RULE_CREATED...` anchors with real `insertAuditLog` calls)
- Modify: `apps/api/src/routes/mapping-rules.test.ts` (add 3 emission-shape assertions)

**Test (representative for POST)**

```ts
test('POST /v1/mapping-rules: emits MAPPING_RULE_CREATED with correct payload', async () => {
  const response = await fetch('/v1/mapping-rules', { method: 'POST', body: JSON.stringify(validRule), headers: signedHeaders(ADMIN_A) });
  expect(response.status).toBe(201);
  const created = await response.json();

  // Verify audit_log row was written
  const audits = await privilegedSql`
    SELECT * FROM audit_log WHERE firm_id = ${FIRM_A} AND kind = 'MAPPING_RULE_CREATED'
    ORDER BY created_at DESC LIMIT 1
  `;
  expect(audits[0].payload.rule_id).toBe(created.id);
});
```

```bash
git commit -m "feat(api): emit MAPPING_RULE_CREATED/UPDATED/ARCHIVED to audit_log"
```

---

## Theme 5 — Deferred event emissions

### Task 5.1: Add `EXPENDITURE_MAPPED` event kind

**Worktree**: `p5c`. **Theme**: 5. **Depends on**: 1.2 (claim.project_id), 2.x (audit_log writer pattern). **Effort**: ~3 hours.

**Files:**
- Modify: `packages/schemas/src/event.ts` (add to `evidenceKind` enum + add `ExpenditureMappedPayload` Zod schema)
- Modify: `packages/db/src/schema/event.ts` (add to `EVIDENCE_KINDS`)
- Create: `packages/db/migrations/0023_expenditure_mapped_kind.sql` (rebuild `event_kind_valid` CHECK)
- Modify: `packages/db/src/chain.canonical.test.ts` (add to `P4_KIND_FIXTURES` — replaces the `TODO(B9-emission)` anchor)
- Modify: `packages/db/src/chain.test.ts` (add to `P4_KIND_INSERT_FIXTURES`)

**Payload Zod**

```ts
export const ExpenditureMappedPayload = z.object({
  _v: z.literal(1),
  expenditure_id: Uuid,
  claim_id: Uuid,
  activity_id: Uuid,
  mapped_by_user_id: Uuid,
  rule_id: Uuid.optional(),  // present if auto-applied via apply-rules
});
```

**Test**: round-trip an `EXPENDITURE_MAPPED` event through `insertEventWithChain` + `verifyChain`.

```bash
git commit -m "feat(schemas,db): add EXPENDITURE_MAPPED event kind + canonicaliser coverage"
```

---

### Task 5.2: Add `EXPENDITURE_APPORTIONED` event kind

**Worktree**: `p5c`. **Theme**: 5. **Depends on**: 5.1. **Effort**: ~3 hours.

Mirror 5.1 exactly. Payload:

```ts
export const ExpenditureApportionedPayload = z.object({
  _v: z.literal(1),
  expenditure_id: Uuid,
  claim_id: Uuid,
  allocations: z.array(z.object({ activity_id: Uuid, percentage: z.number().positive() })).min(1),
  apportioned_by_user_id: Uuid,
}).refine(d => Math.abs(d.allocations.reduce((s, a) => s + a.percentage, 0) - 100) <= 0.001, {
  message: 'allocations must sum to 100% (±0.001)',
});
```

```bash
git commit -m "feat(schemas,db): add EXPENDITURE_APPORTIONED event kind + canonicaliser coverage"
```

---

### Task 5.4: Apply-rules endpoint

**Worktree**: `p5c`. **Theme**: 5. **Depends on**: 5.1, 5.2. **Effort**: ~6 hours.

**Files:**
- Create: `apps/api/src/routes/apply-rules.ts` (sibling to `preview-rules.ts`)
- Create: `apps/api/src/routes/apply-rules.test.ts` (mirror `preview-rules.test.ts` shape; 12+ tests)
- Modify: `apps/api/src/app.ts` (register the new routes)

**Endpoints:**
- `POST /v1/expenditures/:id/apply-rules` (single)
- `POST /v1/claims/:id/apply-rules` (batch)

**Handler shape (single):**

```ts
// 1. Auth + role gate (admin/consultant)
// 2. sql.begin with current_tenant_id + current_firm_id
// 3. Load expenditure (defense-in-depth AND tenant_id)
// 4. Load enabled rules for the firm
// 5. Build ExpenditureForRules
// 6. const matches = applyRules(rules, expenditure)
// 7. For each match in priority order:
//    - if action.type === 'map_to_activity': insertEventWithChain({ kind: 'EXPENDITURE_MAPPED', payload: {...}})
//    - if action.type === 'apportion': insertEventWithChain({ kind: 'EXPENDITURE_APPORTIONED', payload: {...}})
//    - if action.type === 'flag_for_review': skip with reason
// 8. Return { matched, emitted: [{kind, event_id}], skipped: [{rule_id, reason}] }
```

**Critical test cases (12+ total):**
- 200 happy: 1 expenditure + 1 matching rule → 1 EXPENDITURE_MAPPED event written
- 200 apportion: 1 expenditure + 1 apportion-rule → 1 EXPENDITURE_APPORTIONED event written, allocations sum=100
- 200 flag: 1 expenditure + 1 flag_for_review-rule → skipped, no event
- 200 batch happy: 3 expenditures + 1 rule matching all → 3 events written
- 200 batch truncated: BATCH_CAP+1 expenditures → truncated=true
- 500 InvalidRuleError: rule with apportion sum=87 in DB → 500 with error.name in body
- 401 unauth, 403 viewer-write, 404 cross-firm (TENANT_B positive control), 404 nonexistent

```bash
git commit -m "feat(api): apply-rules endpoint emits EXPENDITURE_MAPPED/APPORTIONED events"
```

---

## Theme 3 — Types relocation

### Task 3.1: Move B9's inlined types to `@cpa/schemas`

**Worktree**: `p5d`. **Theme**: 3. **Depends on**: none (purely structural). **Effort**: ~1 hour.

**Files:**
- Create: `packages/schemas/src/mapping-rule.ts` (move `MappingRule`, `RuleCondition`, `RuleAction` types here; verify against B8's `packages/integrations/src/xero-accounting/mapping-rules/types.ts` for byte-identity)
- Modify: `packages/db/src/schema/mapping_rule.ts` (replace inline duplicate with `import type { MappingRule, RuleCondition, RuleAction } from '@cpa/schemas/mapping-rule'`)
- Modify: `packages/integrations/src/xero-accounting/mapping-rules/types.ts` (remove the canonical types; re-export from `@cpa/schemas`)
- Modify: `packages/db/README.md` (document the cycle constraint that drove this)

**Test**: typecheck across all 12 packages must pass; `pnpm -r typecheck` clean.

```bash
git commit -m "refactor(schemas,db,integrations): consolidate mapping-rule types into @cpa/schemas"
```

---

## Theme 6 — Spec/docs

### Task 6.1: Spec doc taxonomy verification

**Worktree**: `p5d`. **Theme**: 6. **Depends on**: PR #4 merged. **Effort**: ~30 minutes.

**Files:** any spec doc(s) referencing the old `RESULT/EVALUATION/CONCLUSION` evidence kind names.

**Steps**:
1. `grep -rn "RESULT\|EVALUATION\|CONCLUSION" docs/ --include="*.md"`
2. Replace each occurrence with the canonical `OBSERVATION/NEW_KNOWLEDGE/ITERATION` per `apps/web/src/lib/summarise-event.ts`'s switch.
3. Verify no source code references the old names.

```bash
git commit -m "docs: align spec evidence-kind names to canonical taxonomy"
```

---

### Task 6.2: Inline comments on `'manual'` source mapping

**Worktree**: `p5d`. **Theme**: 6. **Depends on**: PR #4 merged + p4b/p4c merged. **Effort**: ~15 minutes.

**Files:**
- Modify: `apps/api/src/routes/preview-rules.ts:149-150`
- Modify: `apps/api/src/routes/claim-pdf.ts` (the source-classification helper; line numbers may shift after PR merge)

Add a comment block in each, identical:

```ts
// 'manual' source maps to 'RECEIPT' kind. This was reconciled across
// swimlanes during the P4 merge — see docs/decisions/0006-p4-merge-plan.md
// section 4.1. The rationale: manual entries are user-captured proof
// (closer to a receipt than a vendor-issued invoice). Both this file
// and claim-pdf.ts must agree.
```

```bash
git commit -m "docs(api): inline comments documenting 'manual' source mapping convention"
```

---

## Theme 7 — Polish

### Task 3.2: `LIST_PAGE_SIZE` constant

**Worktree**: `p5d`. **Theme**: 7. **Depends on**: none. **Effort**: ~1 hour.

**Files:**
- Modify: `packages/schemas/src/event.ts` (add `export const LIST_PAGE_SIZE = 200;`)
- Modify: every site that uses `limit: 200` literal — grep `grep -rn "limit: 200\b"`. Expected: register page (`apps/web/src/app/claims/[claim_id]/activities/[activity_id]/register/page.tsx`), consultant feed (`apps/web/src/app/subject-tenants/[id]/_components/filter-tabs.tsx`), and 1-2 others.
- Modify: each `.max(200)` in Zod schemas (replace literal with `LIST_PAGE_SIZE`).

**Test**: typecheck + grep `"limit: 200"` returns zero matches.

```bash
git commit -m "refactor: extract LIST_PAGE_SIZE = 200 constant in @cpa/schemas"
```

---

### Task 7.2: Zombie skip backport

**Worktree**: `p5d`. **Theme**: 7. **Depends on**: none. **Effort**: ~1 hour.

**Files:**
- Search: `grep -rn "test\.skip\|describe\.skip\|it\.skip" apps/ packages/ --include="*.ts" --include="*.tsx"`
- For each surviving `test.skip`, ensure it has either an issue link or a re-test trigger (per the policy A9 added to `apps/web/e2e/README.md`).
- Create: `SKIP-POLICY.md` at repo root if absent — short, ≤30 lines, explaining the rule and citing A9's `f111458` as precedent.

```bash
git commit -m "docs(repo): add SKIP-POLICY enforcing test.skip tracking rule"
```

---

### Task 7.1 (CONDITIONAL): `ReportDocumentLayout` extraction

**Trigger**: only execute if a 4th `<Document><Page>` caller appears in `packages/documents/src/` during P5. Otherwise SKIP.

**If triggered**: extract `ReportDocumentLayout` per the JSDoc in `packages/documents/src/pdf-base.tsx:63-72`. Refactor A8, C7, C9 (and the 4th caller) to consume it. Verify all existing PDF tests still pass.

```bash
git commit -m "refactor(documents): extract ReportDocumentLayout (3+ caller convergence)"
```

---

## Retrospective task (end of P5)

After all themes land, write `docs/retros/2026-XX-XX-p5-retro.md` capturing:
- Items delivered vs descoped (against `docs/decisions/0007-p4-followups.md` from `C:\tmp\p5-docs\`)
- Lessons learned (e.g. how the `audit_log` RLS positive-control test pattern worked, any cross-swimlane findings)
- P6 inheritance points (anything left for AI classification phase)

```bash
git commit -m "docs(retros): P5 retrospective"
```

---

## Risk register (carried from design doc Section 4.2)

See `docs/plans/2026-04-30-p5-design.md` Section 4.2. The highest-leverage risks for this implementation:

1. **`audit_log` RLS regression** (low/high) — Task 2.1's positive-control test is mandatory before 2.4's writer goes live.
2. **Migration ordering collision** if other PRs land on main during P5 — daily rebase check; idx numbers reserved at dispatch.
3. **`app.current_firm_id` GUC plumbing missing** — Task 2.1 step 5 must be verified with a "GUC unset → query returns no rows" test.

---

## Sequencing checklist (controller follows this order)

1. Parallel dispatch: 1.1, 1.2, 1.3, 4.1, 4.3, 6.1, 7.2, 3.2, 3.1
2. After 1.1 lands: dispatch 4.2
3. Single-stream Theme 2: 2.1 → 2.2 → 2.3 → 2.4 (one at a time, verify each)
4. After 1.2 + 2.x land: dispatch 5.1, then 5.2
5. After 5.1, 5.2 land: dispatch 5.4
6. After PR #4 + p4b + p4c merged: dispatch 6.2 (line numbers stable)
7. Conditional 7.1 (only if triggered)
8. Retrospective at end

Each task uses Approach A: implementer dispatch → reviewer dispatch → fix loop → merge.
