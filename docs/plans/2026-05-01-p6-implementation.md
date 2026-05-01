# P6 Implementation Plan — AI Co-Author Suite

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land all P6 items per the design at `docs/plans/2026-05-01-p6-design.md`: three velocity-tiered AI agents reading the event chain (A=expenditure classifier, B=activity register synthesizer, C=streaming narrative drafter with section-regen), bundled retro items #1 (chain.ts double-cast cleanup) and #2 (mapping_rule scalar-string backfill), eval CI framework, staged rollout.

**Architecture:** Approach (3) velocity-tiered hybrid: A=auto-batch pg-boss job, B=manual-trigger pg-boss job, C=HTTP+SSE with structured tool-use streaming. δ hybrid audit-anchoring (typed `prose` vs `claim` segments with server-side citation validation). Per-section narrative versioning in `narrative_draft` + `narrative_draft_version`. Migrations 0026–0033 reserved.

**Tech Stack:** TypeScript 5.x, postgres-js 3.4.9, drizzle-orm, Fastify (SSE), Zod, node:test, pg-boss, Anthropic SDK (`@anthropic-ai/sdk`), Claude Haiku 4.5 (Agent A), Claude Sonnet 4.5 (Agents B and C), `@cpa/agents` runtime (existing), Grafana Cloud OTLP (telemetry).

**Prerequisite:** PR #13 (P6 design doc) must merge to `main` before any P6 implementation work begins. Worktrees `p6a`/`p6b`/`p6c`/`p6d`/`p6e` cut from updated `main`.

---

## Worktree allocation

