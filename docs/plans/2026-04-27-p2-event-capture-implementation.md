# P2 — Event Capture Vertical Slice — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Ship the first-demo gate: paste transcript → Division 355 classifier → event in per-claimant hash chain → visible in portal feed with confidence chips, override flow, and chain verification.

**Architecture:** Two-impl classifier (`HaikuClassifier` + `StubClassifier`) selected by `CLASSIFIER_IMPL` env. Postgres-backed idempotency cache in front. Per-`subject_tenant` SHA-256 hash chain with `pg_advisory_xact_lock` for concurrency. RLS on `event.tenant_id`. Portal `/subject-tenants/[id]` is the single demo screen.

**Tech Stack:** Drizzle 0.36 + Postgres 16 + pgvector · Fastify 5 + zod · Next.js 15 + React 19 + shadcn + TanStack Query 5 · `@anthropic-ai/sdk` 0.30+ · OpenTelemetry · `nock` for HTTP mocking · Playwright for e2e.

**Design doc:** [`./2026-04-27-p2-event-capture-design.md`](./2026-04-27-p2-event-capture-design.md) — every task references a design section.

**Working directory for all tasks:** `C:\Users\Aaron\cpa-platform-worktrees\p2` (branch `p2/event-capture`).

**Discipline notes for every task:**
- Use `@cpa/...` workspace imports — never relative paths across packages
- TypeScript strict; ESM with `.js` import extensions; node:test runner
- Tests use `tsx --env-file-if-exists=../../.env --test "src/**/*.test.ts"`
- Migrations: `pnpm --filter @cpa/db migrate` (after generating with `drizzle-kit generate`)
- Classifier impl in dev/local: `CLASSIFIER_IMPL=stub` (avoids needing API key)
- Commit per step. Conventional-commits format. Co-author trailer required.

**Cross-cutting reference:** Anthropic SDK error handling, OTel attribute conventions, and tenant-context middleware are all from P0/P1 — re-use, don't redefine.

---

## Phase 1 — Schema, chain, environment wiring (T1-T5)

### Task 1: Wire `CLASSIFIER_IMPL` env var through monorepo

**Files:**
- Modify: `turbo.json` (add `CLASSIFIER_IMPL` to `globalPassThroughEnv`)
- Modify: `.github/workflows/ci.yml` (add `CLASSIFIER_IMPL: stub` to both `ci` and `e2e` jobs `env:` blocks)
- Create: `.env.example` (or modify if exists) with `CLASSIFIER_IMPL=haiku` + `ANTHROPIC_API_KEY=sk-ant-...`

**Step 1: Add to turbo.json**

Open `turbo.json`. The current `globalPassThroughEnv` already includes `DATABASE_URL`, `DATABASE_URL_APP`, `DATABASE_POOL_MAX`, `SESSION_JWT_SECRET`, `ANTHROPIC_API_KEY`, etc. Add `CLASSIFIER_IMPL` to the array.

**Step 2: Add to ci.yml**

In `.github/workflows/ci.yml`, locate both `env:` blocks (one for `ci` job, one for `e2e` job). Add to each:
```yaml
      CLASSIFIER_IMPL: stub
```

**Step 3: Update `.env.example`**

Check if `.env.example` exists at repo root. If yes, append:
```
# Classifier impl: 'haiku' (real Anthropic) or 'stub' (deterministic fallback)
CLASSIFIER_IMPL=haiku

# Required when CLASSIFIER_IMPL=haiku. Get from https://console.anthropic.com.
ANTHROPIC_API_KEY=sk-ant-...
```
If `.env.example` does not exist, create it with the contents above plus the existing required vars (run `Grep` for `process.env` in the codebase first to enumerate what's needed; at minimum: `DATABASE_URL`, `DATABASE_URL_APP`, `SESSION_JWT_SECRET`, plus the new two).

**Step 4: Verify locally**

Run: `pnpm test --filter @cpa/db` (should still pass; no behavioural change yet)

**Step 5: Commit**

```bash
git add turbo.json .github/workflows/ci.yml .env.example
git commit -m "chore: wire CLASSIFIER_IMPL env var (default stub in CI, haiku in dev)"
```

---

### Task 2: Add `event` and `agent_call_cache` schemas (Drizzle)

**Files:**
- Create: `packages/db/src/schema/event.ts`
- Create: `packages/db/src/schema/agent_call_cache.ts`
- Modify: `packages/db/src/schema/index.ts` (export new tables)
- Modify: `packages/db/drizzle.config.ts` if needed (existing config should pick up new schemas)

**Step 1: Create `event.ts`**

See design doc §2.1 for the full schema. Reproduce exactly. Notes:
- Import `pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex` from `drizzle-orm/pg-core`
- Import `tenant`, `subject_tenant`, `user` from sibling schema files (use `.js` extension)
- Define `EVIDENCE_KINDS` as exported `const [...] as const`
- Use `.references(() => ...)` for FKs except `project_id` and `milestone_id` (those are nullable columns with no FK target until later phases)
- The `idempotency_unique` index uses `.where(sql\`${t.idempotency_key} IS NOT NULL\`)` for partial uniqueness

**Step 2: Create `agent_call_cache.ts`**

See design doc §2.3.

**Step 3: Export both from `index.ts`**

Add `export * from './event.js';` and `export * from './agent_call_cache.js';`.

**Step 4: Generate migration**

Run: `pnpm --filter @cpa/db generate`

This produces `packages/db/migrations/0006_<adj>_<noun>.sql` with the CREATE TABLE statements + indexes. Inspect the file — confirm it includes `event`, `agent_call_cache`, and the partial unique index.

**Step 5: Build + typecheck**

Run: `pnpm --filter @cpa/db build && pnpm --filter @cpa/db typecheck`

Expected: clean.

**Step 6: Commit**

```bash
git add packages/db/src/schema/event.ts packages/db/src/schema/agent_call_cache.ts packages/db/src/schema/index.ts packages/db/migrations/0006_*.sql packages/db/migrations/meta/
git commit -m "feat(db): event + agent_call_cache schemas + migration 0006"
```

---

### Task 3: Hand-author RLS extension to migration 0006

**Files:**
- Modify: `packages/db/migrations/0006_<adj>_<noun>.sql` (append RLS section)

The drizzle-generated migration creates the tables but does NOT create RLS policies. Append them.

**Step 1: Append RLS block to migration 0006**

At the end of the migration file, append:

```sql
-- ============================================================
-- RLS for event table — direct tenant_id (denormalised for index efficiency)
-- ============================================================

ALTER TABLE "event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event" FORCE ROW LEVEL SECURITY;

CREATE POLICY "event_tenant_isolation" ON "event"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- agent_call_cache is intentionally NOT RLS-protected:
-- content-addressed by SHA-256(prompt_version || raw_text); identical inputs
-- across tenants legitimately share a cache entry.

GRANT SELECT, INSERT, UPDATE, DELETE ON "event" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_call_cache" TO cpa_app;
```

**Step 2: Apply migration locally**

Run: `pnpm --filter @cpa/db migrate`

Expected output: `migrations applied`.

**Step 3: Smoke check via psql**

Run:
```bash
PGPASSWORD=cpa_app_dev_pwd psql -h localhost -p 5433 -U cpa_app -d cpa_dev -c "SELECT count(*) FROM event;"
```
Expected: 0 rows. Confirms cpa_app can SELECT (RLS in effect — empty tenant context returns 0 not error because `current_setting('app.current_tenant_id', true)` returns NULL → policy false → 0 rows).

Then:
```bash
PGPASSWORD=cpa_app_dev_pwd psql -h localhost -p 5433 -U cpa_app -d cpa_dev -c "INSERT INTO event (tenant_id, subject_tenant_id, kind, payload, hash, captured_at, captured_by_user_id) VALUES ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 'HYPOTHESIS', '{\"_v\":1,\"source\":\"paste\",\"raw_text\":\"x\"}'::jsonb, 'fake', NOW(), '00000000-0000-0000-0000-000000000001'::uuid);"
```
Expected: ERROR — `new row violates row-level security policy "event_tenant_isolation"`. Confirms RLS WITH CHECK is active.

**Step 4: Commit**

```bash
git add packages/db/migrations/0006_*.sql
git commit -m "feat(db): RLS policy + grants for event + agent_call_cache"
```

---

### Task 4: Hash chain helpers in `@cpa/db`

**Files:**
- Create: `packages/db/src/chain.ts`
- Create: `packages/db/src/chain.test.ts`
- Modify: `packages/db/src/index.ts` (re-export chain helpers)

**Step 1: Write the failing test (`chain.test.ts`)**

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { canonicaliseEvent, hashEvent, insertEventWithChain, verifyChain } from './chain.js';
import { sql } from './client.js';
import { event, tenant, subject_tenant, user } from './schema/index.js';

const TENANT_ID = '00000000-0000-4000-8000-0000c0001111';
const SUBJECT_ID = '00000000-0000-4000-8000-0000c0002222';
const USER_ID = '00000000-0000-4000-8000-0000c0003333';

before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO tenant (id, name, slug, primary_idp) VALUES (${TENANT_ID}, 'Chain Test Firm', 'chain-test-firm', 'mixed')`;
    await tx`INSERT INTO "user" (id, email, primary_idp, external_id) VALUES (${USER_ID}, 'chain-test@example.com', 'microsoft', 'microsoft:chain-test')`;
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
    await tx`INSERT INTO subject_tenant (id, tenant_id, name, kind) VALUES (${SUBJECT_ID}, ${TENANT_ID}, 'Chain Test Claimant', 'claimant')`;
  });
});

after(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_ID}, true)`;
    await tx`DELETE FROM event WHERE subject_tenant_id = ${SUBJECT_ID}`;
    await tx`DELETE FROM subject_tenant WHERE id = ${SUBJECT_ID}`;
  });
  await sql`DELETE FROM "user" WHERE id = ${USER_ID}`;
  await sql`DELETE FROM tenant WHERE id = ${TENANT_ID}`;
  await sql.end();
});

