# P2 — Event Capture Vertical Slice — Design

**Date:** 2026-04-27
**Status:** Approved (Sections 1–5 confirmed live with user; Sections 2-6 finalised autonomously per user directive)
**Author:** Aaron Newson + AI pair (Claude Opus 4.7 1M)
**Builds on:** [P1 Identity & Tenancy](./2026-04-26-p1-identity-tenancy-design.md) (branch `p1/identity-tenancy`, head at this branch's parent)
**Source spec:** [Architecture design §3 + §4 + §6 P2 row](./2026-04-25-rdti-grants-platform-design.md)
**Product spec:** [Omniscient Feature Architecture](../product/2026-04-27-omniscient-feature-spec.md) (canonical) + [Spec ↔ Phase Mapping](../product/2026-04-27-spec-to-phase-mapping.md)
**Modules covered:** Module 1 core (Evidence & Compliance Engine — hash chain, evidence kinds, override semantics, Division 355 anchors), Module 2 ground floor (classifier agent with citation-grounded statutory anchors)
**Pillars advanced:** 1 (compliance-grade), 2 (augmentation via override + needs-review queue), 3 (AU-native — Division 355), 4 (closed system, citation-grounded), 5 (multi-tenant — RLS extended to event)

---

## 0. Decision summary

| # | Question | Decision (autonomous unless noted) |
|---|---|---|
| Q1 | Scope precision | **C — Full event vertical**: paste form + classifier + feed + confidence chips + "Needs Review" filter + inline override modal + hash-chain "Verified ✓" badge (user-confirmed) |
| Q2 | Anthropic API integration | **B — Real Haiku in dev/prod, deterministic Stub in CI**, behind `CLASSIFIER_IMPL` env flag, with Postgres-backed idempotency cache in front of both impls (user-confirmed) |
| Q3 | Schema linking dimensions | **B — Schema future-proof**: nullable `project_id` and `milestone_id` columns on `event` from day one; no `project` or `milestone` tables yet (user-confirmed) |
| Q4 | Portal IA | **A — URL-driven**: `/subject-tenants` (list+create) and `/subject-tenants/[id]` (paste+feed+override) (user-confirmed) |
| Q5 | Subject-tenant creation + access | **B — Portal UI creation, tenant-wide visibility, ACL row written on create but not enforced on read** (user-confirmed) |
| Q6 | Effective-kind resolution | Server resolves via SQL view; frontend treats `effective_kind` as authoritative for filter tabs |
| Q7 | Confidence threshold for "Needs Review" | `0.7` (slightly higher than the architecture doc's `0.6` — compliance-grade caution; configurable via env) |
| Q8 | Hash chain canonicalisation | Sorted-key JSON of `{subject_tenant_id, kind, payload, classification, captured_at, captured_by_user_id, override_of_event_id, override_new_kind, override_reason}`, SHA-256 over UTF-8 bytes, hex-encoded for storage |
| Q9 | Concurrent insert serialisation | `pg_advisory_xact_lock(hash_subject_tenant_id_to_bigint)` inside the insert transaction. Race-free without serialising all writes globally |
| Q10 | Idempotency key scope | `SHA256(prompt_version ‖ raw_text)`. Unique partial index on `event.idempotency_key WHERE idempotency_key IS NOT NULL` |
| Q11 | Cost telemetry storage | OTel span attributes only (no separate aggregate table in P2). Per-tenant rollup deferred to P9 |
| Q12 | RLS on event table | `tenant_id` column on event for direct policy match (not via subject_tenant subquery — keeps the hot-path policy index-friendly) |
| Q13 | Subject_tenant_user creator role | `'owner'` (matches consultant who created claimant). Deferred until ACL enforcement turns on |

---

## 1. Scope contract

### 1.1 In scope

The vertical slice — the demo:

> Consultant logs in → `/subject-tenants` (list of firm's claimants, "Create claimant" button) → `/subject-tenants/[id]` → pastes transcript text → clicks **Classify** → backend runs Division 355 classifier → event appears in feed below the paste form with `kind` chip + `confidence` chip + statutory anchor + rationale + **Override** button → low-confidence events route into a "Needs Review" filter tab → Override opens modal (kind dropdown + reason textarea) → Submit creates new `OVERRIDE` event linked to original → both events visible, original card shows "overridden" pill.

What ships behind the demo:

| Layer | Deliverables |
|---|---|
| Schema | `event` table (append-only, hash-chained, 13 evidence kinds), `agent_call_cache` table (idempotency), nullable `project_id` + `milestone_id` columns on `event` |
| Runtime | `packages/agents/runtime/` — Anthropic SDK wrapper, prompt registry, idempotency cache, OTel spans, structured tool-use output |
| Agent | `packages/agents/classifier/` — `HaikuClassifier` + `StubClassifier`, both satisfying the same `Classifier` interface |
| API | `POST /v1/subject-tenants`, `GET /v1/subject-tenants`, `GET /v1/subject-tenants/:id`, `GET /v1/subject-tenants/:id/chain-status`, `POST /v1/events`, `GET /v1/events`, `POST /v1/events/:id/override` |
| Portal | `/subject-tenants` (list + Create modal), `/subject-tenants/[id]` (paste + feed + filter + Override modal) |
| Tests | Unit (runtime, classifier impls, hash chain), API (per endpoint), e2e (paste→classify→feed→override) |

### 1.2 Out of scope (deferred)

| Item | Phase |
|---|---|
| Mobile Scribe / voice / offline event capture | P3 |
| Documents / PDFs / Activity Schedule rendering | P4–P5 |
| Project CRUD UI; populate `event.project_id` | P4 |
| Grants programs, agreements, milestones; populate `event.milestone_id` | P6–P7 |
| Federation, delegation tokens, financier surfaces | P8 |
| Per-claimant ACL **read** enforcement (write happens already) | TBD (when multi-consultant access becomes a real customer ask) |
| Live-update via SSE / WebSocket (polling-on-paste is enough for P2) | P3+ |
| Bulk import (CSV / API-driven ingestion) | Later |
| Cost rollup dashboards (per-tenant Anthropic spend) | P9 |
| Idempotency cache TTL cleanup cron | P9 |

### 1.3 Package additions

```
apps/consultant-portal/src/app/(authed)/subject-tenants/
  page.tsx                              # list + create modal
  [id]/page.tsx                         # demo screen
  [id]/components/paste-form.tsx
  [id]/components/event-feed.tsx
  [id]/components/event-card.tsx
  [id]/components/override-modal.tsx
  [id]/components/filter-tabs.tsx
  [id]/components/chain-status-badge.tsx

apps/api/src/routes/
  subject-tenants.ts                    # NEW: POST, GET list, GET detail, GET chain-status
  events.ts                             # NEW: POST, GET, POST :id/override

packages/agents/                        # NEW package
  src/runtime/
    anthropic-client.ts                 # SDK init + retry policy
    prompt-registry.ts                  # loads prompts/<agent>/<name>@<semver>.ts
    idempotency.ts                      # Postgres-backed cache
    telemetry.ts                        # OTel span helpers
    tool-use.ts                         # structured-output helper
    types.ts
    index.ts
  src/classifier/
    types.ts                            # Classifier interface, EvidenceKind enum
    haiku.ts                            # HaikuClassifier (real)
    stub.ts                             # StubClassifier (deterministic regex)
    factory.ts                          # selects impl from CLASSIFIER_IMPL
    prompts/
      classify@1.0.0.ts                 # versioned prompt + tool schema
    fixtures/
      *.json                            # I/O pairs for replay tests
    index.ts
  package.json
  tsconfig.json
  tsconfig.test.json
  eslint.config.mjs

packages/db/src/schema/
  event.ts                              # NEW
  agent_call_cache.ts                   # NEW

packages/db/migrations/
  0006_<adj>_<noun>.sql                 # event + agent_call_cache + indexes + RLS + chain helper
```

---

## 2. Data model

### 2.1 `event` — append-only chain

```ts
// packages/db/src/schema/event.ts
export const event = pgTable(
  'event',
  {
    id: uuid('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenant_id: uuid('tenant_id').notNull().references(() => tenant.id),
    subject_tenant_id: uuid('subject_tenant_id')
      .notNull()
      .references(() => subject_tenant.id),
    project_id: uuid('project_id'),                        // nullable, FK target arrives in P4
    milestone_id: uuid('milestone_id'),                    // nullable, FK target arrives in P7
    kind: text('kind', { enum: EVIDENCE_KINDS }).notNull(),
    payload: jsonb('payload').$type<EventPayload>().notNull(),
    classification: jsonb('classification').$type<Classification | null>(),
    override_of_event_id: uuid('override_of_event_id'),    // self-FK; only set when kind='OVERRIDE'
    override_new_kind: text('override_new_kind', { enum: EVIDENCE_KINDS }),  // only set when kind='OVERRIDE'
    override_reason: text('override_reason'),              // only set when kind='OVERRIDE'
    prev_hash: text('prev_hash'),                          // hex; null for first event in chain
    hash: text('hash').notNull().unique(),                 // hex
    idempotency_key: text('idempotency_key'),              // hex; nullable for OVERRIDE events
    captured_at: timestamp('captured_at', { withTimezone: true }).notNull(),
    captured_by_user_id: uuid('captured_by_user_id')
      .notNull()
      .references(() => user.id),
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    feedIdx: index('event_feed_idx').on(t.subject_tenant_id, t.captured_at.desc()),
    kindIdx: index('event_kind_idx').on(t.subject_tenant_id, t.kind),
    overrideIdx: index('event_override_idx').on(t.override_of_event_id),
    idempotencyUnique: uniqueIndex('event_idempotency_unique')
      .on(t.idempotency_key)
      .where(sql`${t.idempotency_key} IS NOT NULL`),
  }),
);
```

**Evidence kinds (13 total):**

```ts
export const EVIDENCE_KINDS = [
  'HYPOTHESIS',     'DESIGN',          'EXPERIMENT',      'OBSERVATION',
  'ITERATION',      'NEW_KNOWLEDGE',   'UNCERTAINTY',     'TIME_LOG',
  'ASSOCIATE_FLAG', 'EXPENDITURE_NOTE','SUPPORTING',      'INELIGIBLE',
  'OVERRIDE',       // implementation-only — never authored by classifier
] as const;
```

The first 12 mirror architecture doc §4. `OVERRIDE` is consultant-authored and never produced by a classifier.

**Payload shape (versioned via `payload._v`):**

```ts
type EventPayload =
  | { _v: 1; source: 'paste'; raw_text: string }
  | { _v: 1; source: 'override'; original_event_id: string }; // shape grows in P3 (mobile/voice)
```

**Classification shape:**

```ts
type Classification = {
  kind: EvidenceKind;             // never 'OVERRIDE'
  confidence: number;             // 0..1
  rationale: string;              // ≤ 500 chars
  statutory_anchor: string | null;// e.g. '§355-25(1)(a)'
  model: string;                  // 'claude-haiku-4-5' | 'stub-v1.0.0'
  prompt_version: string;         // e.g. 'classify@1.0.0'
  tokens_in: number;
  tokens_out: number;
  cache_hit: boolean;             // true if served from idempotency cache
};
```

For `kind = 'OVERRIDE'`, `classification` is `null` (the override is consultant-authored, not classifier-produced).

### 2.2 Hash chain semantics

**Per-`subject_tenant` chain.** Two claimants under the same firm have independent chains; bounds verification cost; makes export self-contained.

**Canonicalisation:**

```ts
function canonical(e: EventForHashing): string {
  // Stable JSON: sorted keys, ISO-8601 timestamps, no whitespace.
  return canonicalJsonStringify({
    subject_tenant_id: e.subject_tenant_id,
    kind: e.kind,
    payload: e.payload,
    classification: e.classification,         // null OK
    captured_at: e.captured_at.toISOString(),
    captured_by_user_id: e.captured_by_user_id,
    override_of_event_id: e.override_of_event_id ?? null,
    override_new_kind: e.override_new_kind ?? null,
    override_reason: e.override_reason ?? null,
  });
}

function hashEvent(prevHash: string | null, e: EventForHashing): string {
  const input = (prevHash ?? '') + canonical(e);
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}
```

**`prev_hash` resolution rule:** the `hash` of the most recent event for the same `subject_tenant_id`, deterministic-ordered by `(captured_at DESC, received_at DESC, id DESC)`. NULL only if no prior event exists.

**Concurrency:** insertion is wrapped in a transaction holding `pg_advisory_xact_lock(hashtext('event_chain_' || subject_tenant_id::text))`. Two concurrent POSTs against the same claimant serialise; concurrent POSTs against different claimants don't block each other. The lock auto-releases at transaction end.

**Verification (`GET /v1/subject-tenants/:id/chain-status`):**

```ts
async function verifyChain(subjectTenantId: string): Promise<ChainStatus> {
  const events = await db
    .select()
    .from(event)
    .where(eq(event.subject_tenant_id, subjectTenantId))
    .orderBy(event.captured_at, event.received_at, event.id);
  let prev: string | null = null;
  let head: string | null = null;
  let firstBreak: number | null = null;
  for (const [i, e] of events.entries()) {
    const expected = hashEvent(prev, e);
    if (e.prev_hash !== prev || e.hash !== expected) {
      firstBreak = i;
      break;
    }
    prev = e.hash;
    head = e.hash;
  }
  return { verified: firstBreak === null, head_hash: head, event_count: events.length, first_break_at: firstBreak };
}
```

UI calls this on detail-page mount; renders `Verified ✓` (green) or `Hash break detected — chain integrity compromised at event ${firstBreak}` (red).

### 2.3 `agent_call_cache` — idempotency cache

```ts
export const agent_call_cache = pgTable('agent_call_cache', {
  idempotency_key: text('idempotency_key').primaryKey(),    // hex SHA-256
  agent_name: text('agent_name').notNull(),                 // 'classifier'
  prompt_version: text('prompt_version').notNull(),         // 'classify@1.0.0'
  output: jsonb('output').$type<Classification>().notNull(),
  tokens_in: integer('tokens_in').notNull(),
  tokens_out: integer('tokens_out').notNull(),
  model: text('model').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Not RLS-protected — content-addressed by `idempotency_key = SHA256(prompt_version ‖ raw_text)`. Same input ⇒ same key ⇒ same cache hit, regardless of tenant. (Per architecture §3 idempotency discipline.) TTL cleanup deferred to P9.

### 2.4 RLS

**`event`** — direct `tenant_id` column on the row.

```sql
ALTER TABLE event ENABLE ROW LEVEL SECURITY;
ALTER TABLE event FORCE ROW LEVEL SECURITY;

CREATE POLICY event_tenant_isolation ON event
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
```

`tenant_id` is denormalised onto event (not derived via `subject_tenant_id`-subquery) so that the policy doesn't trigger a sub-select on every read of the hottest table in the system. The API layer also adds `WHERE subject_tenant_id = X` for claimant scope — defense in depth.

**`agent_call_cache`** — no RLS (content-addressed; not tenant-scoped data).

### 2.5 Override semantics

`OVERRIDE` events:
- `kind = 'OVERRIDE'`
- `override_of_event_id` references the original event
- `override_new_kind` is the consultant's revised classification
- `override_reason` is the consultant's text
- `payload = { _v: 1, source: 'override', original_event_id }`
- `classification = null`
- Hash chain extends as normal — the override is itself a chain entry

**Effective-kind resolution** (server-side SQL view to keep frontend simple):

```sql
CREATE VIEW event_with_effective_kind AS
SELECT e.*,
  COALESCE(
    (SELECT o.override_new_kind
     FROM event o
     WHERE o.kind = 'OVERRIDE'
       AND o.override_of_event_id = e.id
       AND o.tenant_id = e.tenant_id
     ORDER BY o.captured_at DESC, o.received_at DESC, o.id DESC
     LIMIT 1),
    e.kind
  ) AS effective_kind,
  EXISTS (
    SELECT 1 FROM event o
    WHERE o.kind = 'OVERRIDE'
      AND o.override_of_event_id = e.id
      AND o.tenant_id = e.tenant_id
  ) AS is_overridden
FROM event e;
```

API reads use the view; filter tabs filter on `effective_kind`. Hash chain still walks the raw event table (override events are part of the chain).

---

## 3. Agent runtime + classifier

### 3.1 `packages/agents/runtime/`

**Anthropic client:**

```ts
// runtime/anthropic-client.ts
import Anthropic from '@anthropic-ai/sdk';

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required (or set CLASSIFIER_IMPL=stub)');
  return new Anthropic({ apiKey, maxRetries: 3, timeout: 30_000 });
}
```

**Prompt registry:**

```ts
// runtime/prompt-registry.ts
import { z } from 'zod';

export type PromptDefinition<TInput, TOutput> = {
  version: string;                  // semver, e.g. '1.0.0'
  name: string;                     // 'classify'
  system: string;                   // system prompt
  tool: { name: string; description: string; input_schema: z.ZodType<TOutput> };
  // Optional: example inputs/outputs for fixture tests
};

const PROMPTS = new Map<string, PromptDefinition<unknown, unknown>>();

export function registerPrompt<I, O>(p: PromptDefinition<I, O>): void {
  PROMPTS.set(`${p.name}@${p.version}`, p as PromptDefinition<unknown, unknown>);
}

export function getPrompt<I, O>(key: string): PromptDefinition<I, O> {
  const p = PROMPTS.get(key);
  if (!p) throw new Error(`prompt not registered: ${key}`);
  return p as PromptDefinition<I, O>;
}
```

Prompts are imported from `packages/agents/<agent>/prompts/<name>@<semver>.ts`; importing the file calls `registerPrompt(...)` as a side-effect. Runtime-loaded once at module init.

**Idempotency cache (Postgres-backed):**

```ts
// runtime/idempotency.ts
import { sql } from '@cpa/db/client';

export function computeIdempotencyKey(promptKey: string, rawInput: string): string {
  return crypto.createHash('sha256').update(promptKey + ' ' + rawInput, 'utf8').digest('hex');
}

export async function lookupCache(key: string): Promise<CachedAgentCall | null> {
  const rows = await sql`
    SELECT idempotency_key, agent_name, prompt_version, output, tokens_in, tokens_out, model
    FROM agent_call_cache
    WHERE idempotency_key = ${key}
  `;
  return rows[0] ?? null;
}

export async function writeCache(entry: CachedAgentCall): Promise<void> {
  await sql`
    INSERT INTO agent_call_cache (idempotency_key, agent_name, prompt_version, output, tokens_in, tokens_out, model)
    VALUES (${entry.idempotency_key}, ${entry.agent_name}, ${entry.prompt_version},
            ${entry.output}::jsonb, ${entry.tokens_in}, ${entry.tokens_out}, ${entry.model})
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
}
```

**Telemetry:**

```ts
// runtime/telemetry.ts
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('@cpa/agents');

export async function withAgentSpan<T>(
  agentName: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(`agent.${agentName}`, async (span) => {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(`cpa.${k}`, v);
    try {
      const r = await fn();
      span.setStatus({ code: 1 });
      return r;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: 2, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}
```

Span attributes: `agent_name`, `prompt_version`, `model`, `tenant_id`, `subject_tenant_id`, `tokens_in`, `tokens_out`, `cache_hit`, `latency_ms`.

**Tool-use helper:**

```ts
// runtime/tool-use.ts
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
      input_schema: zodToJsonSchema(args.tool.input_schema),  // tiny inline impl
    }],
    tool_choice: { type: 'tool', name: args.tool.name },
  });
  const block = res.content.find((c) => c.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
  if (!block) throw new Error('classifier did not invoke the structured-output tool');
  const parsed = args.tool.input_schema.parse(block.input);
  return { output: parsed, tokens_in: res.usage.input_tokens, tokens_out: res.usage.output_tokens };
}
```

### 3.2 `packages/agents/classifier/`

**Interface (`types.ts`):**

```ts
export type ClassifierInput = { raw_text: string };

export type ClassifierOutput = {
  kind: Exclude<EvidenceKind, 'OVERRIDE'>;  // classifier never produces OVERRIDE
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

**Real impl (`haiku.ts`):**

Uses runtime/anthropic-client + tool-use. System prompt embeds Division 355 statutory anchors:

> You are an expert R&DTI compliance classifier for the Australian R&D Tax Incentive (Division 355 ITAA 1997). You receive a single piece of evidence (transcript text, lab note, voice memo, etc.) and classify it into one of 12 evidence kinds. You also identify the statutory anchor where applicable: §355-25(1)(a) (core R&D activity — outcome could not be known in advance to a competent professional in the field), §355-25(2)(a) (ordinary-business exclusion), §355-30 (supporting activity test), or null. ...

Tool schema (`prompts/classify@1.0.0.ts`):

```ts
import { z } from 'zod';
import { registerPrompt } from '@cpa/agents/runtime';

const classifySchema = z.object({
  kind: z.enum([...12 evidence kinds, excluding OVERRIDE]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(500),
  statutory_anchor: z.string().nullable(),
});

registerPrompt({
  name: 'classify',
  version: '1.0.0',
  system: `<see above>`,
  tool: {
    name: 'classify_evidence',
    description: 'Classify a piece of R&D evidence per Australian R&DTI Division 355.',
    input_schema: classifySchema,
  },
});
```

**Stub impl (`stub.ts`):**

Deterministic regex over `raw_text`, ordered priority. Each rule contributes a kind, a confidence, and a rationale. Matches the architecture's "regex/keyword pre-filter" intent (architecture §7 risk #5):

```ts
const STUB_RULES: Array<{ pattern: RegExp; kind: EvidenceKind; confidence: number; rationale: string; anchor: string | null }> = [
  // Order matters — earlier rules win.
  { pattern: /\b(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b|\btime spent\b)/i, kind: 'TIME_LOG', confidence: 0.92, rationale: 'Stub: time-quantity vocabulary', anchor: null },
  { pattern: /\b(associate|related party|spouse|director'?s? (?:wife|husband|spouse|family))/i, kind: 'ASSOCIATE_FLAG', confidence: 0.85, rationale: 'Stub: associate / related-party vocabulary', anchor: null },
  { pattern: /\$\s?\d|invoice|paid\s+\$|expense (?:was|of|incurred)|cost (?:was|of|incurred)/i, kind: 'EXPENDITURE_NOTE', confidence: 0.80, rationale: 'Stub: expenditure vocabulary', anchor: null },
  { pattern: /\b(routine|standard|business as usual|bau|just our normal|usual practice)\b/i, kind: 'INELIGIBLE', confidence: 0.72, rationale: 'Stub: ordinary-business vocabulary', anchor: '§355-25(2)(a)' },
  { pattern: /\b(hypothes[ie][sz]e?|posit(?:ed|ing)?|theoris[ed]|theoriz[ed]|predict(?:ed|ion))\b/i, kind: 'HYPOTHESIS', confidence: 0.85, rationale: 'Stub: hypothesis-formation vocabulary', anchor: '§355-25(1)(a)' },
  { pattern: /\b(experiment|trial|run\s+(?:a|the)\s+test|measur(?:ed|ement))\b/i, kind: 'EXPERIMENT', confidence: 0.85, rationale: 'Stub: experimental vocabulary', anchor: '§355-25(1)(a)' },
  { pattern: /\b(observ(?:ed|ation)|noticed|recorded|logged that)\b/i, kind: 'OBSERVATION', confidence: 0.78, rationale: 'Stub: observational vocabulary', anchor: '§355-25(1)(a)' },
  { pattern: /\b(iter(?:ate|ation)|refin(?:e|ed)|revis(?:e|ed)|adjust(?:ed)?)\b/i, kind: 'ITERATION', confidence: 0.75, rationale: 'Stub: iteration vocabulary', anchor: '§355-25(1)(a)' },
  { pattern: /\b(uncertain(?:ty)?|unsure|unknown|unclear|ambiguous|edge case)\b/i, kind: 'UNCERTAINTY', confidence: 0.80, rationale: 'Stub: uncertainty vocabulary', anchor: '§355-25(1)(a)' },
  { pattern: /\b(learned|discover(?:ed|y)|insight|finding|conclud(?:e|ed))\b/i, kind: 'NEW_KNOWLEDGE', confidence: 0.78, rationale: 'Stub: new-knowledge vocabulary', anchor: '§355-25(1)(a)' },
  { pattern: /\b(design|architecture|blueprint|schematic|spec(?:ification)?)\b/i, kind: 'DESIGN', confidence: 0.78, rationale: 'Stub: design vocabulary', anchor: null },
];

export class StubClassifier implements Classifier {
  async classify({ raw_text }: ClassifierInput): Promise<ClassifierOutput> {
    for (const rule of STUB_RULES) {
      if (rule.pattern.test(raw_text)) {
        return {
          kind: rule.kind, confidence: rule.confidence, rationale: rule.rationale, statutory_anchor: rule.anchor,
          model: 'stub-v1.0.0', prompt_version: 'classify@1.0.0', tokens_in: 0, tokens_out: 0,
        };
      }
    }
    return {
      kind: 'SUPPORTING', confidence: 0.50,
      rationale: 'Stub: no specific match; defaulting to SUPPORTING per §355-30',
      statutory_anchor: '§355-30',
      model: 'stub-v1.0.0', prompt_version: 'classify@1.0.0', tokens_in: 0, tokens_out: 0,
    };
  }
}
```

**Factory:**

```ts
// classifier/factory.ts
export function makeClassifier(): Classifier {
  const impl = process.env.CLASSIFIER_IMPL ?? (process.env.CI ? 'stub' : 'haiku');
  switch (impl) {
    case 'stub': return new StubClassifier();
    case 'haiku': return new HaikuClassifier();
    default: throw new Error(`unknown CLASSIFIER_IMPL: ${impl}`);
  }
}
```

CI defaults to `stub` (no Anthropic API key needed); dev/prod default to `haiku`. Override is explicit for incident-response circuit-breaker.

---

## 4. API contract

All endpoints under `/v1`; Fastify + zod schemas; auth via existing P1 session middleware which sets `app.current_tenant_id` GUC for the request transaction.

### 4.1 `POST /v1/subject-tenants`

**Body:** `{ name: string, kind?: 'claimant' | 'financier' }` (default `'claimant'`)

**Auth:** any tenant_user with `role IN ('admin', 'consultant')` in the active firm

**Effect:**
1. Validate body
2. INSERT subject_tenant with `tenant_id = active firm`
3. INSERT subject_tenant_user `(subject_tenant_id, user_id = req.user, role = 'owner')` — written but not enforced on read in P2
4. Return the created row

**Response 201:** `{ subject_tenant: SubjectTenant }`

**Errors:** 400 (validation), 401 (no session), 403 (read-only role), 409 (duplicate name within firm)

### 4.2 `GET /v1/subject-tenants`

**Query:** `?kind=claimant|financier` (optional)

**Auth:** any tenant_user

**Effect:** SELECT * FROM subject_tenant — RLS filters to active firm. NOT joined through subject_tenant_user (per Q5 decision).

**Response 200:** `{ subject_tenants: SubjectTenant[] }`

### 4.3 `GET /v1/subject-tenants/:id`

**Auth:** any tenant_user in owning firm (RLS)

**Response 200:** `{ subject_tenant: SubjectTenant, event_count: number, head_hash: string | null }`

**Errors:** 404 (not found / wrong firm)

### 4.4 `GET /v1/subject-tenants/:id/chain-status`

**Auth:** any tenant_user in owning firm

**Effect:** call `verifyChain(:id)` (§2.2)

**Response 200:** `{ verified: boolean, head_hash: string | null, event_count: number, first_break_at: number | null }`

### 4.5 `POST /v1/events`

**Body:** `{ subject_tenant_id: uuid, raw_text: string, captured_at?: ISO8601 }` (`captured_at` defaults to NOW)

**Auth:** any tenant_user with access to `subject_tenant_id` (RLS check)

**Effect:**
1. Validate body
2. Look up subject_tenant → tenant_id (must match active GUC)
3. Compute `idempotency_key = SHA256(prompt_version ‖ raw_text)`
4. Check `agent_call_cache` for `idempotency_key`
5. If hit: skip classifier (`cache_hit = true`)
6. Else: invoke `makeClassifier().classify({ raw_text })`
7. Begin transaction:
   - `pg_advisory_xact_lock(hashtext('event_chain_' || subject_tenant_id))`
   - SELECT prev_hash from latest event for subject_tenant
   - Compute event hash
   - INSERT event row with computed hash
   - If not cache hit: INSERT into agent_call_cache (ON CONFLICT DO NOTHING)
8. Emit OTel span with full attribute set
9. Return inserted event (with effective_kind from view)

**Response 201:** `{ event: EventWithEffectiveKind }`

**Errors:** 400 (validation), 401 / 403, 404 (subject_tenant), 409 (chain race — should be ~impossible given advisory lock; surfaced for safety), 503 (Anthropic API exhausted retries)

### 4.6 `GET /v1/events`

**Query:** `?subject_tenant_id=uuid&filter=all|needs_review|ineligible|overrides&limit=50&cursor=string`

**Auth:** any tenant_user with access

**Effect:**
- Filter by `subject_tenant_id` (RLS plus explicit filter)
- `filter`:
  - `all` (default): all events, newest first
  - `needs_review`: WHERE `effective_kind != 'OVERRIDE' AND classification IS NOT NULL AND (classification->>'confidence')::float < 0.7 AND NOT is_overridden`
  - `ineligible`: WHERE `effective_kind = 'INELIGIBLE'`
  - `overrides`: WHERE `kind = 'OVERRIDE'`
- Cursor-based pagination over `(captured_at DESC, received_at DESC, id DESC)`

**Response 200:** `{ events: EventWithEffectiveKind[], next_cursor: string | null }`

### 4.7 `POST /v1/events/:id/override`

**Body:** `{ new_kind: EvidenceKind (excluding OVERRIDE), reason: string (1..1000 chars) }`

**Auth:** any tenant_user with access to the event's subject_tenant

**Effect:**
1. Load original event (must be visible under RLS; must not itself be `kind = 'OVERRIDE'`)
2. Begin transaction with chain advisory lock
3. INSERT new event with:
   - `kind = 'OVERRIDE'`
   - `subject_tenant_id = original.subject_tenant_id`
   - `tenant_id = original.tenant_id`
   - `override_of_event_id = original.id`
   - `override_new_kind = req.new_kind`
   - `override_reason = req.reason`
   - `payload = { _v: 1, source: 'override', original_event_id: original.id }`
   - `classification = null`
   - `idempotency_key = null` (overrides aren't idempotency-cached)
   - `captured_at = NOW`, `captured_by_user_id = req.user`
   - hash chain advances normally
4. Return new override event

**Response 201:** `{ override_event: Event }`

**Errors:** 400 (validation, including attempted override-of-override), 404 (original not found / wrong firm), 409 (chain race)

### 4.8 Standard error envelope

```ts
{ error: { code: string; message: string; details?: unknown } }
```

Codes: `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `CHAIN_RACE`, `CLASSIFIER_UNAVAILABLE`, `INTERNAL`.

---

## 5. Portal UI

### 5.1 Routes

| Route | File | Purpose |
|---|---|---|
| `/subject-tenants` | `app/(authed)/subject-tenants/page.tsx` | List + Create modal |
| `/subject-tenants/[id]` | `app/(authed)/subject-tenants/[id]/page.tsx` | Demo screen: paste + feed + filter + override |

### 5.2 `/subject-tenants` (list page)

- Server component fetches list via API (using session cookie)
- Renders table: name, kind, event count, last activity, "View" link
- "Create claimant" button → `<Dialog>` from shadcn:
  - `<Input>` name (required, ≤100 chars)
  - `<Select>` kind (default 'claimant')
  - Submit: react-hook-form + zod resolver → `POST /v1/subject-tenants`
  - Success: close modal, `router.push('/subject-tenants/[new-id]')`
  - Failure: toast with error message

### 5.3 `/subject-tenants/[id]` (demo screen)

**Layout (vertical stack, all on one screen, fits 1080p without scroll for ≤8 events):**

```
┌──────────────────────────────────────────────────────────────┐
│ ← Back to claimants                                           │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Acme Innovations Pty Ltd      [Verified ✓]  47 events    │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                                │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Paste evidence to classify                                │ │
│ │ ┌──────────────────────────────────────────────────────┐ │ │
│ │ │ [textarea, 8 rows]                                    │ │ │
│ │ │                                                        │ │ │
│ │ └──────────────────────────────────────────────────────┘ │ │
│ │                                          [Classify ↵]    │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                                │
│ [ All ] [ Needs Review (3) ] [ Ineligible (1) ] [ Overrides (2) ]│
│                                                                │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ HYPOTHESIS · 0.87 · §355-25(1)(a)              [Override]│ │
│ │ "We hypothesised that the catalyst would..."              │ │
│ │ Stub: hypothesis-formation vocabulary                     │ │
│ │ 5m ago · captured by aaron@carbonproject.com.au           │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ EXPERIMENT · 0.62 ⚠ · §355-25(1)(a)            [Override]│ │
│ │ "Ran the test rig at 50C for 12 hours..."                 │ │
│ │ Below review threshold — please confirm                   │ │
│ │ 7m ago · captured by aaron                                │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ...                                                            │
└──────────────────────────────────────────────────────────────┘
```

### 5.4 Components

**`paste-form.tsx`:**

- `<Textarea>` controlled by react-hook-form
- `<Button>` "Classify" — disabled while submitting; spinner while pending
- Submit handler: `useMutation({ mutationFn: postEvent })`; on success: `queryClient.invalidateQueries(['events', subjectTenantId])` AND optimistic prepend into the cached list for snappy feel
- Cmd/Ctrl+Enter submits

**`event-card.tsx`:**

```tsx
<Card data-testid={`event-card-${event.id}`}>
  <CardHeader>
    <KindChip kind={event.effective_kind} />
    <ConfidenceChip
      value={event.classification?.confidence}
      isOverridden={event.is_overridden}
      threshold={0.7}
    />
    {event.classification?.statutory_anchor && (
      <Badge variant="outline">{event.classification.statutory_anchor}</Badge>
    )}
    {event.is_overridden && <Badge variant="destructive">Overridden</Badge>}
    {!event.is_overridden && event.kind !== 'OVERRIDE' && (
      <Button size="sm" variant="ghost" onClick={openOverride}>Override</Button>
    )}
  </CardHeader>
  <CardContent>
    <p className="text-sm">{snippet(event.payload)}</p>
    {event.classification?.rationale && (
      <p className="text-xs text-muted-foreground italic">{event.classification.rationale}</p>
    )}
  </CardContent>
  <CardFooter>
    <span className="text-xs text-muted-foreground">
      {timeAgo(event.captured_at)} · {event.captured_by_email ?? 'system'}
    </span>
  </CardFooter>
</Card>
```

`KindChip` is a colour-coded badge (HYPOTHESIS=blue, EXPERIMENT=green, INELIGIBLE=red, OVERRIDE=yellow, etc.); `ConfidenceChip` shows the percentage with a ⚠ glyph if `< threshold && !isOverridden`.

**`override-modal.tsx`:**

- `<Dialog>` from shadcn
- `<Select>` for `new_kind` (default = current `effective_kind`)
- `<Textarea>` for `reason` (required, 1..1000 chars)
- Submit: `POST /v1/events/:id/override`; on success invalidate the events query
- Cancel: closes modal, no API call

**`filter-tabs.tsx`:**

- `<Tabs>` from shadcn with 4 values: `all`, `needs_review`, `ineligible`, `overrides`
- Each tab shows live count from a parallel count query
- Selected tab drives the `filter` query param of `useEventsQuery`

**`chain-status-badge.tsx`:**

- Server component (or client w/ `useQuery`); calls `GET /v1/subject-tenants/:id/chain-status`
- Renders: `Verified ✓` (green) or `Hash break detected at event #N` (red, with tooltip)

### 5.5 State management

- **Server state:** TanStack Query v5
  - `useQuery({ queryKey: ['events', id, filter], queryFn: ... })`
  - `useQuery({ queryKey: ['chain-status', id], queryFn: ... })`
  - `useMutation({ mutationFn: postEvent, onSuccess: invalidate(['events', id, ...]) })`
  - `useMutation({ mutationFn: overrideEvent, onSuccess: invalidate(['events', id, ...]) })`
- **Form state:** react-hook-form + @hookform/resolvers + zod
- **UI state:** local `useState` for active tab, modal open/close
- **No global store** — react-query's cache is the single source of truth

### 5.6 Empty / loading / error states

- **Empty:** "No claimants yet. Click 'Create claimant' to begin."
- **Loading list:** Skeleton rows
- **Loading feed:** Skeleton cards
- **API error:** Toast (shadcn `useToast`) + inline error message in form
- **Anthropic outage (503 from POST /v1/events):** Toast: "Classifier service unavailable. Try again or switch to fallback mode (admin)." (Switching impl is admin-only; UI hint only.)

---

## 6. Telemetry, testing, operational concerns

### 6.1 OpenTelemetry

Span names:
- `agent.classifier.classify` — wraps every classifier invocation (cache hit OR miss; cache_hit=true skips Anthropic call but still emits the span)
- `db.event.insert` — wraps the chain-locked transaction
- HTTP spans auto-generated by Fastify OTel instrumentation (already in P0)

Custom attributes (prefixed `cpa.`):
- `cpa.tenant_id`, `cpa.subject_tenant_id`
- `cpa.agent_name`, `cpa.prompt_version`, `cpa.model`
- `cpa.tokens_in`, `cpa.tokens_out`
- `cpa.cache_hit`
- `cpa.classification_kind`, `cpa.classification_confidence`
- `cpa.event_id`, `cpa.event_hash`, `cpa.event_kind`

Cost rollup: queries against the OTel backend (Grafana Cloud); no separate Postgres aggregate table in P2.

### 6.2 Testing strategy

**Unit (per package):**

- `packages/agents/runtime`:
  - `prompt-registry.test.ts` — register/get round-trips; missing-prompt error
  - `idempotency.test.ts` — key computation deterministic; cache hit/miss
  - `tool-use.test.ts` — using `nock` to mock Anthropic, asserts tool-use round-trip
- `packages/agents/classifier`:
  - `stub.test.ts` — fixture-driven; every rule covered + default fallthrough
  - `haiku.test.ts` — `nock`-mocked tool-use response → asserts ClassifierOutput shape, surfaces errors when tool not invoked
  - `factory.test.ts` — selects correct impl per env
- `packages/db`:
  - `event.test.ts` — insert + read + RLS isolation across tenants (the P1 RLS test pattern, applied to event)
  - `chain.test.ts` — hash determinism, prev_hash continuity, advisory lock serialises concurrent inserts

**API (apps/api/src/routes):**

- `subject-tenants.test.ts` — POST (happy + 401 + 403 read-only + 409 dup), GET list (RLS isolation), GET detail, GET chain-status
- `events.test.ts` — POST (happy + 400 + 403 cross-tenant + idempotency cache hit), GET (filters), POST :id/override (happy + override-of-override 400 + 404)

**E2E (apps/web/e2e):**

- `subject-tenants-list.spec.ts` — list visible, can create claimant, redirected to detail
- `paste-classify-feed.spec.ts` — paste transcript → event appears with kind chip + confidence chip
- `low-confidence-filter.spec.ts` — paste ambiguous transcript → appears under "Needs Review" tab
- `override-flow.spec.ts` — override an event → modal opens → submit → original card shows "Overridden", new override event in feed
- `chain-verification.spec.ts` — detail page shows "Verified ✓"; tampering with a row breaks verification (test-only seed manipulates a hash byte)

All e2e use `CLASSIFIER_IMPL=stub` for determinism.

### 6.3 CI strategy

- `CLASSIFIER_IMPL=stub` set in CI env (added to ci.yml + turbo `globalPassThroughEnv`)
- `ANTHROPIC_API_KEY` not required in CI
- New env vars added to ci.yml for both `ci` and `e2e` jobs:
  - `CLASSIFIER_IMPL: stub`
- Tests for `HaikuClassifier` use `nock` (already a dev dep); no real Anthropic calls in CI

### 6.4 Local dev ergonomics

- `.env.example` updated: add `CLASSIFIER_IMPL=haiku` (default) and `ANTHROPIC_API_KEY=sk-ant-...` (required when haiku)
- `pnpm --filter @cpa/agents test:replay` — runs HaikuClassifier against captured fixture inputs (no live API)
- README section: "Switching classifier impls"
- Docker compose unchanged (no new services for P2)

### 6.5 Operational concerns (deferred but worth noting)

- **Idempotency cache size:** ~100 events/day at P2 launch → cache ~100 rows/day → 36k rows/year, ~50MB at 1KB output each. Negligible for years. TTL cleanup deferred to P9.
- **Anthropic rate limits:** SDK retries 3x with exponential backoff. If exhausted, return 503 with code `CLASSIFIER_UNAVAILABLE`; client surfaces toast. Admins can flip `CLASSIFIER_IMPL=stub` for circuit-breaker fallback (manual env change for P2; programmatic in P9).
- **Cost control:** Per-tenant rollups in Grafana via OTel attribute aggregation. Per-call cost: ~$0.0002 (Haiku 4.5 at small token counts). Cap concern is a runaway loop, not steady-state — addressed by the idempotency cache (re-pasting same text = free).
- **PII / data residency:** Anthropic's data-residency policy applies. Confirm with first paying customer; AU data residency is a future requirement. Current architecture sends `raw_text` to Anthropic via the official SDK. Deferred to a separate review before first sale.

### 6.6 Documentation

- ADR `docs/decisions/0003-event-chain-and-classifier.md` — captures the per-claimant chain decision, the dual-impl classifier strategy, and the override semantics.
- README in `packages/agents/` — usage, env vars, swapping impls.

---

## 7. Risks & watch-outs (P2-specific)

1. **Classifier prompt drift across statutory updates.** AusIndustry guidance updates in 2026 may reshape Division 355 anchors. *Mitigation:* prompt registry is versioned (`classify@1.0.0`); changes bump the version; idempotency cache keys include the version so old cached classifications stay attributed to the prompt that produced them; CI fixtures are tied to a specific version.
2. **Race between two consultants pasting identical transcripts.** Idempotency cache returns the same classification; both events get the same `idempotency_key`. The unique partial index would reject the second insert. *Mitigation:* idempotency check happens BEFORE chain insert; if cache hit, second consultant's POST returns the existing event row (200 OK, not 409). Architecture: GET-or-POST-or-SELECT — return existing event row if a different event already used the same key for the same `subject_tenant_id`.
3. **Hash-chain corruption from a manual DB tweak.** *Mitigation:* `chain-status` endpoint surfaces the break to the consultant immediately. P9 adds an audit log and an alert; P2 just makes it visible.
4. **Override storm — consultant overrides every classification.** Could indicate prompt is wrong. *Mitigation:* Grafana dashboard tracks override rate; > 30% triggers prompt-review action item. Out of scope for P2 (no dashboards yet); the data is captured.
5. **Demo prep — Anthropic API down right before a customer demo.** *Mitigation:* `CLASSIFIER_IMPL=stub` flip is documented in `RUNBOOK.md`. Stub classifier has reasonable defaults that look ~80% correct on real R&D transcripts.
6. **Subject-tenant deletion in P2.** Out of scope — no DELETE endpoint. Soft-delete pattern matches P1 (deleted_at column already on subject_tenant). Listing already filters `WHERE deleted_at IS NULL`; no UI to set it.

---

## 8. Sequencing inside P2

Roughly:

- W6 (this week) — schema + runtime scaffolding + classifier interface + StubClassifier + RLS migration
- W7 — HaikuClassifier + prompt registry + idempotency cache + agents package CI
- W8 — API endpoints + tests + portal list/detail pages + paste flow
- W9 — Override flow + Needs-Review filter + chain-status badge + e2e suite + first-demo polish

(Detailed task breakdown in the implementation plan, produced via `superpowers:writing-plans` next.)

---

## 9. Next step

Invoke `superpowers:writing-plans` skill to produce a task-by-task implementation plan with file-level tasks, test specifications, and acceptance criteria.

Then `superpowers:subagent-driven-development` for execution.