| Worktree | Branch | Themes | Sequencing |
| --- | --- | --- | --- |
| `p6a` | `p6a/foundation` | Theme 0 (chain.ts cleanup) + Theme 1 (migrations 0026-0030) + Theme 2 (cross-cutting infra) | Ships first — foundational |
| `p6b` | `p6b/agent-classifier` | Theme 3 (Agent A — expenditure classifier) | Parallel with p6c, after p6a merges |
| `p6c` | `p6c/agent-synthesizer` | Theme 4 (Agent B — register synthesizer) | Parallel with p6b, after p6a merges |
| `p6d` | `p6d/agent-narrative` | Theme 5 (Agent C — narrative drafter, the largest) | After p6b + cross-cutting infra; consumes prompt-registry + SSE patterns |
| `p6e` | `p6e/eval-rollout` | Theme 6 (retro item #2 backfill) + Theme 7 (eval CI) + Theme 8 (rollout flags) + Theme 9 (retrospective) | After all agents merge |

---

## Theme 0 — Foundational cleanup (must land first on p6a)

### Task 0.1: chain.ts jsonb double-cast (retro item #1)

**Worktree:** `p6a`. **Theme:** 0. **Depends on:** none. **Effort:** ~1 hour.

**Why first:** every new jsonb writer P6 ships uses the `${JSON.stringify(value)}::text::jsonb` pattern (per the audit-log writer JSDoc on `main`). `chain.ts` is the only remaining single-cast holdout. Cleanup must land before new agents start emitting events on the chain so we don't introduce more debt.

**Files:**

- Create: `packages/db/migrations/0031_chain_jsonb_doublecast.sql` (no-op placeholder migration; the actual fix is in `chain.ts` source — migration exists only to reserve the idx slot)
- Modify: `packages/db/src/chain.ts:133` — switch single-cast to double-cast
- Modify: `packages/db/migrations/meta/_journal.json` — append idx 31

**Step 1: Write the failing test** (in `packages/db/src/chain.test.ts`, additive)

```ts
test('insertEventWithChain stores payload as jsonb object (not scalar string) under sql client', async () => {
  // Reproduces the latent bug: under sql (drizzle-mutated), the old single-cast
  // form stored payloads as jsonb scalar strings. After the fix, jsonb_typeof
  // should report 'object'.
  const { sql } = await import('./client.js');
  const tenantId = TENANT_A;
  const subjectTenantId = SUBJECT_A1;
  await insertEventWithChain({
    tenant_id: tenantId,
    subject_tenant_id: subjectTenantId,
    kind: 'HYPOTHESIS',
    payload: { _v: 1, source: 'test', text: 'fixture text' },
    classification: null,
    captured_at: new Date('2026-05-01T00:00:00Z'),
    captured_by_user_id: ADMIN_USER,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  });
  const rows = await sql<{ typeof_payload: string }[]>`
    SELECT jsonb_typeof(payload) AS typeof_payload
      FROM event
     WHERE subject_tenant_id = ${subjectTenantId}
     ORDER BY captured_at DESC
     LIMIT 1
  `;
  assert.equal(rows[0]!.typeof_payload, 'object', 'payload must be a jsonb object, not a scalar string');
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @cpa/db test --test-name-pattern "stores payload as jsonb object"
# Expected: FAIL — typeof_payload is 'string' under the existing single-cast form
```

**Step 3: Apply the source fix at `packages/db/src/chain.ts:133`**

```diff
-    ${JSON.stringify(input.payload)}::jsonb,
+    ${JSON.stringify(input.payload)}::text::jsonb,
```

Same for the `classification` column on the next line.

**Step 4: Add the placeholder migration**

```sql
-- packages/db/migrations/0031_chain_jsonb_doublecast.sql
-- Hand-authored placeholder migration. The actual fix lives in
-- packages/db/src/chain.ts (single-cast -> double-cast on jsonb binds).
-- This file exists only to reserve idx 31 in the journal so subsequent
-- P6 migrations have a stable numbering anchor.
SELECT 1;  -- intentional no-op
```

**Step 5: Append journal entry**

```jsonc
{ "idx": 31, "version": "7", "when": <now-ms>, "tag": "0031_chain_jsonb_doublecast", "breakpoints": true }
```

**Step 6: Re-run test to verify pass + confirm no regressions**

```bash
pnpm --filter @cpa/db test
# Expected: PASS — including all existing chain-canonical tests (no event-hash drift since the on-disk shape changes from {jsonb-scalar-string} to {jsonb-object} which the canonicaliser ignores; spot-check via chain.canonical.test.ts)
```

**Step 7: Commit**

```bash
git add packages/db/migrations/0031_chain_jsonb_doublecast.sql packages/db/migrations/meta/_journal.json packages/db/src/chain.ts packages/db/src/chain.test.ts
git commit -m "fix(db): chain.ts insertEventWithChain uses ::text::jsonb double-cast (retro item #1)"
```

---

## Theme 1 — Migrations + schema parity (p6a)

### Task 1.1: Migration 0026 — `EXPENDITURE_CLASSIFIED` event kind

**Worktree:** `p6a`. **Theme:** 1. **Depends on:** Task 0.1. **Effort:** ~1 hour.

**Files:**

- Create: `packages/db/migrations/0026_expenditure_classified_kind.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append idx 26)
- Modify: `packages/db/src/schema/event.ts` (append to `EVIDENCE_KINDS`)
- Modify: `packages/schemas/src/event.ts` (append to `evidenceKind` enum + add Zod payload `ExpenditureClassifiedPayload`)
- Test: `packages/db/src/migrations.test.ts` (add round-trip test)

**Step 1: Write failing test**

```ts
test('migration 0026: event_kind_valid CHECK admits EXPENDITURE_CLASSIFIED', async () => {
  await privilegedSql`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
  // Inserting a row with kind='EXPENDITURE_CLASSIFIED' must succeed post-migration.
  const eventId = '00000000-0000-4000-8000-00006a000026';
  await privilegedSql`
    INSERT INTO event (
      id, tenant_id, subject_tenant_id, kind, payload, hash, captured_at, captured_by_user_id
    ) VALUES (
      ${eventId}, ${TENANT_ID}, ${SUBJECT_ID}, 'EXPENDITURE_CLASSIFIED',
      ${{
        _v: 1,
        expenditure_id: '00000000-0000-4000-8000-000000abc001',
        decision: 'eligible',
        eligibility_probability: 0.92,
        statutory_anchor: 's.355-25',
        suggested_activity_id: null,
        rationale: 'unit test fixture',
        uncertainty_reason: null,
        model: 'claude-haiku-4-5',
        prompt_version: 'classify-expenditure@1.0.0',
        idempotency_key: 'fixture-key',
      }}::text::jsonb,
      ${'a6'.padEnd(64, '0')}, '2026-05-01T00:00:00Z', ${ADMIN_USER}
    )
  `;
  const rows = await privilegedSql<{ id: string }[]>`SELECT id FROM event WHERE id = ${eventId}`;
  assert.equal(rows.length, 1);
});
```

**Step 2: Run test to confirm fail**

```bash
pnpm --filter @cpa/db test --test-name-pattern "migration 0026"
# Expected: FAIL — CHECK violation on event_kind_valid (EXPENDITURE_CLASSIFIED not in list)
```

**Step 3: Migration**

```sql
-- packages/db/migrations/0026_expenditure_classified_kind.sql
-- Adds EXPENDITURE_CLASSIFIED to the event_kind_valid CHECK constraint.
-- Mirrors the DROP+ADD pattern from 0014, 0015, 0023, 0024, 0025.
ALTER TABLE "event" DROP CONSTRAINT IF EXISTS "event_kind_valid";
ALTER TABLE "event" ADD CONSTRAINT "event_kind_valid" CHECK (
  "kind" IN (
    'HYPOTHESIS', 'DESIGN', 'EXPERIMENT', 'OBSERVATION', 'ITERATION',
    'NEW_KNOWLEDGE', 'UNCERTAINTY', 'TIME_LOG', 'ASSOCIATE_FLAG',
    'EXPENDITURE_NOTE', 'SUPPORTING', 'INELIGIBLE', 'OVERRIDE',
    'ACTIVITY_CREATED', 'ACTIVITY_UPDATED', 'ACTIVITY_LOCKED',
    'ARTEFACT_LINKED', 'ARTEFACT_UNLINKED',
    'EXPENDITURE_INGESTED', 'EXPENDITURE_LINE_MAPPED',
    'EXPENDITURE_LINE_UNMAPPED', 'EXPENDITURE_VOIDED',
    'CLAIM_STAGE_ADVANCED', 'CLAIM_SUBMITTED',
    'PROJECT_CREATED', 'PROJECT_ARCHIVED', 'PROJECT_UPDATED',
    'DOCUMENT_GENERATED',
    'EXPENDITURE_MAPPED', 'EXPENDITURE_APPORTIONED',
    'EXPENDITURE_CLASSIFIED'
  )
);
```

**Step 4: Drizzle schema parity** — append `'EXPENDITURE_CLASSIFIED'` to `EVIDENCE_KINDS` const in `packages/db/src/schema/event.ts`. Update the JSDoc comment block to reference 0026.

**Step 5: Schemas package parity** — append to `evidenceKind` enum in `packages/schemas/src/event.ts`. Add new exported Zod schema:

```ts
export const ExpenditureClassifiedPayload = z.object({
  _v: z.literal(1),
  expenditure_id: Uuid,
  decision: z.enum(['eligible', 'ineligible', 'needs_review']),
  eligibility_probability: z.number().min(0).max(1),
  statutory_anchor: z.enum(['s.355-25', 's.355-30', 'ineligible']),
  suggested_activity_id: Uuid.nullable(),
  rationale: z.string().min(1).max(800),
  uncertainty_reason: z.string().max(500).nullable(),
  model: z.string().min(1),
  prompt_version: z.string().min(1),
  idempotency_key: z.string().min(1),
});
export type ExpenditureClassifiedPayload = z.infer<typeof ExpenditureClassifiedPayload>;
```

**Step 6: Append journal entry** for idx 26.

**Step 7: Run test to confirm pass**

```bash
pnpm --filter @cpa/db test --test-name-pattern "migration 0026"
# Expected: PASS
pnpm -r typecheck && pnpm --filter @cpa/api lint
# Expected: clean
```

**Step 8: Commit**

```bash
git commit -m "feat(db,schemas): add EXPENDITURE_CLASSIFIED event kind (P6 Agent A target)"
```

### Task 1.2: Migration 0027 — `ACTIVITY_REGISTER_DRAFTED` event kind

Mirror Task 1.1 with these substitutions:

- Migration filename: `0027_activity_register_drafted_kind.sql`. Append `'ACTIVITY_REGISTER_DRAFTED'` to the CHECK list.
- New Zod payload `ActivityRegisterDraftedPayload` plus shared `ProposedActivity`:

```ts
export const ProposedActivity = z.object({
  proposed_id: Uuid,
  name: z.string().min(1).max(200),
  kind: z.enum(['core', 'supporting']),
  statutory_anchor: z.enum(['s.355-25', 's.355-30']),
  rationale: z.string().min(1).max(2000),
  clustered_event_ids: z.array(Uuid).min(1),
  confidence: z.number().min(0).max(1),
  proposed_hypothesis: z.string().max(1500).nullable(),
  proposed_uncertainty: z.string().max(1500).nullable(),
});
export type ProposedActivity = z.infer<typeof ProposedActivity>;

export const ActivityRegisterDraftedPayload = z.object({
  _v: z.literal(1),
  project_id: Uuid,
  proposed_activities: z.array(ProposedActivity),
  unclustered_event_ids: z.array(Uuid),
  total_input_events: z.number().int().nonnegative(),
  events_truncated: z.boolean(),
  synthesizer_notes: z.string().max(3000),
  model: z.string().min(1),
  prompt_version: z.string().min(1),
  idempotency_key: z.string().min(1),
});
```

Same TDD/commit pattern. Commit message: `feat(db,schemas): add ACTIVITY_REGISTER_DRAFTED event kind (P6 Agent B target)`.

### Task 1.3: Migration 0028 — `NARRATIVE_DRAFTED` event kind

Mirror Task 1.1 with `'NARRATIVE_DRAFTED'`. New payload:

```ts
export const NarrativeDraftedPayload = z.object({
  _v: z.literal(1),
  narrative_draft_id: Uuid,
  activity_id: Uuid,
  section_kind: z.enum(['new_knowledge', 'hypothesis', 'uncertainty', 'experiments_and_results']),
  version: z.number().int().positive(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().min(1),
  prompt_version: z.string().min(1),
  segment_count: z.number().int().nonnegative(),
  claim_segment_count: z.number().int().nonnegative(),
  idempotency_key: z.string().min(1),
});
```

Also add the shared `NarrativeSegment` discriminated union:

```ts
export const NarrativeSegment = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prose'), text: z.string().min(1).max(2000) }),
  z.object({
    type: z.literal('claim'),
    text: z.string().min(1).max(2000),
    citing_events: z.array(Uuid).min(1),
  }),
]);
export type NarrativeSegment = z.infer<typeof NarrativeSegment>;
```

Commit message: `feat(db,schemas): add NARRATIVE_DRAFTED event kind + NarrativeSegment shared type`.

### Task 1.4: Migration 0029 — `narrative_draft` table

**Worktree:** `p6a`. **Theme:** 1. **Depends on:** 1.3. **Effort:** ~3 hours.

**Files:**

- Create: `packages/db/migrations/0029_narrative_draft.sql`
- Create: `packages/db/src/schema/narrative_draft.ts`
- Modify: `packages/db/src/schema/index.ts` (re-export)
- Modify: `packages/db/migrations/meta/_journal.json` (idx 29)
- Test: `packages/db/src/migrations.test.ts` (round-trip insert + RLS positive control)

**Step 1: Failing test**

```ts
test('migration 0029: narrative_draft table exists with RLS isolation', async () => {
  // Column existence + tenant isolation positive control mirrors the audit_log
  // pattern from P5 Task 2.1. RLS policy uses NULLIF-wrapped GUC.
  const cols = await privilegedSql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'narrative_draft'
     ORDER BY ordinal_position
  `;
  const expected = [
    'tenant_id', 'id', 'activity_id', 'section_kind', 'current_version',
    'status', 'segments', 'content_hash', 'model', 'prompt_version',
    'idempotency_key', 'created_at', 'updated_at', 'created_by_user_id',
  ];
  assert.deepEqual(cols.map((c) => c.column_name), expected);

  // RLS positive control: TENANT_A session can't read TENANT_B rows.
  const draftA = '00000000-0000-4000-8000-00006a002901';
  const draftB = '00000000-0000-4000-8000-00006a002902';
  await privilegedSql`/* seed activity rows + draft rows for both tenants */`;  // detail in implementation
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
    return tx<{ id: string }[]>`SELECT id FROM narrative_draft`;
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, draftA);  // TENANT_B's draft is invisible
});
```

**Step 2-7: Migration + drizzle schema + journal + test pass + commit.** Migration body per design doc Section 2 verbatim. Drizzle schema follows the `audit_log.ts` pattern from P5 with `pgTable`, RLS-aware column types, and a `(tenant_id, activity_id, section_kind)` unique index. Commit: `feat(db): narrative_draft table + RLS + drizzle schema (P6 Agent C storage)`.

### Task 1.5: Migration 0030 — `narrative_draft_version` table

Mirror Task 1.4 with the `narrative_draft_version` schema from design doc Section 2. Append-only — `GRANT SELECT, INSERT` to `cpa_app` (no UPDATE/DELETE; same pattern as `audit_log`). Commit: `feat(db): narrative_draft_version table + RLS (append-only history for P6 Agent C)`.

---

## Theme 2 — Cross-cutting infrastructure (p6a)

### Task 2.1: SSE utility

**Worktree:** `p6a`. **Theme:** 2. **Depends on:** none (parallel with Theme 1). **Effort:** ~2 hours.

**Files:**

- Create: `apps/api/src/lib/sse.ts`
- Test: `apps/api/src/lib/sse.test.ts`

**Step 1-7:** Write failing test using Fastify's inject API to verify SSE headers are set, multiple events flush correctly, abort handler fires on close. Implement the helper per design doc Section 6 SSE Infrastructure. Commit: `feat(api): SSE utility for streaming endpoints (P6 Agent C foundation)`.

### Task 2.2: Pricing constants + cost telemetry

**Worktree:** `p6a`. **Theme:** 2. **Depends on:** none. **Effort:** ~1 hour.

**Files:**

- Create: `packages/agents/src/runtime/pricing.ts`
- Test: `packages/agents/src/runtime/pricing.test.ts`
- Modify: `packages/agents/src/runtime/telemetry.ts` (extend `withAgentSpan` to record `agent.cost_usd`)

```ts
// pricing.ts
export const MODEL_PRICING = {
  'claude-haiku-4-5': { input_per_mtok: 0.25, output_per_mtok: 1.25 },
  'claude-sonnet-4-5': { input_per_mtok: 3.0, output_per_mtok: 15.0 },
} as const;