test('canonicaliseEvent produces deterministic JSON with sorted keys', () => {
  const a = canonicaliseEvent({
    subject_tenant_id: 'a', kind: 'HYPOTHESIS', payload: { x: 1, y: 2 },
    classification: null, captured_at: new Date('2026-04-27T00:00:00Z'),
    captured_by_user_id: 'u', override_of_event_id: null, override_new_kind: null, override_reason: null,
  });
  const b = canonicaliseEvent({
    captured_by_user_id: 'u', override_reason: null, classification: null,
    payload: { y: 2, x: 1 }, kind: 'HYPOTHESIS', captured_at: new Date('2026-04-27T00:00:00Z'),
    subject_tenant_id: 'a', override_new_kind: null, override_of_event_id: null,
  });
  assert.equal(a, b, 'canonical form must be order-independent');
});

test('hashEvent: prev=null produces stable hex hash', () => {
  const h = hashEvent(null, {
    subject_tenant_id: 'a', kind: 'HYPOTHESIS', payload: { _v: 1, source: 'paste', raw_text: 'hello' },
    classification: null, captured_at: new Date('2026-04-27T00:00:00Z'),
    captured_by_user_id: 'u', override_of_event_id: null, override_new_kind: null, override_reason: null,
  });
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('insertEventWithChain: first event has prev_hash=null', async () => {
  const e = await insertEventWithChain({
    tenant_id: TENANT_ID, subject_tenant_id: SUBJECT_ID, kind: 'HYPOTHESIS',
    payload: { _v: 1, source: 'paste', raw_text: 'first event' },
    classification: { kind: 'HYPOTHESIS', confidence: 0.9, rationale: 'r', statutory_anchor: null, model: 'stub-v1.0.0', prompt_version: 'classify@1.0.0', tokens_in: 0, tokens_out: 0, cache_hit: false },
    captured_at: new Date(), captured_by_user_id: USER_ID,
  });
  assert.equal(e.prev_hash, null);
  assert.match(e.hash, /^[0-9a-f]{64}$/);
});

test('insertEventWithChain: second event extends prev_hash', async () => {
  const e1 = await insertEventWithChain({
    tenant_id: TENANT_ID, subject_tenant_id: SUBJECT_ID, kind: 'OBSERVATION',
    payload: { _v: 1, source: 'paste', raw_text: 'second' },
    classification: null,
    captured_at: new Date(), captured_by_user_id: USER_ID,
  });
  const e2 = await insertEventWithChain({
    tenant_id: TENANT_ID, subject_tenant_id: SUBJECT_ID, kind: 'EXPERIMENT',
    payload: { _v: 1, source: 'paste', raw_text: 'third' },
    classification: null,
    captured_at: new Date(), captured_by_user_id: USER_ID,
  });
  assert.equal(e2.prev_hash, e1.hash);
});

test('verifyChain: clean chain returns verified=true', async () => {
  const status = await verifyChain(SUBJECT_ID);
  assert.equal(status.verified, true);
  assert.ok((status.event_count ?? 0) > 0);
  assert.match(status.head_hash ?? '', /^[0-9a-f]{64}$/);
});

test('verifyChain: tampered hash detected', async () => {
  // Manually corrupt one row's hash, verify catches it, then restore.
  const [first] = await sql<{ id: string; hash: string }[]>`
    SELECT id, hash FROM event WHERE subject_tenant_id = ${SUBJECT_ID}
    ORDER BY captured_at, received_at, id LIMIT 1
  `;
  assert.ok(first);
  const originalHash = first.hash;
  // Use privileged client to bypass RLS for the corruption (test-only).
  const { privilegedSql } = await import('./client.js');
  await privilegedSql`UPDATE event SET hash = 'deadbeef' || substring(hash from 9) WHERE id = ${first.id}`;
  const status = await verifyChain(SUBJECT_ID);
  assert.equal(status.verified, false);
  assert.equal(status.first_break_at, 0);
  await privilegedSql`UPDATE event SET hash = ${originalHash} WHERE id = ${first.id}`;
});
```

**Step 2: Run test — should fail (module not found)**

Run: `pnpm --filter @cpa/db test`
Expected: failure on `import .. from './chain.js'`

**Step 3: Implement `chain.ts`**

```ts
import crypto from 'node:crypto';
import { sql } from './client.js';

export type EventForHashing = {
  subject_tenant_id: string;
  kind: string;
  payload: unknown;
  classification: unknown | null;
  captured_at: Date;
  captured_by_user_id: string;
  override_of_event_id: string | null;
  override_new_kind: string | null;
  override_reason: string | null;
};

function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

export function canonicaliseEvent(e: EventForHashing): string {
  return canonicalJsonStringify({
    subject_tenant_id: e.subject_tenant_id,
    kind: e.kind,
    payload: e.payload,
    classification: e.classification,
    captured_at: e.captured_at.toISOString(),
    captured_by_user_id: e.captured_by_user_id,
    override_of_event_id: e.override_of_event_id ?? null,
    override_new_kind: e.override_new_kind ?? null,
    override_reason: e.override_reason ?? null,
  });
}

export function hashEvent(prevHash: string | null, e: EventForHashing): string {
  const buf = (prevHash ?? '') + canonicaliseEvent(e);
  return crypto.createHash('sha256').update(buf, 'utf8').digest('hex');
}

export type InsertEventInput = EventForHashing & {
  tenant_id: string;
  project_id?: string | null;
  milestone_id?: string | null;
  idempotency_key?: string | null;
};

export type InsertedEvent = {
  id: string;
  prev_hash: string | null;
  hash: string;
};

/**
 * Inserts an event with deterministic hash-chain extension.
 * Holds a per-subject_tenant transaction-scoped advisory lock so concurrent
 * inserts against the same chain serialise (concurrent inserts against
 * different chains do NOT block each other).
 */
export async function insertEventWithChain(input: InsertEventInput): Promise<InsertedEvent> {
  return await sql.begin(async (tx) => {
    // Set the request-scoped tenant context (already set by middleware in API path,
    // but explicit here makes this fn callable from tools/scripts without a request).
    await tx`SELECT set_config('app.current_tenant_id', ${input.tenant_id}, true)`;
    // Per-claimant chain lock (hashtext gives a stable bigint for a string).
    await tx`SELECT pg_advisory_xact_lock(hashtext('event_chain_' || ${input.subject_tenant_id}::text)::bigint)`;
    const prevRows = await tx<{ hash: string }[]>`
      SELECT hash FROM event
      WHERE subject_tenant_id = ${input.subject_tenant_id}
      ORDER BY captured_at DESC, received_at DESC, id DESC
      LIMIT 1
    `;
    const prevHash = prevRows[0]?.hash ?? null;
    const newHash = hashEvent(prevHash, input);
    const id = crypto.randomUUID();
    await tx`
      INSERT INTO event (
        id, tenant_id, subject_tenant_id, project_id, milestone_id, kind,
        payload, classification,
        override_of_event_id, override_new_kind, override_reason,
        prev_hash, hash, idempotency_key,
        captured_at, captured_by_user_id
      ) VALUES (
        ${id}, ${input.tenant_id}, ${input.subject_tenant_id},
        ${input.project_id ?? null}, ${input.milestone_id ?? null}, ${input.kind},
        ${input.payload as never}::jsonb, ${input.classification as never}::jsonb,
        ${input.override_of_event_id ?? null},
        ${input.override_new_kind ?? null},
        ${input.override_reason ?? null},
        ${prevHash}, ${newHash}, ${input.idempotency_key ?? null},
        ${input.captured_at}, ${input.captured_by_user_id}
      )
    `;
    return { id, prev_hash: prevHash, hash: newHash };
  });
}

export type ChainStatus = {
  verified: boolean;
  head_hash: string | null;
  event_count: number;
  first_break_at: number | null;
};

export async function verifyChain(subjectTenantId: string): Promise<ChainStatus> {
  const rows = await sql<EventForHashing & { id: string; prev_hash: string | null; hash: string; received_at: Date }[]>`
    SELECT
      id, subject_tenant_id, kind, payload, classification,
      captured_at, captured_by_user_id, received_at,
      override_of_event_id, override_new_kind, override_reason,
      prev_hash, hash
    FROM event
    WHERE subject_tenant_id = ${subjectTenantId}
    ORDER BY captured_at, received_at, id
  `;
  let prev: string | null = null;
  let head: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i]!;
    const expected = hashEvent(prev, {
      subject_tenant_id: e.subject_tenant_id,
      kind: e.kind,
      payload: e.payload,
      classification: e.classification,
      captured_at: new Date(e.captured_at),
      captured_by_user_id: e.captured_by_user_id,
      override_of_event_id: e.override_of_event_id,
      override_new_kind: e.override_new_kind,
      override_reason: e.override_reason,
    });
    if (e.prev_hash !== prev || e.hash !== expected) {
      return { verified: false, head_hash: head, event_count: rows.length, first_break_at: i };
    }
    prev = e.hash;
    head = e.hash;
  }
  return { verified: true, head_hash: head, event_count: rows.length, first_break_at: null };
}
```

**Step 4: Re-export from index**

In `packages/db/src/index.ts`, add `export * from './chain.js';`.

**Step 5: Run tests — should pass**

Run: `pnpm --filter @cpa/db test`
Expected: all tests pass.

**Step 6: Commit**

```bash
git add packages/db/src/chain.ts packages/db/src/chain.test.ts packages/db/src/index.ts
git commit -m "feat(db): hash-chain helpers (canonicalise + hash + insert-with-chain + verify)"
```

---

### Task 5: Run migrations end-to-end + smoke verify

**Files:** none modified (verification only)

**Step 1: Reset local DB to a fresh state**

```bash
docker compose down -v
docker compose up -d postgres
sleep 5
pnpm --filter @cpa/db migrate
```

Expected: `migrations applied` (0000 through 0006).

**Step 2: Verify event table exists with RLS**

```bash
PGPASSWORD=cpa psql -h localhost -p 5433 -U cpa -d cpa_dev -c "\d event"
```
Expected: shows columns including `prev_hash`, `hash`, `idempotency_key`, plus 3 indexes.

```bash
PGPASSWORD=cpa psql -h localhost -p 5433 -U cpa -d cpa_dev -c "SELECT polname FROM pg_policy WHERE polrelid = 'event'::regclass;"
```
Expected: `event_tenant_isolation`.

**Step 3: Run all tests cold**

```bash
pnpm test
```
Expected: all packages green.

**Step 4: Commit nothing — verification only.** Move to next task.

---

## Phase 2 — Agents runtime package (T6-T9)

### Task 6: Bootstrap `@cpa/agents` package

**Files:**
- Create: `packages/agents/package.json`
- Create: `packages/agents/tsconfig.json`
- Create: `packages/agents/tsconfig.test.json`
- Create: `packages/agents/eslint.config.mjs`
- Create: `packages/agents/src/index.ts` (placeholder)
- Modify: `pnpm-workspace.yaml` if it lists packages explicitly (it should be glob-based; verify)
- Modify: root `tsconfig.json` (if it has project references, add `packages/agents`)

**Step 1: `package.json`**

```json
{
  "name": "@cpa/agents",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./runtime": { "types": "./dist/runtime/index.d.ts", "import": "./dist/runtime/index.js" },
    "./classifier": { "types": "./dist/classifier/index.d.ts", "import": "./dist/classifier/index.js" }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "tsx --env-file-if-exists=../../.env --test \"src/**/*.test.ts\"",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@cpa/db": "workspace:*",
    "@cpa/observability": "workspace:*",
    "@anthropic-ai/sdk": "^0.32.1",
    "@opentelemetry/api": "^1.9.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "nock": "^14.0.13",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3"
  }
}
```

**Step 2: `tsconfig.json`**

Mirror `packages/db/tsconfig.json` exactly (NodeNext, strict, etc.) — adjust references to point at `@cpa/db` and `@cpa/observability`.

**Step 3: `eslint.config.mjs`**

```js
import baseConfig from '../../eslint.config.mjs';
export default [
  ...baseConfig,
  { ignores: ['dist/**', 'node_modules/**'] },
];
```

**Step 4: `src/index.ts`**

```ts
export * from './runtime/index.js';
export * from './classifier/index.js';
```

(Will fail typecheck until subdirs exist — create empty index.ts in each next:)

```ts
// src/runtime/index.ts
export {};
// src/classifier/index.ts
export {};
```

**Step 5: Install + build**

Run: `pnpm install` (picks up new package), then `pnpm --filter @cpa/agents build`
Expected: clean build, empty dist.

**Step 6: Commit**

```bash
git add packages/agents/
git commit -m "feat(agents): bootstrap @cpa/agents workspace package"
```

---

### Task 7: Runtime — Anthropic client + prompt registry + telemetry

**Files:**
- Create: `packages/agents/src/runtime/anthropic-client.ts`
- Create: `packages/agents/src/runtime/prompt-registry.ts`
- Create: `packages/agents/src/runtime/telemetry.ts`
- Create: `packages/agents/src/runtime/types.ts`
- Modify: `packages/agents/src/runtime/index.ts` (re-export)

(See design doc §3.1 for shapes.)

**Step 1: `types.ts`**

```ts
import type { z } from 'zod';

export type ToolDef<O> = {
  name: string;
  description: string;
  input_schema: z.ZodType<O>;
};

export type PromptDefinition<O> = {
  name: string;
  version: string;        // semver, e.g. '1.0.0'
  system: string;
  tool: ToolDef<O>;
};

export type AgentSpanAttrs = {
  agent_name: string;
  prompt_version: string;
  model: string;
  tenant_id?: string;
  subject_tenant_id?: string;
  tokens_in?: number;
  tokens_out?: number;
  cache_hit?: boolean;
  classification_kind?: string;
  classification_confidence?: number;
};
```

**Step 2: `anthropic-client.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY required (or set CLASSIFIER_IMPL=stub for stub-only mode)',
    );
  }
  client = new Anthropic({ apiKey, maxRetries: 3, timeout: 30_000 });
  return client;
}

// For tests — reset cached client between tests if API key changes.
export function _resetAnthropicClientForTests(): void {
  client = null;
}
```

**Step 3: `prompt-registry.ts`**

```ts
import type { PromptDefinition } from './types.js';

const PROMPTS = new Map<string, PromptDefinition<unknown>>();

export function registerPrompt<O>(p: PromptDefinition<O>): void {
  const key = `${p.name}@${p.version}`;
  if (PROMPTS.has(key)) {
    // Idempotent — repeat registration of same prompt is a no-op.
    return;
  }
  PROMPTS.set(key, p as PromptDefinition<unknown>);
}

export function getPrompt<O>(key: string): PromptDefinition<O> {
  const p = PROMPTS.get(key);
  if (!p) throw new Error(`prompt not registered: ${key}`);
  return p as PromptDefinition<O>;
}

export function listPrompts(): string[] {
  return [...PROMPTS.keys()].sort();
}
```

**Step 4: `telemetry.ts`**

```ts
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { AgentSpanAttrs } from './types.js';

const tracer = trace.getTracer('@cpa/agents');

export async function withAgentSpan<T>(
  spanName: string,
  attrs: AgentSpanAttrs,
  fn: (setAttr: (more: Partial<AgentSpanAttrs>) => void) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(spanName, async (span) => {
    const apply = (a: Partial<AgentSpanAttrs>) => {
      for (const [k, v] of Object.entries(a)) {
        if (v !== undefined && v !== null) span.setAttribute(`cpa.${k}`, v as string | number | boolean);
      }
    };
    apply(attrs);
    try {
      const r = await fn(apply);
      span.setStatus({ code: SpanStatusCode.OK });
      return r;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}
```

**Step 5: Update `runtime/index.ts`**

```ts
export * from './types.js';
export * from './anthropic-client.ts'.replace('.ts', '.js');  // ts compiler handles this
export * from './prompt-registry.js';
export * from './telemetry.js';
```

(Use plain `.js` re-exports — verbatim ESM:)
```ts
export * from './types.js';
export * from './anthropic-client.js';
export * from './prompt-registry.js';
export * from './telemetry.js';
```

**Step 6: Tests for prompt-registry**

Create `packages/agents/src/runtime/prompt-registry.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerPrompt, getPrompt, listPrompts } from './prompt-registry.js';

test('registerPrompt + getPrompt round-trip', () => {
  registerPrompt({
    name: 'test-prompt-' + Math.random(),
    version: '1.0.0',
    system: 'sys',
    tool: { name: 'noop', description: 'd', input_schema: z.object({}) },
  });
  // Re-register same key — no throw
  registerPrompt({
    name: 'test-prompt-stable',
    version: '1.0.0',
    system: 'sys',
    tool: { name: 'noop', description: 'd', input_schema: z.object({}) },
  });
  registerPrompt({
    name: 'test-prompt-stable',
    version: '1.0.0',
    system: 'sys-2',
    tool: { name: 'noop', description: 'd', input_schema: z.object({}) },
  });
  const p = getPrompt('test-prompt-stable@1.0.0');
  // First registration wins (idempotent).
  assert.equal(p.system, 'sys');
});

test('getPrompt throws on unknown key', () => {
  assert.throws(() => getPrompt('nonexistent@9.9.9'), /prompt not registered/);
});

test('listPrompts returns sorted keys', () => {
  const keys = listPrompts();
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});
```

**Step 7: Run + commit**

```bash
pnpm --filter @cpa/agents test
git add packages/agents/src/runtime/
git commit -m "feat(agents): runtime — anthropic client + prompt registry + telemetry"
```

---

### Task 8: Runtime — idempotency cache

**Files:**
- Create: `packages/agents/src/runtime/idempotency.ts`
- Create: `packages/agents/src/runtime/idempotency.test.ts`

**Step 1: Failing test**

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { computeIdempotencyKey, lookupCache, writeCache } from './idempotency.js';
import { sql } from '@cpa/db/client';

after(async () => {
  await sql`DELETE FROM agent_call_cache WHERE agent_name = 'test-agent'`;
  await sql.end();
});

test('computeIdempotencyKey is deterministic', () => {
  const a = computeIdempotencyKey('classify@1.0.0', 'hello world');
  const b = computeIdempotencyKey('classify@1.0.0', 'hello world');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('computeIdempotencyKey differs on prompt-version change', () => {
  const a = computeIdempotencyKey('classify@1.0.0', 'x');
  const b = computeIdempotencyKey('classify@2.0.0', 'x');
  assert.notEqual(a, b);
});

test('writeCache + lookupCache round-trip', async () => {
  const key = computeIdempotencyKey('classify@1.0.0', 'idempotency-test-' + Math.random());
  const written = {
    idempotency_key: key,
    agent_name: 'test-agent',
    prompt_version: 'classify@1.0.0',
    output: { kind: 'HYPOTHESIS', confidence: 0.9 },
    tokens_in: 100,
    tokens_out: 50,
    model: 'test-model',
  };
  await writeCache(written);
  const got = await lookupCache(key);
  assert.ok(got);
  assert.equal(got!.tokens_in, 100);
  assert.deepEqual(got!.output, { kind: 'HYPOTHESIS', confidence: 0.9 });
});

test('lookupCache returns null for unknown key', async () => {
  const got = await lookupCache('0'.repeat(64));
  assert.equal(got, null);
});

test('writeCache is idempotent (ON CONFLICT DO NOTHING)', async () => {
  const key = computeIdempotencyKey('classify@1.0.0', 'idempotency-conflict-' + Math.random());
  const entry = {
    idempotency_key: key, agent_name: 'test-agent', prompt_version: 'classify@1.0.0',
    output: { v: 1 }, tokens_in: 1, tokens_out: 1, model: 'm',
  };
  await writeCache(entry);
  // Second write with different output should NOT replace.
  await writeCache({ ...entry, output: { v: 2 } });
  const got = await lookupCache(key);
  assert.deepEqual(got!.output, { v: 1 });
});
```

**Step 2: Run — fail (module not found)**

`pnpm --filter @cpa/agents test`

**Step 3: Implement**

```ts
import crypto from 'node:crypto';
import { sql } from '@cpa/db/client';

export function computeIdempotencyKey(promptKey: string, rawInput: string): string {
  return crypto.createHash('sha256').update(promptKey + '' + rawInput, 'utf8').digest('hex');
}

export type CacheEntry = {
  idempotency_key: string;
  agent_name: string;
  prompt_version: string;
  output: unknown;
  tokens_in: number;
  tokens_out: number;
  model: string;
};

export async function lookupCache(key: string): Promise<CacheEntry | null> {
  const rows = await sql<CacheEntry[]>`
    SELECT idempotency_key, agent_name, prompt_version, output, tokens_in, tokens_out, model
    FROM agent_call_cache
    WHERE idempotency_key = ${key}
  `;
  return rows[0] ?? null;
}

export async function writeCache(entry: CacheEntry): Promise<void> {
  await sql`
    INSERT INTO agent_call_cache
      (idempotency_key, agent_name, prompt_version, output, tokens_in, tokens_out, model)
    VALUES
      (${entry.idempotency_key}, ${entry.agent_name}, ${entry.prompt_version},
       ${entry.output as never}::jsonb, ${entry.tokens_in}, ${entry.tokens_out}, ${entry.model})
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
}
```

**Step 4: Run — should pass; commit**

```bash
pnpm --filter @cpa/agents test
git add packages/agents/src/runtime/idempotency.ts packages/agents/src/runtime/idempotency.test.ts
git commit -m "feat(agents): runtime — Postgres-backed idempotency cache"
```

---

### Task 9: Runtime — tool-use helper (with nock-mocked Anthropic)

**Files:**
- Create: `packages/agents/src/runtime/tool-use.ts`
- Create: `packages/agents/src/runtime/tool-use.test.ts`

**Step 1: Failing test**

```ts
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { z } from 'zod';
import { _resetAnthropicClientForTests, getAnthropicClient } from './anthropic-client.js';
import { callWithToolUse } from './tool-use.js';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  _resetAnthropicClientForTests();
  nock.cleanAll();
});