export function computeCost(model: string, tokens_in: number, tokens_out: number): number {
  const pricing = MODEL_PRICING[model as keyof typeof MODEL_PRICING];
  if (!pricing) return 0;  // unknown model — telemetry shows 0; ops sees "missing pricing" alert
  return (tokens_in * pricing.input_per_mtok + tokens_out * pricing.output_per_mtok) / 1_000_000;
}
```

Commit: `feat(agents): pricing table + computeCost helper for telemetry`.

### Task 2.3: Per-(tenant, agent) rate limit

**Worktree:** `p6a`. **Theme:** 2. **Depends on:** none. **Effort:** ~2 hours.

**Files:**

- Create: `packages/agents/src/runtime/rate-limit.ts`
- Test: `packages/agents/src/runtime/rate-limit.test.ts`

In-memory token bucket per `(tenant_id, agent)` keyed pair. Default: 100 calls/min per (tenant, agent). Overridable via env. Commit: `feat(agents): per-(tenant,agent) token-bucket rate limit`.

### Task 2.4: Feature flag env vars

**Worktree:** `p6a`. **Theme:** 2. **Depends on:** none. **Effort:** ~1 hour.

**Files:**

- Modify: `packages/agents/src/runtime/env.ts` (or create if missing)
- Modify: `.env.example` — add `P6_AGENT_A_ENABLED`, `P6_AGENT_B_ENABLED`, `P6_AGENT_C_ENABLED`, `P6_AGENT_C_STREAMING_ENABLED`, `P6_AGENT_TENANT_ALLOWLIST`
- Modify: `scripts/bootstrap.sh` + `scripts/bootstrap.ps1` — same vars in the generated `.env` template
- Test: `packages/agents/src/runtime/env.test.ts`

Helpers:

```ts
export function isAgentEnabled(agent: 'A' | 'B' | 'C'): boolean { ... }
export function isTenantAllowed(tenantId: string): boolean { ... }
```

Commit: `feat(agents): feature flag env vars for staged rollout`.

### Task 2.5: Open PR for p6a

After Tasks 0.1, 1.1-1.5, 2.1-2.4 are committed and pushed, open PR titled `feat(p6-foundation): migrations 0026-0031 + cross-cutting infra` against `main`. Include note that Themes 3-7 land in subsequent PRs. CI must pass before agent worktrees rebase onto the merge.

---

## Theme 3 — Agent A: expenditure classifier (p6b — parallel with p6c)

### Task 3.1: Prompt module `classify-expenditure@1.0.0.ts`

**Worktree:** `p6b`. **Theme:** 3. **Depends on:** Theme 1 (p6a merged). **Effort:** ~2 hours.

**Files:**

- Create: `packages/agents/src/classifier-expenditure/prompts/classify-expenditure@1.0.0.ts`
- Create: `packages/agents/src/classifier-expenditure/types.ts`
- Test: `packages/agents/src/classifier-expenditure/prompts/classify-expenditure@1.0.0.test.ts`

Mirror the `classifier/prompts/classify@1.0.0.ts` pattern: register a system prompt + tool schema. The tool schema is `ExpenditureClassifierToolInput` matching the `EXPENDITURE_CLASSIFIED` payload (minus the metadata fields the runtime injects: `model`, `prompt_version`, `idempotency_key`). System prompt must:

- Anchor the agent in s.355-25 vs s.355-30 vs ineligible per the AusIndustry framework
- Receive `expenditure`, `project`, `existing_activities`, `recent_evidence_events` as input bundle
- Return ONE call to `classify_expenditure` tool with the full output schema
- Be conservative: confidence < 0.70 must map to `decision='needs_review'` with a clear `uncertainty_reason`

Commit: `feat(agents): classify-expenditure prompt v1.0.0 + tool schema`.

### Task 3.2: Classifier interface + Haiku impl + Stub impl + factory

**Worktree:** `p6b`. **Theme:** 3. **Depends on:** 3.1. **Effort:** ~4 hours.

**Files:**

- Create: `packages/agents/src/classifier-expenditure/types.ts`, `haiku.ts`, `stub.ts`, `factory.ts`, `thresholds.ts`, `index.ts`
- Tests for each

Mirror `packages/agents/src/classifier/` structure. The Haiku impl reuses `getAnthropicClient`, `getPrompt`, `callWithToolUse`. Threshold constants:

```ts
// thresholds.ts
export const EXPENDITURE_CONFIDENCE_THRESHOLDS = {
  AUTO_APPLY: 0.85,
  REVIEW_RECOMMENDED: 0.70,
} as const;
```

Stub regex examples in `stub.ts`:

```ts
const PATTERNS: Array<[RegExp, Decision]> = [
  [/atlassian|github|stripe|aws/i, { decision: 'ineligible', anchor: 'ineligible', confidence: 0.92 }],
  [/research|laboratory|prototype|experiment/i, { decision: 'eligible', anchor: 's.355-25', confidence: 0.88 }],
  // ...
];
```

Commit: `feat(agents): expenditure classifier with Haiku + Stub impls + factory`.

### Task 3.3: Job processor `expenditure-classify`

**Worktree:** `p6b`. **Theme:** 3. **Depends on:** 3.2. **Effort:** ~4 hours.

**Files:**

- Create: `apps/api/src/jobs/expenditure-classify.ts`
- Test: `apps/api/src/jobs/expenditure-classify.test.ts`

Mirror existing `apps/api/src/jobs/audit-score-recompute.ts` for pg-boss subscriber pattern. Job batches up to 25 expenditures per invocation. For each:

1. Compute `idempotency_key`. If existing `EXPENDITURE_CLASSIFIED` event with that key exists, skip.
2. Build input bundle (expenditure + project + existing register + recent events).
3. Call `classifyExpenditure(input)` via the factory.
4. Map `decision` + `eligibility_probability` to badge severity per thresholds (force `needs_review` if confidence < 0.70).
5. Insert `EXPENDITURE_CLASSIFIED` event via `insertEventWithChain`.
6. Telemetry: `withAgentSpan('expenditure-classifier', ...)` records cost.

Commit: `feat(api): expenditure-classify pg-boss job (Agent A worker)`.

### Task 3.4: Auto-trigger hooks on `EXPENDITURE_INGESTED`

**Worktree:** `p6b`. **Theme:** 3. **Depends on:** 3.3. **Effort:** ~2 hours.

**Files:**

- Modify: `apps/api/src/jobs/xero-accounting-sync.ts` (after `EXPENDITURE_INGESTED` chain insert, enqueue an `expenditure-classify` job)
- Modify: `apps/api/src/routes/expenditures.ts` (the manual-create POST handler, same hook)
- Add tests covering both call sites

Use `pgBoss.send('expenditure-classify', { tenant_id, expenditure_ids: [...] })`. Hook is gated by `isAgentEnabled('A')` — no-op when feature flag is off.

Commit: `feat(api): auto-trigger expenditure-classify on EXPENDITURE_INGESTED`.

### Task 3.5: Manual reclassify endpoint

**Worktree:** `p6b`. **Theme:** 3. **Depends on:** 3.3. **Effort:** ~2 hours.

**Files:**

- Modify: `apps/api/src/routes/expenditures.ts` — add `POST /v1/expenditures/:id/reclassify`
- Modify: `apps/api/src/app.ts` — register the new route handler if not already covered
- Test: `apps/api/src/routes/expenditures.test.ts`

Admin/consultant only. Enqueues a single-expenditure `expenditure-classify` job synchronously (returns 202 immediately). Tests cover 401/403/404 + 202 happy path + 503 when `P6_AGENT_A_ENABLED=false`.

Commit: `feat(api): POST /v1/expenditures/:id/reclassify endpoint`.

### Task 3.6: Open PR for p6b

PR title: `feat(p6-swimlane-a): expenditure classifier — Agent A`. Body summarises what shipped + the auto-trigger + the manual override endpoint.

---

## Theme 4 — Agent B: register synthesizer (p6c — parallel with p6b)

### Task 4.1: Prompt module `synthesize-register@1.0.0.ts`

**Worktree:** `p6c`. **Theme:** 4. **Depends on:** Theme 1 (p6a merged). **Effort:** ~3 hours.

Mirror Task 3.1 structure. The system prompt must:

- Receive `project`, `events: CompressedEvent[]`, `existing_activities` as input
- Cluster events into proposed activities. Constraint: each `clustered_event_ids` array ≥ 1 event, name 5-12 words, must classify each as core (s.355-25) or supporting (s.355-30) with rationale
- Honour `existing_activities`: do NOT recluster events already accepted into a real activity
- Output up to 30 proposed activities; emit `unclustered_event_ids` for the rest
- Pre-fill `proposed_hypothesis` and `proposed_uncertainty` opportunistically (Agent C inherits them)

Tool schema mirrors `ActivityRegisterDraftedPayload`. Commit: `feat(agents): synthesize-register prompt v1.0.0 + tool schema`.

### Task 4.2: Synthesizer interface + Sonnet impl + Stub impl

**Worktree:** `p6c`. **Theme:** 4. **Depends on:** 4.1. **Effort:** ~4 hours.

Mirror Task 3.2. Sonnet impl uses model `'claude-sonnet-4-5'`. Stub impl groups events by `subject_tenant_id` and ISO week.

Commit: `feat(agents): activity register synthesizer with Sonnet + Stub impls + factory`.

### Task 4.3: Job processor `activity-register-synthesize`

**Worktree:** `p6c`. **Theme:** 4. **Depends on:** 4.2. **Effort:** ~4 hours.

**Files:**

- Create: `apps/api/src/jobs/activity-register-synthesize.ts`
- Test: `apps/api/src/jobs/activity-register-synthesize.test.ts`

Single-shot job. Reads up to 200 most-recent R&D evidence events for the project, builds input bundle, calls synthesizer, emits `ACTIVITY_REGISTER_DRAFTED` event. Sets `events_truncated: true` if input was capped.

Commit: `feat(api): activity-register-synthesize pg-boss job (Agent B worker)`.

### Task 4.4: Trigger + status endpoints

**Worktree:** `p6c`. **Theme:** 4. **Depends on:** 4.3. **Effort:** ~3 hours.

**Files:**

- Create: `apps/api/src/routes/activity-register.ts`
- Modify: `apps/api/src/app.ts` (register the new route module)
- Test: `apps/api/src/routes/activity-register.test.ts`

Endpoints:

- `POST /v1/projects/:id/activity-register/synthesize` — admin/consultant. Enqueues a job; returns 202 + `requestId`.
- `GET /v1/projects/:id/activity-register/latest` — returns the latest `ACTIVITY_REGISTER_DRAFTED` event for the project, plus a derived `status: 'pending' | 'complete' | 'none'`.

Tests: 401/403/404, 202 happy path, latest-after-synthesis returns the right event.

Commit: `feat(api): activity-register synthesize + latest endpoints`.

### Task 4.5: Acceptance endpoint

**Worktree:** `p6c`. **Theme:** 4. **Depends on:** 4.4. **Effort:** ~3 hours.

**Files:**

- Modify: `apps/api/src/routes/activity-register.ts` — add `POST .../accept`
- Tests covering acceptance with/without per-proposal edits, partial acceptance, idempotency on re-accept

Body shape per design doc Section 4. For each accepted `proposed_id`:

1. Validate the `proposed_id` exists in the latest `ACTIVITY_REGISTER_DRAFTED` for the project.
2. Apply edits (if any) over the proposed activity fields.
3. Insert real `activity` row.
4. Emit `ACTIVITY_CREATED` event (existing kind from P4 — payload includes `proposed_id` so observers can correlate).

Commit: `feat(api): POST /v1/projects/:id/activity-register/accept (Agent B accept flow)`.

### Task 4.6: Open PR for p6c

PR title: `feat(p6-swimlane-b): activity register synthesizer — Agent B`.

---

## Theme 5 — Agent C: narrative drafter (p6d — single-stream after p6b + p6a)

### Task 5.1: Prompt modules

**Worktree:** `p6d`. **Theme:** 5. **Depends on:** p6b merged (so the prompt-registry pattern is proven). **Effort:** ~5 hours.

**Files:**

- Create: `packages/agents/src/narrative-drafter/prompts/draft-narrative@1.0.0.ts`
- Create: `packages/agents/src/narrative-drafter/prompts/regenerate-section@1.0.0.ts`

`draft-narrative@1.0.0`: system prompt instructs the model to emit segments via `emit_segment` tool calls. Each segment is `{section_kind, segment_index, type, text, citing_events?}`. Prompt enforces:

- ALL claim segments MUST cite ≥1 event from `clustered_events`
- Prose segments are for definitions, statutory connectors, and pure narrative bridges — NOT factual claims
- `segment_index` is 0-based per section; sections are emitted in order: new_knowledge → hypothesis → uncertainty → experiments_and_results
- Aim for ≥30% claim-density per section

`regenerate-section@1.0.0`: extends draft-narrative with an `existing_sections` block in the prompt — model is instructed to maintain consistency with sections it's NOT editing, and to emit ONLY segments for the requested `target_section_kind`.

Commit: `feat(agents): draft-narrative + regenerate-section prompts v1.0.0`.

### Task 5.2: Segment validator (validate-and-correct loop)

**Worktree:** `p6d`. **Theme:** 5. **Depends on:** 5.1. **Effort:** ~4 hours.

**Files:**

- Create: `packages/agents/src/narrative-drafter/validate.ts`
- Test: `packages/agents/src/narrative-drafter/validate.test.ts`

```ts
export type SegmentValidation = { ok: true } | { ok: false; reason: string };