after(() => {
  nock.cleanAll();
});

test('callWithToolUse extracts tool_use block and returns parsed output', async () => {
  const schema = z.object({ kind: z.string(), confidence: z.number() });

  nock('https://api.anthropic.com')
    .post('/v1/messages')
    .reply(200, {
      id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'classify', input: { kind: 'HYPOTHESIS', confidence: 0.85 } }],
      stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    });

  const r = await callWithToolUse(getAnthropicClient(), {
    model: 'claude-haiku-4-5',
    system: 'sys',
    user: 'classify this',
    tool: { name: 'classify', description: 'd', input_schema: schema },
  });
  assert.equal(r.output.kind, 'HYPOTHESIS');
  assert.equal(r.output.confidence, 0.85);
  assert.equal(r.tokens_in, 100);
  assert.equal(r.tokens_out, 50);
});

test('callWithToolUse throws when no tool_use block returned', async () => {
  const schema = z.object({ kind: z.string() });
  nock('https://api.anthropic.com')
    .post('/v1/messages')
    .reply(200, {
      id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'I refused to use the tool' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  await assert.rejects(
    callWithToolUse(getAnthropicClient(), {
      model: 'claude-haiku-4-5', system: 's', user: 'u',
      tool: { name: 'classify', description: 'd', input_schema: schema },
    }),
    /did not invoke the structured-output tool/,
  );
});
```

**Step 2: Run — fail; implement; run pass**

`tool-use.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { ToolDef } from './types.js';

// Minimal zod → JSON schema (only the subset we need: object with primitives, enum, nullable, min/max, maxLength).
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def: { typeName: string } })._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v);
        if (!(v.isOptional() || v.isNullable())) required.push(k);
      }
      return { type: 'object', properties, required };
    }
    case 'ZodString': {
      const checks = (def as { checks?: { kind: string; value?: number }[] }).checks ?? [];
      const obj: Record<string, unknown> = { type: 'string' };
      for (const c of checks) if (c.kind === 'max' && c.value) obj.maxLength = c.value;
      return obj;
    }
    case 'ZodNumber': {
      const checks = (def as { checks?: { kind: string; value?: number }[] }).checks ?? [];
      const obj: Record<string, unknown> = { type: 'number' };
      for (const c of checks) {
        if (c.kind === 'min' && c.value !== undefined) obj.minimum = c.value;
        if (c.kind === 'max' && c.value !== undefined) obj.maximum = c.value;
      }
      return obj;
    }
    case 'ZodEnum': {
      return { type: 'string', enum: (def as { values: string[] }).values };
    }
    case 'ZodNullable': {
      const inner = zodToJsonSchema((def as { innerType: z.ZodTypeAny }).innerType);
      return { ...inner, nullable: true };
    }
    case 'ZodOptional': {
      return zodToJsonSchema((def as { innerType: z.ZodTypeAny }).innerType);
    }
    default:
      throw new Error(`zodToJsonSchema: unsupported type ${def.typeName}`);
  }
}

export async function callWithToolUse<O>(
  client: Anthropic,
  args: { model: string; system: string; user: string; tool: ToolDef<O>; max_tokens?: number },
): Promise<{ output: O; tokens_in: number; tokens_out: number }> {
  const res = await client.messages.create({
    model: args.model,
    max_tokens: args.max_tokens ?? 1024,
    system: args.system,
    messages: [{ role: 'user', content: args.user }],
    tools: [{
      name: args.tool.name,
      description: args.tool.description,
      input_schema: zodToJsonSchema(args.tool.input_schema) as Anthropic.Tool['input_schema'],
    }],
    tool_choice: { type: 'tool', name: args.tool.name },
  });
  const block = res.content.find((c) => c.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
  if (!block) throw new Error('classifier did not invoke the structured-output tool');
  const parsed = args.tool.input_schema.parse(block.input);
  return { output: parsed, tokens_in: res.usage.input_tokens, tokens_out: res.usage.output_tokens };
}
```

**Step 3: Update runtime/index.ts** to export `callWithToolUse`.

**Step 4: Run — pass; commit**

```bash
pnpm --filter @cpa/agents test
git add packages/agents/src/runtime/tool-use.ts packages/agents/src/runtime/tool-use.test.ts packages/agents/src/runtime/index.ts
git commit -m "feat(agents): runtime — tool-use helper with structured-output extraction"
```

---

## Phase 3 — Classifier (T10-T13)

### Task 10: Classifier types + EvidenceKind enum

**Files:**
- Create: `packages/agents/src/classifier/types.ts`
- Modify: `packages/agents/src/classifier/index.ts` (re-export)

**Step 1: Implement**

```ts
// packages/agents/src/classifier/types.ts
export const EVIDENCE_KINDS = [
  'HYPOTHESIS', 'DESIGN', 'EXPERIMENT', 'OBSERVATION', 'ITERATION',
  'NEW_KNOWLEDGE', 'UNCERTAINTY', 'TIME_LOG', 'ASSOCIATE_FLAG',
  'EXPENDITURE_NOTE', 'SUPPORTING', 'INELIGIBLE', 'OVERRIDE',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const CLASSIFIABLE_KINDS = [
  'HYPOTHESIS', 'DESIGN', 'EXPERIMENT', 'OBSERVATION', 'ITERATION',
  'NEW_KNOWLEDGE', 'UNCERTAINTY', 'TIME_LOG', 'ASSOCIATE_FLAG',
  'EXPENDITURE_NOTE', 'SUPPORTING', 'INELIGIBLE',
] as const;
export type ClassifiableKind = (typeof CLASSIFIABLE_KINDS)[number];

export type ClassifierInput = { raw_text: string };

export type ClassifierOutput = {
  kind: ClassifiableKind;
  confidence: number;
  rationale: string;
  statutory_anchor: string | null;
  model: string;
  prompt_version: string;
  tokens_in: number;
  tokens_out: number;
};

export interface Classifier {
  classify(input: ClassifierInput): Promise<ClassifierOutput>;
}
```

**Step 2: Re-export**

```ts
// packages/agents/src/classifier/index.ts
export * from './types.js';
```

**Step 3: Build + commit**

```bash
pnpm --filter @cpa/agents build
git add packages/agents/src/classifier/types.ts packages/agents/src/classifier/index.ts
git commit -m "feat(agents): classifier types + EvidenceKind enum"
```

---

### Task 11: Versioned classifier prompt

**Files:**
- Create: `packages/agents/src/classifier/prompts/classify@1.0.0.ts`

**Step 1: Implement**

```ts
import { z } from 'zod';
import { registerPrompt } from '../../runtime/prompt-registry.js';
import { CLASSIFIABLE_KINDS } from '../types.js';

export const classifyToolSchema = z.object({
  kind: z.enum(CLASSIFIABLE_KINDS),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(500),
  statutory_anchor: z.string().nullable(),
});

export const SYSTEM_PROMPT = `You are an expert R&D Tax Incentive (R&DTI) compliance classifier
for the Australian Income Tax Assessment Act 1997, Division 355. You receive
a single piece of evidence (transcript, lab note, voice memo) and classify it
into exactly ONE of these 12 evidence kinds:

- HYPOTHESIS: a stated conjecture or prediction whose outcome was not knowable in advance.
- DESIGN: planned approach, architecture, or method statement for an experiment.
- EXPERIMENT: a systematic test or trial conducted to evaluate a hypothesis.
- OBSERVATION: recorded result, measurement, or finding from an experiment or test.
- ITERATION: revision, refinement, or adjustment of an approach based on prior results.
- NEW_KNOWLEDGE: an insight or conclusion that resolved an uncertainty.
- UNCERTAINTY: an explicit statement that the outcome of a proposed activity could
  not be known in advance to a competent professional in the field
  (Division 355-25(1)(a) test).
- TIME_LOG: a record of effort/time spent on R&D activities.
- ASSOCIATE_FLAG: any reference to associate or related-party arrangements
  (Taxpayer Alerts TA 2023/4, TA 2023/5).
- EXPENDITURE_NOTE: an actual or planned cost / invoice / payment.
- SUPPORTING: an activity that supports core R&D but does not itself satisfy
  the systematic-experimentation test (Division 355-30).
- INELIGIBLE: routine work, ordinary-business activity, or anything excluded
  from R&DTI under Division 355-25(2)(a) (ordinary-business exclusion) or
  the supporting-activity dominant-purpose test.

Return your answer via the classify_evidence tool. Provide:
- kind: the single best classification
- confidence: your subjective probability (0..1) that a competent reviewer
  would agree. Use < 0.7 to indicate genuine uncertainty.
- rationale: a one-sentence justification (≤ 500 chars).
- statutory_anchor: the most relevant Division 355 reference if any
  (e.g. "§355-25(1)(a)", "§355-25(2)(a)", "§355-30"), or null.

Be conservative on INELIGIBLE: only mark INELIGIBLE if the text is
unambiguously routine/ordinary-business. Lower-confidence ineligible cases
should be marked SUPPORTING (with confidence < 0.7) so a consultant reviews.`;

registerPrompt({
  name: 'classify',
  version: '1.0.0',
  system: SYSTEM_PROMPT,
  tool: {
    name: 'classify_evidence',
    description: 'Classify a piece of R&D evidence per Australian R&DTI Division 355.',
    input_schema: classifyToolSchema,
  },
});
```

**Step 2: Build, commit**

```bash
pnpm --filter @cpa/agents build
git add packages/agents/src/classifier/prompts/
git commit -m "feat(agents): classify@1.0.0 — versioned prompt + tool schema"
```

---

### Task 12: StubClassifier with rule-based fixtures

**Files:**
- Create: `packages/agents/src/classifier/stub.ts`
- Create: `packages/agents/src/classifier/stub.test.ts`

**Step 1: Failing tests (cover every rule + fallthrough)**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StubClassifier } from './stub.js';

const c = new StubClassifier();

const cases: Array<{ input: string; expected_kind: string; expected_anchor: string | null }> = [
  { input: 'Spent 4 hours debugging the regulator.', expected_kind: 'TIME_LOG', expected_anchor: null },
  { input: 'Director\'s spouse provided contractor services.', expected_kind: 'ASSOCIATE_FLAG', expected_anchor: null },
  { input: 'Invoice #123 paid $4,500 to vendor.', expected_kind: 'EXPENDITURE_NOTE', expected_anchor: null },
  { input: 'This is just our normal business as usual maintenance.', expected_kind: 'INELIGIBLE', expected_anchor: '§355-25(2)(a)' },
  { input: 'We hypothesised the catalyst would last 200 hours.', expected_kind: 'HYPOTHESIS', expected_anchor: '§355-25(1)(a)' },
  { input: 'Ran the test rig at 50C for 12 hours and measured throughput.', expected_kind: 'EXPERIMENT', expected_anchor: '§355-25(1)(a)' },
  { input: 'We observed throughput dropped after iteration 3.', expected_kind: 'OBSERVATION', expected_anchor: '§355-25(1)(a)' },
  { input: 'Refined the algorithm based on the prior run.', expected_kind: 'ITERATION', expected_anchor: '§355-25(1)(a)' },
  { input: 'It is unclear whether this approach will scale.', expected_kind: 'UNCERTAINTY', expected_anchor: '§355-25(1)(a)' },
  { input: 'We discovered that the failure mode was thermal.', expected_kind: 'NEW_KNOWLEDGE', expected_anchor: '§355-25(1)(a)' },
  { input: 'New design schematic for the reactor.', expected_kind: 'DESIGN', expected_anchor: null },
  { input: 'Random unrelated sentence with no R&D vocabulary.', expected_kind: 'SUPPORTING', expected_anchor: '§355-30' },
];

for (const tc of cases) {
  test(`StubClassifier: "${tc.input.slice(0, 40)}..." → ${tc.expected_kind}`, async () => {
    const out = await c.classify({ raw_text: tc.input });
    assert.equal(out.kind, tc.expected_kind);
    assert.equal(out.statutory_anchor, tc.expected_anchor);
    assert.equal(out.model, 'stub-v1.0.0');
    assert.equal(out.prompt_version, 'classify@1.0.0');
    assert.ok(out.confidence > 0 && out.confidence <= 1);
  });
}
```

**Step 2: Run — fail; implement (see design doc §3.2 for the exact rule list); run pass**

The stub.ts file is exactly the design doc §3.2 stub.ts code block. Copy verbatim. Adjust the rule order if any test fails — earlier rules win.

**Step 3: Commit**

```bash
pnpm --filter @cpa/agents test
git add packages/agents/src/classifier/stub.ts packages/agents/src/classifier/stub.test.ts
git commit -m "feat(agents): StubClassifier — deterministic regex over evidence kinds"
```

---

### Task 13: HaikuClassifier + factory

**Files:**
- Create: `packages/agents/src/classifier/haiku.ts`
- Create: `packages/agents/src/classifier/haiku.test.ts`
- Create: `packages/agents/src/classifier/factory.ts`
- Create: `packages/agents/src/classifier/factory.test.ts`
- Modify: `packages/agents/src/classifier/index.ts` (re-export)

**Step 1: HaikuClassifier**

```ts
// haiku.ts
import { getAnthropicClient } from '../runtime/anthropic-client.js';
import { getPrompt } from '../runtime/prompt-registry.js';
import { callWithToolUse } from '../runtime/tool-use.js';
import './prompts/classify@1.0.0.js'; // side-effect: registers the prompt
import type { Classifier, ClassifierInput, ClassifierOutput } from './types.js';

const MODEL = process.env.CLASSIFIER_MODEL ?? 'claude-haiku-4-5';
const PROMPT_KEY = 'classify@1.0.0';

export class HaikuClassifier implements Classifier {
  async classify(input: ClassifierInput): Promise<ClassifierOutput> {
    const prompt = getPrompt<{
      kind: ClassifierOutput['kind'];
      confidence: number;
      rationale: string;
      statutory_anchor: string | null;
    }>(PROMPT_KEY);
    const { output, tokens_in, tokens_out } = await callWithToolUse(getAnthropicClient(), {
      model: MODEL,
      system: prompt.system,
      user: input.raw_text,
      tool: prompt.tool,
    });
    return {
      ...output,
      model: MODEL,
      prompt_version: PROMPT_KEY,
      tokens_in,
      tokens_out,
    };
  }
}
```

**Step 2: HaikuClassifier test (nock-mocked Anthropic)**

```ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { HaikuClassifier } from './haiku.js';
import { _resetAnthropicClientForTests } from '../runtime/anthropic-client.js';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  _resetAnthropicClientForTests();
  nock.cleanAll();
});

after(() => { nock.cleanAll(); });

test('HaikuClassifier round-trips through Anthropic SDK', async () => {
  nock('https://api.anthropic.com').post('/v1/messages').reply(200, {
    id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
    content: [{
      type: 'tool_use', id: 't', name: 'classify_evidence',
      input: { kind: 'HYPOTHESIS', confidence: 0.9, rationale: 'r', statutory_anchor: '§355-25(1)(a)' },
    }],
    stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 50 },
  });

  const c = new HaikuClassifier();
  const out = await c.classify({ raw_text: 'we hypothesised the catalyst would last 200 hours' });
  assert.equal(out.kind, 'HYPOTHESIS');
  assert.equal(out.confidence, 0.9);
  assert.equal(out.statutory_anchor, '§355-25(1)(a)');
  assert.equal(out.model, 'claude-haiku-4-5');
  assert.equal(out.prompt_version, 'classify@1.0.0');
  assert.equal(out.tokens_in, 200);
  assert.equal(out.tokens_out, 50);
});
```

**Step 3: Factory**

```ts
// factory.ts
import { HaikuClassifier } from './haiku.js';
import { StubClassifier } from './stub.js';
import type { Classifier } from './types.js';

export function makeClassifier(): Classifier {
  const explicit = process.env.CLASSIFIER_IMPL;
  const impl = explicit ?? (process.env.CI ? 'stub' : 'haiku');
  switch (impl) {
    case 'stub': return new StubClassifier();
    case 'haiku': return new HaikuClassifier();
    default:
      throw new Error(`unknown CLASSIFIER_IMPL: ${impl} (expected 'haiku' or 'stub')`);
  }
}
```

**Step 4: Factory test**

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeClassifier } from './factory.js';
import { StubClassifier } from './stub.js';
import { HaikuClassifier } from './haiku.js';

beforeEach(() => {
  delete process.env.CLASSIFIER_IMPL;
  delete process.env.CI;
  delete process.env.ANTHROPIC_API_KEY;
});

test('CLASSIFIER_IMPL=stub → StubClassifier', () => {
  process.env.CLASSIFIER_IMPL = 'stub';
  assert.ok(makeClassifier() instanceof StubClassifier);
});

test('CLASSIFIER_IMPL=haiku + ANTHROPIC_API_KEY set → HaikuClassifier', () => {
  process.env.CLASSIFIER_IMPL = 'haiku';
  process.env.ANTHROPIC_API_KEY = 'k';
  assert.ok(makeClassifier() instanceof HaikuClassifier);
});

test('CI=true and unset CLASSIFIER_IMPL → StubClassifier', () => {
  process.env.CI = 'true';
  assert.ok(makeClassifier() instanceof StubClassifier);
});

test('unknown CLASSIFIER_IMPL throws', () => {
  process.env.CLASSIFIER_IMPL = 'nonsense';
  assert.throws(() => makeClassifier(), /unknown CLASSIFIER_IMPL/);
});
```

**Step 5: Re-export, build, test, commit**

Update `packages/agents/src/classifier/index.ts`:
```ts
export * from './types.js';
export * from './stub.js';
export * from './haiku.js';
export * from './factory.js';
```

```bash
pnpm --filter @cpa/agents test
git add packages/agents/src/classifier/
git commit -m "feat(agents): HaikuClassifier + factory (selects impl by env)"
```

---

## Phase 4 — API endpoints (T14-T20)

**Common pattern across all API tasks:** Fastify routes use the existing `withTenantContext(req, fn)` helper from P1's `@cpa/auth/rls` (sets `app.current_tenant_id` GUC for the connection-scoped transaction). Routes receive `req.user` (current user_id) and `req.activeTenantId` (current firm) from session middleware.

### Task 14: GET /v1/subject-tenants (list)

**Files:**
- Create: `apps/api/src/routes/subject-tenants.ts`
- Create: `apps/api/src/routes/subject-tenants.test.ts`
- Modify: `apps/api/src/server.ts` (register the route plugin)
- Create: `packages/schemas/src/subject-tenant.ts` (zod schemas — used by both API + portal)

**Step 1: Define schemas in `@cpa/schemas`**

```ts
// packages/schemas/src/subject-tenant.ts
import { z } from 'zod';
export const subjectTenantKind = z.enum(['claimant', 'financier']);
export const subjectTenant = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  name: z.string(),
  kind: subjectTenantKind,
  created_at: z.string(),  // ISO
  updated_at: z.string(),
});
export const createSubjectTenantBody = z.object({
  name: z.string().min(1).max(200),
  kind: subjectTenantKind.default('claimant'),
});
export const listSubjectTenantsQuery = z.object({
  kind: subjectTenantKind.optional(),
});
export type SubjectTenant = z.infer<typeof subjectTenant>;
```

Re-export from `packages/schemas/src/index.ts`.

**Step 2: Failing test (`subject-tenants.test.ts`)**

```ts
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';
// ... seed a test tenant + 2 subject_tenants + login user
// (use existing test fixtures from W3 — extend with subject_tenants)