export function validateSegment(
  seg: NarrativeSegment,
  clusteredEventIds: ReadonlySet<string>,
): SegmentValidation {
  if (seg.type === 'claim') {
    if (!seg.citing_events || seg.citing_events.length === 0) {
      return { ok: false, reason: 'claim segment missing citing_events' };
    }
    for (const id of seg.citing_events) {
      if (!clusteredEventIds.has(id)) {
        return { ok: false, reason: `cites event ${id} outside this activity's clustered_events` };
      }
    }
    return { ok: true };
  }
  return { ok: true };  // prose has no validation
}
```

Test cases: claim missing citations, claim with out-of-scope citation, valid claim, valid prose, prose with unexpected citations (warn but not fail — soft-rejected at orchestrator level).

Commit: `feat(agents): segment validator for δ hybrid audit anchors`.

### Task 5.3: Content-hash canonicalization

**Worktree:** `p6d`. **Theme:** 5. **Depends on:** 5.2. **Effort:** ~2 hours.

**Files:**

- Create: `packages/db/src/narrative-canonical.ts`
- Test: `packages/db/src/narrative-canonical.test.ts`

Reuses `packages/db/src/canonical.ts` (P2's canonical-JSON helper). Canonicalises the full 4-section segments record and returns sha256. `citing_events` arrays sorted lex-ascending. Segment indices preserved.

Commit: `feat(db): narrative content-hash canonicalisation helper`.

### Task 5.4: Streaming orchestrator (Anthropic + tool-use + validate-correct loop)

**Worktree:** `p6d`. **Theme:** 5. **Depends on:** 5.2 + 5.3. **Effort:** ~8 hours (largest single task in P6).

**Files:**

- Create: `packages/agents/src/narrative-drafter/stream.ts`
- Test: `packages/agents/src/narrative-drafter/stream.test.ts` (heavy use of mocked Anthropic streaming responses)

Public surface:

```ts
export async function* streamNarrativeDraft(input: {
  activity: ActivityContext;
  project: ProjectContext;
  clustered_events: CompressedEvent[];
  prefill: { proposed_hypothesis?: string; proposed_uncertainty?: string } | null;
  existing_sections: Record<SectionKind, NarrativeSegment[]> | null;
  target_section_kinds: SectionKind[];
  abortSignal: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  // Iterates Anthropic stream, normalises each tool_use content block into a
  // Segment, runs validateSegment, on validation fail emits a "correction"
  // continuation prompt (up to 2 retries), yields validated segments.
}
```

`StreamEvent` mirrors the SSE protocol: `{type:'segment', ...}`, `{type:'section_complete'}`, `{type:'done'}`, `{type:'error'}`. Tests cover: happy path, validation correction loop fires once + succeeds, correction loop exhausted (downgrade to prose), Anthropic 5xx mid-stream, abort mid-stream.

Commit: `feat(agents): narrative-drafter streaming orchestrator with validate-and-correct loop`.

### Task 5.5: POST `/v1/activities/:id/narrative` (initial generation, SSE)

**Worktree:** `p6d`. **Theme:** 5. **Depends on:** 5.4 + Task 2.1 (SSE utility). **Effort:** ~5 hours.

**Files:**

- Create: `apps/api/src/routes/narrative.ts`
- Modify: `apps/api/src/app.ts` (register)
- Test: `apps/api/src/routes/narrative.test.ts`

Auth: admin/consultant only. Validates `clustered_events.length > 0` (refuse if activity has no events). Wires `streamNarrativeDraft` → `startSSEStream` from Task 2.1. On `done`:

1. Compute `content_hash` via Task 5.3
2. INSERT into `narrative_draft` (one row per `section_kind`, using `${JSON.stringify(segments)}::text::jsonb` for the segments column)
3. INSERT initial `narrative_draft_version` with `version=1`, `generation_kind='initial'`
4. Emit `NARRATIVE_DRAFTED` event via `insertEventWithChain` for each section (`segment_count`, `claim_segment_count`, `content_hash` per section)
5. Emit final SSE `done` event with `draft_id` + first `narrative_drafted_event_id`

Tests cover: 401/403, 400 on empty `clustered_events`, full happy path with mocked Anthropic stream, abort mid-stream, idempotency on retry with same `client_request_id`, 503 when `P6_AGENT_C_ENABLED=false`.

Commit: `feat(api): POST /v1/activities/:id/narrative SSE endpoint (Agent C initial)`.

### Task 5.6: POST `.../sections/:section_kind/regenerate`

**Worktree:** `p6d`. **Theme:** 5. **Depends on:** 5.5. **Effort:** ~4 hours.

**Files:**

- Modify: `apps/api/src/routes/narrative.ts` — add the regenerate endpoint
- Tests for: 401/403/404 (missing draft), single-section regen happy path, version-history append, parent_version lineage correctness

Server-side flow per design doc Section 5. The new `narrative_draft_version` row gets `generation_kind='section_regen'`, `parent_version=<old current_version>`. `narrative_draft.segments` jsonb gets the new segments for the regenerated section only — other sections unchanged.

Commit: `feat(api): POST .../narrative/sections/:section_kind/regenerate (Agent C section regen)`.

### Task 5.7: Stale-streaming-cleanup background job

**Worktree:** `p6d`. **Theme:** 5. **Depends on:** 5.5. **Effort:** ~2 hours.

**Files:**

- Create: `apps/api/src/jobs/narrative-stale-cleanup.ts`
- Test: `apps/api/src/jobs/narrative-stale-cleanup.test.ts`

Hourly pg-boss cron. Finds `narrative_draft` rows where `status='streaming'` AND `updated_at < now() - interval '10 min'`; flips them to `status='complete'` (we keep whatever segments we got).

Commit: `feat(api): hourly stale-streaming-cleanup job for narrative drafts`.

### Task 5.8: Web rendering — segments → footnotes

**Worktree:** `p6d`. **Theme:** 5. **Depends on:** 5.5. **Effort:** ~4 hours.

**Files:**

- Create: `apps/web/src/lib/narrative/render.tsx`
- Create: `apps/web/src/lib/narrative/render.test.tsx`
- Create: `apps/web/src/lib/narrative/EventCitation.tsx`

Per design doc Section 5 UI rendering. Footnote markers `[1] [2]` superscript per claim segment; per-section evidence ledger at the bottom; `<EventCitation eventId>` card with hover preview.

Commit: `feat(web): narrative segment renderer with footnote-style citations`.

### Task 5.9: Open PR for p6d

PR title: `feat(p6-swimlane-c): narrative drafter — Agent C with streaming + section regen`.

---

## Theme 6 — Bundled retro item #2 (p6e)

### Task 6.1: Migration 0032 — mapping_rule scalar-string backfill

**Worktree:** `p6e`. **Theme:** 6. **Depends on:** Themes 3+4 merged (so any new mapping_rule rows use the correct double-cast). **Effort:** ~2 hours.

**Files:**

- Create: `packages/db/migrations/0032_mapping_rule_scalar_string_backfill.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (idx 32)
- Test: `packages/db/src/migrations.test.ts`

```sql
-- 0032_mapping_rule_scalar_string_backfill.sql
-- Idempotent backfill: re-encodes mapping_rule.conditions and mapping_rule.action
-- rows that were stored as jsonb scalar STRINGS (a latent bug under the
-- pre-fix drizzle-mutated single-cast pattern from PR #5 era).
--
-- WHY: any mapping_rule rows created by apps/api/src/routes/mapping-rules.ts
-- between PR #5 (B9) and the e83ab08 fix on PR #9 (P5b) stored their
-- conditions and action as jsonb scalar STRINGS rather than jsonb
-- OBJECTS/ARRAYS. The runtime tolerates both shapes (because postgres-js
-- parses scalar strings back into JS strings, and B8's evaluate.ts
-- silently no-ops on string conditions), but B10's apply-rules path
-- and P6's downstream classifier consumers will trip on them. Re-encode
-- here so all rows are uniformly jsonb objects/arrays.
--
-- IDEMPOTENT: rows already in the correct shape (jsonb_typeof IN
-- ('object','array')) are skipped via the WHERE filter.

UPDATE mapping_rule
   SET conditions = (conditions #>> '{}')::jsonb
 WHERE jsonb_typeof(conditions) = 'string';

UPDATE mapping_rule
   SET action = (action #>> '{}')::jsonb
 WHERE jsonb_typeof(action) = 'string';
```

Test: insert two scalar-string rows pre-migration, run the migration, assert `jsonb_typeof` is now `'array'` and `'object'` respectively. Run again — should be no-op.

Commit: `fix(db): backfill mapping_rule scalar-string rows (retro item #2)`.

---

## Theme 7 — Eval framework + golden datasets (p6e)

### Task 7.1: Eval framework skeleton

**Worktree:** `p6e`. **Theme:** 7. **Depends on:** Themes 3+4+5 merged. **Effort:** ~4 hours.

**Files:**

- Create: `packages/agents/eval/run.ts` (shared runner)
- Create: `packages/agents/eval/scoring.ts` (F1, Jaccard, structural validators)
- Create: `packages/agents/eval/expenditure-classifier/{golden.ndjson, run.ts}`
- Create: `packages/agents/eval/register-synthesizer/{golden.ndjson, run.ts}`
- Create: `packages/agents/eval/narrative-drafter/{golden.ndjson, run.ts}`
- Modify: `packages/agents/package.json` — add eval scripts

Each `run.ts` reads its `golden.ndjson`, calls the agent under test (using `EVAL_ANTHROPIC_API_KEY`), scores results, writes a structured report to stdout (JSON) + a human summary (table).

Commit: `feat(agents): eval framework + scoring helpers`.

### Task 7.2: Golden datasets

**Worktree:** `p6e`. **Theme:** 7. **Depends on:** 7.1. **Effort:** ~6 hours (most of this is data labour).

Hand-craft synthetic + dogfood-derived examples:

- Expenditure classifier: 50 rows (mix of clearly eligible, clearly ineligible, ambiguous; covers AusIndustry edge cases)
- Register synthesizer: 10 projects with 30-150 events each + a hand-curated "expected" activity register
- Narrative drafter: 20 (activity, expected_section_kinds_present, expected_min_claim_count) tuples

Datasets are anonymised — NO real customer data. Synthetic + public examples only.

Commit: `feat(agents): golden eval datasets for A/B/C`.

### Task 7.3: GitHub Actions workflow `agent-eval.yml`

**Worktree:** `p6e`. **Theme:** 7. **Depends on:** 7.1 + 7.2. **Effort:** ~2 hours.

**Files:**

- Create: `.github/workflows/agent-eval.yml`

Triggers: prompt-PRs (path filter `packages/agents/src/**/prompts/**`) + nightly cron `'0 3 * * *'`. Uses `EVAL_ANTHROPIC_API_KEY` GitHub secret. Fails open with warning if budget exhausted.

Commit: `ci(agents): agent-eval workflow on prompt-PRs + nightly`.

---

## Theme 8 — Staged rollout (p6e — sequential)

### Task 8.1: Phase-1 dogfood enable

**Worktree:** `p6e`. **Theme:** 8. **Depends on:** all prior themes merged. **Effort:** ~30 min.

Set `P6_AGENT_*_ENABLED=true` in production env. Set `P6_AGENT_TENANT_ALLOWLIST=<dogfood-tenant-id>`. Deploy. Soak for 1 week.

### Task 8.2: Phase-2 friendly firms

**Worktree:** `p6e`. **Theme:** 8. **Depends on:** Phase 1 soak clean. **Effort:** ~30 min.

Add 3 friendly customer tenant_ids to `P6_AGENT_TENANT_ALLOWLIST`. Soak for 1 week.

### Task 8.3: Phase-3 all firms

**Worktree:** `p6e`. **Theme:** 8. **Depends on:** Phase 2 soak clean. **Effort:** ~30 min.

Empty the allowlist (`P6_AGENT_TENANT_ALLOWLIST=`) so all tenants get the agents.

---

## Theme 9 — Retrospective (p6e)

### Task 9.1: P6 retrospective

**Worktree:** `p6e`. **Theme:** 9. **Depends on:** Phase-3 rollout has completed and 1+ week of telemetry exists. **Effort:** ~2 hours.

**Files:**

- Create: `docs/retros/2026-MM-DD-p6-retro.md`

Captures (mirroring P5 retro structure):

- Items delivered vs descoped (against this implementation plan)
- Lessons learned — especially around model behavior in production, validation correction rates from Agent C, consultant override patterns from Agent A, prompt-eval CI experience
- P7 inheritance points (project-level narrative, one-button orchestrator, embedding pre-clustering for Agent B, retro items #3+#4+#5 from P5, finer statutory_anchor taxonomy if customer feedback wants it)

Commit: `docs(retros): P6 retrospective`.

---

## Risk register (carried from design doc Section 7.4)

See `docs/plans/2026-05-01-p6-design.md` Section 7. Highest-leverage risks:

1. **Hallucinated `citing_events`** (medium-low/high) — Task 5.2's segment validator + the validate-and-correct loop are mandatory. Don't skip the validation tests.
2. **Tenant runaway spend** (low/high) — Task 2.3 rate limit + the $50/day Slack alarm budget alarm are mandatory before Phase-2 rollout.
3. **Stub-mode parity drift** (medium/medium) — every Anthropic-call code path must have a stub-mode test in the same test file. Reviewers enforce.

---

## Sequencing checklist (controller follows this order)

1. **First commit on p6a:** Task 0.1 (chain.ts double-cast) — landed in `migrations.test.ts` first, then chain.ts source fix, then placeholder migration 0031.
2. **Themes 1 + 2 in parallel on p6a:** Tasks 1.1-1.5 (migrations 0026-0030) and Tasks 2.1-2.4 (cross-cutting infra). PR titled `feat(p6-foundation)` once both subsets land.
3. **After p6a merges:** parallel dispatch of p6b (Theme 3, Tasks 3.1-3.5) and p6c (Theme 4, Tasks 4.1-4.5). Both base off latest main.
4. **After p6b merges:** dispatch p6d (Theme 5, Tasks 5.1-5.8). Single-stream within p6d — Tasks 5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6 → 5.7 → 5.8 in order.
5. **After all agent PRs (b, c, d) merge:** p6e starts with Task 6.1 (mapping_rule backfill migration 0032), then Tasks 7.1-7.3 (eval framework), then Tasks 8.1-8.3 (staged rollout, gated by 1-week soaks).
6. **Retrospective at end** (Task 9.1).

Each task uses the per-task TDD pattern from P5 (write failing test → run-fail → implement → run-pass → commit → push). Each agent worktree opens a single PR for its theme, NOT per-task. PRs:

| PR # (expected) | Branch | Themes | Lands after |
| --- | --- | --- | --- |
| #14 | `p6a/foundation` | 0 + 1 + 2 | PR #13 (design doc) |
| #15 | `p6b/agent-classifier` | 3 | #14 |
| #16 | `p6c/agent-synthesizer` | 4 | #14 (parallel with #15) |
| #17 | `p6d/agent-narrative` | 5 | #15 |
| #18 | `p6e/eval-rollout` | 6 + 7 + 8 + 9 | #15, #16, #17 |

End of P6 implementation plan.