test('GET /v1/subject-tenants returns claimants for active firm', async () => {
  const app = await buildServer();
  const res = await app.inject({ method: 'GET', url: '/v1/subject-tenants', cookies: { cpa_session: SESSION_JWT } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.subject_tenants.length, 2);
});
```

(See P1 W3 test patterns — same auth seeding pattern.)

**Step 3: Implement route**

```ts
// apps/api/src/routes/subject-tenants.ts
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from '@cpa/db/client';
import { listSubjectTenantsQuery, subjectTenant as subjectTenantSchema } from '@cpa/schemas';
import { withTenantContext } from '@cpa/auth/rls';

export const subjectTenantsRoute: FastifyPluginAsync = async (app) => {
  const a = app.withTypeProvider<ZodTypeProvider>();

  a.get('/v1/subject-tenants', {
    schema: {
      querystring: listSubjectTenantsQuery,
      response: { 200: z.object({ subject_tenants: z.array(subjectTenantSchema) }) },
    },
  }, async (req) => {
    return await withTenantContext(req, async (tx) => {
      const rows = await tx`
        SELECT id, tenant_id, name, kind, created_at, updated_at
        FROM subject_tenant
        WHERE deleted_at IS NULL
          ${req.query.kind ? tx`AND kind = ${req.query.kind}` : tx``}
        ORDER BY name
      `;
      return { subject_tenants: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString() })) };
    });
  });
};
```

Wire into `apps/api/src/server.ts`:
```ts
import { subjectTenantsRoute } from './routes/subject-tenants.js';
// ...
await app.register(subjectTenantsRoute);
```

**Step 4: Run test → pass; commit**

```bash
pnpm --filter @cpa/api test
git add apps/api/src/routes/subject-tenants.ts apps/api/src/routes/subject-tenants.test.ts apps/api/src/server.ts packages/schemas/src/subject-tenant.ts packages/schemas/src/index.ts
git commit -m "feat(api): GET /v1/subject-tenants — list firm's claimants"
```

---

### Task 15: POST /v1/subject-tenants (create with ACL row)

**Files:**
- Modify: `apps/api/src/routes/subject-tenants.ts` (add POST)
- Modify: `apps/api/src/routes/subject-tenants.test.ts` (POST tests)

**Step 1: Failing test**

```ts
test('POST /v1/subject-tenants creates claimant + ACL row', async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: 'POST', url: '/v1/subject-tenants',
    cookies: { cpa_session: SESSION_JWT },
    payload: { name: 'Acme Innovations', kind: 'claimant' },
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 201);
  const { subject_tenant } = JSON.parse(res.body);
  assert.equal(subject_tenant.name, 'Acme Innovations');

  // Verify ACL row written
  const acl = await sql`SELECT * FROM subject_tenant_user WHERE subject_tenant_id = ${subject_tenant.id}`;
  assert.equal(acl.length, 1);
  assert.equal(acl[0].user_id, USER_ID);
  assert.equal(acl[0].role, 'owner');
});

test('POST /v1/subject-tenants 409 on duplicate name within firm', async () => {
  // create twice with same name — second is 409
});

test('POST /v1/subject-tenants 403 for read-only role', async () => {
  // session for a tenant_user with role='viewer' — expect 403
});
```

**Step 2: Implement**

```ts
a.post('/v1/subject-tenants', {
  schema: {
    body: createSubjectTenantBody,
    response: { 201: z.object({ subject_tenant: subjectTenantSchema }) },
  },
}, async (req, reply) => {
  // Auth check: must be admin or consultant
  if (!['admin', 'consultant'].includes(req.activeRole ?? '')) {
    return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'requires admin or consultant role' } });
  }
  return await withTenantContext(req, async (tx) => {
    // dup-check
    const existing = await tx`SELECT id FROM subject_tenant WHERE name = ${req.body.name} AND deleted_at IS NULL`;
    if (existing.length > 0) {
      return reply.code(409).send({ error: { code: 'CONFLICT', message: 'subject_tenant with that name already exists' } });
    }
    const id = crypto.randomUUID();
    const [row] = await tx`
      INSERT INTO subject_tenant (id, tenant_id, name, kind)
      VALUES (${id}, ${req.activeTenantId}, ${req.body.name}, ${req.body.kind})
      RETURNING id, tenant_id, name, kind, created_at, updated_at
    `;
    // ACL row — uses cpa_app's INSERT permission on subject_tenant_user (RLS scope already correct for tenant)
    await tx`
      INSERT INTO subject_tenant_user (subject_tenant_id, user_id, role)
      VALUES (${id}, ${req.user.id}, 'owner')
    `;
    return reply.code(201).send({
      subject_tenant: { ...row, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() },
    });
  });
});
```

**Step 3: Test pass + commit**

```bash
pnpm --filter @cpa/api test
git add apps/api/src/routes/
git commit -m "feat(api): POST /v1/subject-tenants — create claimant + ACL row"
```

---

### Task 16: GET /v1/subject-tenants/:id (detail)

**Files:** modify `apps/api/src/routes/subject-tenants.ts` (+ test)

**Step 1: Failing test**

```ts
test('GET /v1/subject-tenants/:id returns detail with event_count', async () => {
  // seed an event for the test claimant
  // assert response shape: { subject_tenant, event_count, head_hash }
});

test('GET /v1/subject-tenants/:id returns 404 for unknown id', async () => { /* ... */ });
test('GET /v1/subject-tenants/:id returns 404 for cross-firm id', async () => { /* ... */ });
```

**Step 2: Implement**

```ts
a.get('/v1/subject-tenants/:id', {
  schema: {
    params: z.object({ id: z.string().uuid() }),
    response: {
      200: z.object({
        subject_tenant: subjectTenantSchema,
        event_count: z.number(),
        head_hash: z.string().nullable(),
      }),
    },
  },
}, async (req, reply) => {
  return await withTenantContext(req, async (tx) => {
    const rows = await tx`
      SELECT id, tenant_id, name, kind, created_at, updated_at
      FROM subject_tenant WHERE id = ${req.params.id} AND deleted_at IS NULL
    `;
    if (rows.length === 0) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'subject_tenant not found' } });
    const [{ count }] = await tx<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM event WHERE subject_tenant_id = ${req.params.id}
    `;
    const [head] = await tx<{ hash: string }[]>`
      SELECT hash FROM event WHERE subject_tenant_id = ${req.params.id}
      ORDER BY captured_at DESC, received_at DESC, id DESC LIMIT 1
    `;
    const r = rows[0]!;
    return {
      subject_tenant: { ...r, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString() },
      event_count: count, head_hash: head?.hash ?? null,
    };
  });
});
```

**Step 3: Test + commit**

```bash
pnpm --filter @cpa/api test
git commit -am "feat(api): GET /v1/subject-tenants/:id — detail with counts"
```

---

### Task 17: GET /v1/subject-tenants/:id/chain-status

**Step 1: Failing test (seed events, manipulate one hash, expect verified=false)**

**Step 2: Implement using `verifyChain()` from `@cpa/db/chain`**

```ts
a.get('/v1/subject-tenants/:id/chain-status', {
  schema: { params: z.object({ id: z.string().uuid() }) },
}, async (req, reply) => {
  return await withTenantContext(req, async () => {
    // Load the subject_tenant first to enforce RLS access
    const exists = await sql`SELECT 1 FROM subject_tenant WHERE id = ${req.params.id} AND deleted_at IS NULL`;
    if (exists.length === 0) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'subject_tenant not found' } });
    const status = await verifyChain(req.params.id);
    return status;
  });
});
```

(Note: `verifyChain` uses the module-level `sql` client which already has RLS. The `exists` check just enforces 404 for cross-firm.)

**Step 3: Commit**

```bash
git commit -am "feat(api): GET /v1/subject-tenants/:id/chain-status — hash chain integrity"
```

---

### Task 18: POST /v1/events — the demo critical path

**Files:**
- Create: `apps/api/src/routes/events.ts`
- Create: `apps/api/src/routes/events.test.ts`
- Modify: `apps/api/src/server.ts`
- Create: `packages/schemas/src/event.ts`

**Step 1: Schemas**

```ts
// packages/schemas/src/event.ts
import { z } from 'zod';
import { CLASSIFIABLE_KINDS, EVIDENCE_KINDS } from '@cpa/agents/classifier';

export const evidenceKind = z.enum(EVIDENCE_KINDS);
export const classifiableKind = z.enum(CLASSIFIABLE_KINDS);
export const createEventBody = z.object({
  subject_tenant_id: z.string().uuid(),
  raw_text: z.string().min(1).max(50_000),
  captured_at: z.string().datetime().optional(),
});
export const overrideEventBody = z.object({
  new_kind: classifiableKind,
  reason: z.string().min(1).max(1000),
});
export const eventDto = z.object({
  id: z.string().uuid(),
  subject_tenant_id: z.string().uuid(),
  kind: evidenceKind,
  effective_kind: evidenceKind,
  is_overridden: z.boolean(),
  payload: z.record(z.unknown()),
  classification: z.record(z.unknown()).nullable(),
  override_of_event_id: z.string().uuid().nullable(),
  override_new_kind: classifiableKind.nullable(),
  override_reason: z.string().nullable(),
  prev_hash: z.string().nullable(),
  hash: z.string(),
  captured_at: z.string(),
  captured_by_user_id: z.string().uuid(),
  received_at: z.string(),
});
export const listEventsQuery = z.object({
  subject_tenant_id: z.string().uuid(),
  filter: z.enum(['all', 'needs_review', 'ineligible', 'overrides']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
```

Re-export.

**Step 2: Implement POST /v1/events**

```ts
// apps/api/src/routes/events.ts
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from '@cpa/db/client';
import { insertEventWithChain } from '@cpa/db/chain';
import { computeIdempotencyKey, lookupCache, writeCache, withAgentSpan } from '@cpa/agents/runtime';
import { makeClassifier } from '@cpa/agents/classifier';
import { withTenantContext } from '@cpa/auth/rls';
import { createEventBody, eventDto, listEventsQuery, overrideEventBody } from '@cpa/schemas';
import { z } from 'zod';

export const eventsRoute: FastifyPluginAsync = async (app) => {
  const a = app.withTypeProvider<ZodTypeProvider>();
  const classifier = makeClassifier();

  a.post('/v1/events', {
    schema: {
      body: createEventBody,
      response: { 201: z.object({ event: eventDto }) },
    },
  }, async (req, reply) => {
    return await withTenantContext(req, async () => {
      // Verify subject_tenant exists + is in active firm (RLS enforces).
      const st = await sql`
        SELECT id, tenant_id FROM subject_tenant
        WHERE id = ${req.body.subject_tenant_id} AND deleted_at IS NULL
      `;
      if (st.length === 0) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'subject_tenant not found' } });

      const promptVersion = 'classify@1.0.0';
      const idempotencyKey = computeIdempotencyKey(promptVersion, req.body.raw_text);

      // Cache lookup
      const cached = await lookupCache(idempotencyKey);

      const classification = await withAgentSpan(
        'agent.classifier.classify',
        {
          agent_name: 'classifier', prompt_version: promptVersion,
          model: cached?.model ?? 'unknown',
          tenant_id: req.activeTenantId, subject_tenant_id: req.body.subject_tenant_id,
          cache_hit: cached !== null,
        },
        async (setAttr) => {
          if (cached) return { ...(cached.output as object), tokens_in: cached.tokens_in, tokens_out: cached.tokens_out, cache_hit: true } as never;
          const out = await classifier.classify({ raw_text: req.body.raw_text });
          setAttr({ model: out.model, tokens_in: out.tokens_in, tokens_out: out.tokens_out, classification_kind: out.kind, classification_confidence: out.confidence });
          await writeCache({
            idempotency_key: idempotencyKey, agent_name: 'classifier', prompt_version: promptVersion,
            output: out, tokens_in: out.tokens_in, tokens_out: out.tokens_out, model: out.model,
          });
          return { ...out, cache_hit: false } as never;
        },
      );

      // Insert event with chain
      const capturedAt = req.body.captured_at ? new Date(req.body.captured_at) : new Date();
      const inserted = await insertEventWithChain({
        tenant_id: req.activeTenantId,
        subject_tenant_id: req.body.subject_tenant_id,
        kind: (classification as { kind: string }).kind,
        payload: { _v: 1, source: 'paste', raw_text: req.body.raw_text },
        classification: classification as Record<string, unknown>,
        captured_at: capturedAt,
        captured_by_user_id: req.user.id,
        idempotency_key: idempotencyKey,
        override_of_event_id: null, override_new_kind: null, override_reason: null,
      });

      // Read back via the view to populate effective_kind / is_overridden
      const [row] = await sql`
        SELECT * FROM event_with_effective_kind WHERE id = ${inserted.id}
      `;
      return reply.code(201).send({ event: serialiseEvent(row) });
    });
  });
};

function serialiseEvent(r: any): unknown {
  return {
    id: r.id, subject_tenant_id: r.subject_tenant_id,
    kind: r.kind, effective_kind: r.effective_kind, is_overridden: r.is_overridden,
    payload: r.payload, classification: r.classification,
    override_of_event_id: r.override_of_event_id, override_new_kind: r.override_new_kind, override_reason: r.override_reason,
    prev_hash: r.prev_hash, hash: r.hash,
    captured_at: r.captured_at instanceof Date ? r.captured_at.toISOString() : r.captured_at,
    captured_by_user_id: r.captured_by_user_id,
    received_at: r.received_at instanceof Date ? r.received_at.toISOString() : r.received_at,
  };
}
```

**Step 3: Add the `event_with_effective_kind` view** — append to migration 0006 (re-run if needed) OR create a new migration 0007. Use 0007 to avoid touching the prior committed migration.

```sql
-- 0007_effective_kind_view.sql
CREATE OR REPLACE VIEW event_with_effective_kind AS
SELECT e.*,
  COALESCE(
    (SELECT o.override_new_kind FROM event o
     WHERE o.kind = 'OVERRIDE' AND o.override_of_event_id = e.id AND o.tenant_id = e.tenant_id
     ORDER BY o.captured_at DESC, o.received_at DESC, o.id DESC LIMIT 1),
    e.kind
  ) AS effective_kind,
  EXISTS (
    SELECT 1 FROM event o
    WHERE o.kind = 'OVERRIDE' AND o.override_of_event_id = e.id AND o.tenant_id = e.tenant_id
  ) AS is_overridden
FROM event e;

GRANT SELECT ON event_with_effective_kind TO cpa_app;
```

(Drizzle doesn't manage views — hand-author, name `0007_effective_kind_view.sql`, add to `meta/_journal.json` manually OR run `pnpm --filter @cpa/db generate` to refresh meta.)

**Step 4: Tests (extend events.test.ts)**

```ts
test('POST /v1/events → classifier runs, event in chain, cache populated', async () => { /* ... */ });
test('POST /v1/events → second identical request hits cache (cache_hit=true)', async () => { /* ... */ });
test('POST /v1/events → 404 for unknown subject_tenant_id', async () => { /* ... */ });
test('POST /v1/events → 403 for cross-firm subject_tenant_id', async () => { /* ... */ });
test('POST /v1/events → idempotency: two POSTs with same raw_text within same chain produce 2 events but only 1 classifier call', async () => { /* ... */ });
```

(Set `CLASSIFIER_IMPL=stub` in test setup so no Anthropic calls.)

**Step 5: Run + commit**

```bash
pnpm --filter @cpa/api test
git add apps/api/src/routes/events.ts apps/api/src/routes/events.test.ts apps/api/src/server.ts packages/schemas/src/event.ts packages/db/migrations/0007_*.sql packages/db/migrations/meta/
git commit -m "feat(api): POST /v1/events — classifier + chain + idempotency cache"
```

---

### Task 19: GET /v1/events (filter + cursor)

**Step 1: Failing tests for each filter**

```ts
test('GET /v1/events filter=all returns all events newest first', async () => {});
test('GET /v1/events filter=needs_review returns only confidence < 0.7 not-overridden', async () => {});
test('GET /v1/events filter=ineligible returns effective_kind=INELIGIBLE', async () => {});
test('GET /v1/events filter=overrides returns kind=OVERRIDE', async () => {});
test('GET /v1/events cursor pagination wraps correctly', async () => {});
```

**Step 2: Implement**

```ts
a.get('/v1/events', {
  schema: {
    querystring: listEventsQuery,
    response: { 200: z.object({ events: z.array(eventDto), next_cursor: z.string().nullable() }) },
  },
}, async (req) => {
  return await withTenantContext(req, async () => {
    const { subject_tenant_id, filter, limit, cursor } = req.query;
    const cursorClause = cursor ? sql`AND (captured_at, received_at, id) < (${decodeCursor(cursor)})` : sql``;
    const filterClause = (() => {
      switch (filter) {
        case 'all': return sql``;
        case 'needs_review': return sql`AND effective_kind != 'OVERRIDE' AND classification IS NOT NULL AND (classification->>'confidence')::float < 0.7 AND NOT is_overridden`;
        case 'ineligible': return sql`AND effective_kind = 'INELIGIBLE'`;
        case 'overrides': return sql`AND kind = 'OVERRIDE'`;
      }
    })();
    const rows = await sql`
      SELECT * FROM event_with_effective_kind
      WHERE subject_tenant_id = ${subject_tenant_id}
      ${filterClause}
      ${cursorClause}
      ORDER BY captured_at DESC, received_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(serialiseEvent);
    const next = hasMore ? encodeCursor(rows[limit - 1]) : null;
    return { events, next_cursor: next };
  });
});
```

(Implement `encodeCursor`/`decodeCursor` as opaque base64 of `(captured_at, received_at, id)`.)

**Step 3: Run + commit**

```bash
pnpm --filter @cpa/api test
git commit -am "feat(api): GET /v1/events — filters + cursor pagination"
```

---

### Task 20: POST /v1/events/:id/override

**Step 1: Failing tests**

```ts
test('POST /v1/events/:id/override creates OVERRIDE event, original gets is_overridden=true via view', async () => {});
test('POST /v1/events/:id/override 400 for override-of-override attempt', async () => {});
test('POST /v1/events/:id/override 404 for unknown event', async () => {});
test('POST /v1/events/:id/override 404 for cross-firm event', async () => {});
```

**Step 2: Implement**

```ts
a.post('/v1/events/:id/override', {
  schema: {
    params: z.object({ id: z.string().uuid() }),
    body: overrideEventBody,
    response: { 201: z.object({ override_event: eventDto }) },
  },
}, async (req, reply) => {
  return await withTenantContext(req, async () => {
    const orig = await sql`SELECT * FROM event WHERE id = ${req.params.id}`;
    if (orig.length === 0) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'event not found' } });
    if (orig[0].kind === 'OVERRIDE') return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'cannot override an OVERRIDE event' } });
    const inserted = await insertEventWithChain({
      tenant_id: orig[0].tenant_id,
      subject_tenant_id: orig[0].subject_tenant_id,
      kind: 'OVERRIDE',
      payload: { _v: 1, source: 'override', original_event_id: orig[0].id },
      classification: null,
      captured_at: new Date(),
      captured_by_user_id: req.user.id,
      override_of_event_id: orig[0].id,
      override_new_kind: req.body.new_kind,
      override_reason: req.body.reason,
      idempotency_key: null,
    });
    const [row] = await sql`SELECT * FROM event_with_effective_kind WHERE id = ${inserted.id}`;
    return reply.code(201).send({ override_event: serialiseEvent(row) });
  });
});
```

**Step 3: Run + commit**

```bash
pnpm --filter @cpa/api test
git commit -am "feat(api): POST /v1/events/:id/override — consultant override extends chain"
```

---

## Phase 5 — Portal UI (T21-T26)

**Pre-flight:** Ensure shadcn `<Tabs>`, `<Dialog>`, `<Select>`, `<Textarea>`, `<Card>`, `<Badge>`, `<Button>`, `<Toast>` are installed. From the `apps/web` directory:

```bash
cd apps/web
pnpm dlx shadcn@latest add tabs select textarea card badge --yes 2>&1 | head -50
```

(Existing components from P1: button, dialog, dropdown, label, toast.)

### Task 21: `/subject-tenants` list page

**Files:**
- Create: `apps/web/src/app/(authed)/subject-tenants/page.tsx`
- Create: `apps/web/src/app/(authed)/subject-tenants/_lib/api.ts` (typed fetch helpers)

**Step 1: api.ts**

```ts
import type { SubjectTenant } from '@cpa/schemas';

export async function listSubjectTenants(): Promise<SubjectTenant[]> {
  const res = await fetch('/api/v1/subject-tenants', { credentials: 'include' });
  if (!res.ok) throw new Error('failed to list claimants');
  const body = await res.json();
  return body.subject_tenants;
}

export async function createSubjectTenant(input: { name: string; kind: 'claimant' | 'financier' }): Promise<SubjectTenant> {
  const res = await fetch('/api/v1/subject-tenants', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json()).error?.message ?? 'failed to create claimant');
  return (await res.json()).subject_tenant;
}
```

**Step 2: page.tsx (server component → renders client list)**

```tsx
import { Suspense } from 'react';
import { SubjectTenantList } from './_components/subject-tenant-list.js';
import { CreateClaimantButton } from './_components/create-claimant-button.js';

export default function SubjectTenantsPage() {
  return (
    <div className="container py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Claimants</h1>
        <CreateClaimantButton />
      </div>
      <Suspense fallback={<div>Loading...</div>}>
        <SubjectTenantList />
      </Suspense>
    </div>
  );
}
```

**Step 3: SubjectTenantList client component**

```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { listSubjectTenants } from '../_lib/api.js';

export function SubjectTenantList() {
  const { data, isPending, error } = useQuery({
    queryKey: ['subject-tenants'],
    queryFn: listSubjectTenants,
  });
  if (isPending) return <div>Loading...</div>;
  if (error) return <div className="text-red-600">Error: {(error as Error).message}</div>;
  if (data.length === 0) return <div className="text-muted-foreground">No claimants yet. Click "Create claimant" to begin.</div>;
  return (
    <ul className="space-y-2">
      {data.map((st) => (
        <li key={st.id} className="border rounded p-4 hover:bg-muted">
          <Link href={`/subject-tenants/${st.id}`} className="font-medium">{st.name}</Link>
          <span className="ml-2 text-xs text-muted-foreground">{st.kind}</span>
        </li>
      ))}
    </ul>
  );
}
```

**Step 4: Test (build only)**

```bash
pnpm --filter @cpa/web build
```

(Component-level tests deferred to e2e.)

**Step 5: Commit**

```bash
git add apps/web/src/app/\(authed\)/subject-tenants/page.tsx apps/web/src/app/\(authed\)/subject-tenants/_lib/api.ts apps/web/src/app/\(authed\)/subject-tenants/_components/subject-tenant-list.tsx
git commit -m "feat(web): /subject-tenants — list page (read-only)"
```

---

### Task 22: Create claimant modal

**Files:**
- Create: `apps/web/src/app/(authed)/subject-tenants/_components/create-claimant-button.tsx`

**Step 1: Implement**

```tsx
'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { createSubjectTenantBody } from '@cpa/schemas';
import { createSubjectTenant } from '../_lib/api.js';

export function CreateClaimantButton() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const form = useForm({ resolver: zodResolver(createSubjectTenantBody), defaultValues: { name: '', kind: 'claimant' as const } });
  const mut = useMutation({
    mutationFn: createSubjectTenant,
    onSuccess: (st) => {
      qc.invalidateQueries({ queryKey: ['subject-tenants'] });
      setOpen(false);
      router.push(`/subject-tenants/${st.id}`);
    },
    onError: (e) => toast({ title: 'Failed', description: (e as Error).message, variant: 'destructive' }),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button>Create claimant</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Create claimant</DialogTitle></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => mut.mutate(v))} className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" {...form.register('name')} data-testid="claimant-name-input" />
          </div>
          <div>
            <Label>Kind</Label>
            <Select onValueChange={(v: 'claimant' | 'financier') => form.setValue('kind', v)} defaultValue="claimant">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="claimant">Claimant</SelectItem>
                <SelectItem value="financier">Financier</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={mut.isPending} data-testid="create-claimant-submit">
            {mut.isPending ? 'Creating...' : 'Create'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Build + commit**

```bash
pnpm --filter @cpa/web build
git add apps/web/src/app/\(authed\)/subject-tenants/_components/create-claimant-button.tsx
git commit -m "feat(web): create-claimant modal — POST /v1/subject-tenants"
```

---

### Task 23: `/subject-tenants/[id]` detail page + ChainStatusBadge

**Files:**
- Create: `apps/web/src/app/(authed)/subject-tenants/[id]/page.tsx`
- Create: `apps/web/src/app/(authed)/subject-tenants/[id]/_components/chain-status-badge.tsx`
- Create: `apps/web/src/app/(authed)/subject-tenants/[id]/_lib/api.ts` (extend with detail + chain-status fetchers)

Implement:
- `page.tsx`: fetches detail server-side, renders header (name + chain badge + event count), then placeholders for paste-form and feed
- `chain-status-badge.tsx`: client component, calls GET chain-status, renders green ✓ or red break

```bash
git commit -am "feat(web): subject-tenant detail page + chain status badge"
```

---

### Task 24: PasteForm + EventCard + KindChip + ConfidenceChip

**Files:** several `_components/`. Implement per design doc §5.4. Each is a client component.

Wire into `[id]/page.tsx` so the demo screen exists end-to-end.

```bash
git commit -am "feat(web): paste form + event card + kind/confidence chips"
```

---

### Task 25: FilterTabs (with live counts)

**Files:** `_components/filter-tabs.tsx`. Uses `<Tabs>` from shadcn. Drives URL search param `?filter=…`. Counts come from a parallel `useQuery` per filter (fast for P2; replace with single count endpoint later).

```bash
git commit -am "feat(web): filter tabs (all/needs review/ineligible/overrides) with live counts"
```

---

### Task 26: OverrideModal

**Files:** `_components/override-modal.tsx`. Triggered by [Override] button on EventCard. Uses `<Select>` for new_kind + `<Textarea>` for reason. POSTs to `/api/v1/events/:id/override`. On success: invalidate events query.

```bash
git commit -am "feat(web): override modal — POST /v1/events/:id/override"
```

---

## Phase 6 — End-to-end tests (T27-T31)

All e2e specs run with `CLASSIFIER_IMPL=stub` so classifier output is deterministic. Re-use the e2e fixtures from W5 (`apps/web/e2e/fixtures/auth.ts`, `test-data.ts`); extend `test-data.ts` with `seedSubjectTenant` and `seedEvent` helpers.

### Task 27: e2e — subject-tenants-list

**File:** `apps/web/e2e/subject-tenants-list.spec.ts`

Asserts:
- Login as admin
- Navigate to `/subject-tenants`
- See seeded claimants in list
- Click "Create claimant"
- Modal opens; fill name; submit
- URL changes to `/subject-tenants/[new-id]`
- Cleanup: delete seeded claimant by name prefix

```bash
git commit -am "test(web): e2e subject-tenants-list (list + create)"
```

### Task 28: e2e — paste-classify-feed

Asserts:
- Login + go to `/subject-tenants/[id]`
- Type into the paste textarea
- Click Classify
- Event card appears in feed with kind chip + confidence chip + statutory anchor (per StubClassifier output)

### Task 29: e2e — low-confidence-filter

Asserts:
- Paste an "ambiguous" transcript that StubClassifier returns < 0.7 confidence on (e.g., the SUPPORTING fallthrough at 0.5)
- Switch to "Needs Review" tab
- Event visible there
- Switch to "All" — also visible
- Switch to "Ineligible" — not visible

### Task 30: e2e — override-flow

Asserts:
- Seed an event
- Page loads
- Click [Override] on the card
- Modal opens with current kind preselected
- Change kind to OBSERVATION + type reason
- Submit
- Modal closes
- Original event card now shows "Overridden" badge
- New OVERRIDE event card visible with new kind
- Switch to "Overrides" tab — only the override event visible

### Task 31: e2e — chain-verification

Asserts:
- Page loads → "Verified ✓" badge visible
- (Test-only) corrupt one event hash via privileged fixture
- Reload page → badge shows "Hash break detected at event #N"
- (Cleanup) restore hash

```bash
git commit -am "test(web): e2e chain verification (verify ✓ + tamper detection)"
```

---

## Phase 7 — Documentation (T32-T33)

### Task 32: ADR 0003 — event chain & classifier

**File:** `docs/decisions/0003-event-chain-and-classifier.md`

Captures:
- Per-`subject_tenant` chain decision
- Hash canonicalisation form
- Advisory-lock concurrency
- Dual-impl classifier (Haiku + Stub) and the `CLASSIFIER_IMPL` env contract
- Idempotency cache keying scheme
- Override semantics (append-only, never mutate)
- RLS column-on-event vs subquery decision

```bash
git commit -am "docs(adr): ADR-0003 — event chain & classifier architecture"
```

### Task 33: README updates

**Files:**
- `packages/agents/README.md` (new)
- Root `README.md` (mention P2 evidence capture)

```bash
git commit -am "docs: README updates for @cpa/agents + P2 in root"
```

---

## Acceptance criteria (overall P2 gate)

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm format:check` all green locally
- [ ] CI green on `p2/event-capture` (both `ci` and `e2e` jobs)
- [ ] Cold-start: `docker compose down -v && docker compose up -d postgres && pnpm db:migrate && pnpm test` green
- [ ] Manual smoke: log in → /subject-tenants → create claimant → paste a transcript → see classified event → override it → see override; "Verified ✓" badge present; "Needs Review" tab works
- [ ] HaikuClassifier tested against a real Anthropic call at least once locally (developer-side acceptance only, not in CI)
- [ ] ADR-0003 committed
- [ ] All commits include co-author trailer

## Execution

Use `superpowers:subagent-driven-development` to execute task-by-task with two-stage review (spec → quality) after each.
