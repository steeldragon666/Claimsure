# ADR-0003: Event Chain & Classifier Architecture

**Status:** Accepted
**Date:** 2026-04-27
**Authors:** Aaron Newson + AI pair (Claude Opus 4.7)
**Builds on:** [ADR-0001](./0001-monorepo-and-stack.md), [ADR-0002](./0002-identity-and-tenancy.md)
**Source brainstorm:** [P2 design](../plans/2026-04-27-p2-event-capture-design.md), [P2 implementation plan](../plans/2026-04-27-p2-event-capture-implementation.md)

## Context

P0 established the platform foundation; P1 added users, tenants, and per-claimant
ACLs. P2 introduces the first vertical product slice — paste-to-classify evidence
capture — and with it three architectural primitives that propagate into every
subsequent phase:

1. The append-only **event hash chain** that anchors compliance-grade audit
   trails (Module 1 — Evidence & Compliance Engine; Pillars 1, 3, 4 of the
   product spec).
2. The **agent runtime + classifier package** (`@cpa/agents`) that turns raw
   pasted text into a typed `EvidenceKind` with statutory anchor and
   confidence.
3. The **idempotency / prompt-versioning** machinery that keeps both the chain
   and the agent layer reproducible across model swaps and rerun retries.

This ADR captures the decisions made during P2 (T1–T33) so later phases (P3
extractor, P4 project model, P5 Assurance Report, etc.) inherit them without
relitigation. Reference: [`docs/product/2026-04-27-omniscient-feature-spec.md`](../product/2026-04-27-omniscient-feature-spec.md).

## Decision

### Per-`subject_tenant` hash chain (Q1)

- **One chain per claimant**, not per consultant firm and not global.
- The chain is the sequence of `event` rows for a given `subject_tenant_id`,
  ordered by `(captured_at, received_at, id)`, with each row's `prev_hash`
  linking to the previous row's `hash` (`NULL` for the first event).
- Verification cost is `O(events_per_claimant)`, not `O(events_in_platform)` —
  bounded by what one claimant generates in a year (typically thousands, not
  millions).
- Exports are **self-contained per claimant**: an Assurance Report (P5) only
  needs that claimant's chain to verify, with no external dependencies. This
  matches how AusIndustry / ATO reviewers think about an audit — one claimant
  at a time, not one firm at a time.

### Hash canonicalisation (Q2)

- **SHA-256 over a sorted-key JSON encoding** of the event-for-hashing tuple
  (`subject_tenant_id`, `kind`, `payload`, `classification`, `captured_at`,
  `captured_by_user_id`, `override_of_event_id`, `override_new_kind`,
  `override_reason`). Implementation lives at `packages/db/src/chain.ts`
  (`canonicaliseEvent` + `hashEvent`).
- **Timestamps are ISO-8601 strings** (`captured_at.toISOString()`), not
  millisecond epochs. Reason: the wire format the API exposes uses ISO; the
  stored DB value is `timestamptz`. Hashing the same canonical surface a
  consumer can see eliminates a class of "the chain says Y but the DB shows X"
  reconciliation bugs.
- **Hex output**, lowercase, 64 chars. Enforced at the DB level by the
  `event_hash_format` and `event_prev_hash_format` CHECK constraints
  (`hash ~ '^[0-9a-f]{64}$'`).
- **NaN / Infinity / -Infinity are rejected** before serialisation rather than
  emitted as `null` (JSON.stringify's default). Silent coercion would let a
  payload value drift between `payload === Infinity` and the stored hashed
  form, breaking verification on the next cycle. The throw is in
  `canonicalJsonStringify` and is exercised by `chain.test.ts`.
- **`prev_hash` is concatenated as a raw string** (not re-hashed) before being
  hashed with the canonical event JSON. The first event uses the empty string
  for the prev portion. This is the simplest scheme that keeps verification
  trivially expressible in a future export script (no nested hash structure to
  recreate).

### `pg_advisory_xact_lock` for chain serialisation (Q3)

- Each `insertEventWithChain` call holds a **per-claimant transaction-scoped
  advisory lock** keyed by `hashtext('event_chain_' || subject_tenant_id)`.
  Implementation: `packages/db/src/chain.ts:insertEventWithChain`.
- `hashtext(...)` produces a stable bigint that pg's advisory lock space
  accepts; the `_xact_` variant releases automatically at commit / rollback.
- **Concurrent inserts on the same chain serialise** (the second waiter blocks
  until the first commits, then reads the now-extended head and computes its
  own hash on top). **Cross-chain inserts proceed in parallel** because the
  lock keys are independent.
- We chose advisory locks over `SELECT ... FOR UPDATE` on a putative
  chain-head row because there is no chain-head row to lock — heads are
  derived. We chose them over `SERIALIZABLE` isolation because that would
  serialise every write against the `event` table, not just same-chain ones,
  and because retry logic on serialisation failures complicates the API
  surface.

### Override semantics (Q4)

- Overrides are **append-only**: an override is a brand-new `event` row with
  `kind='OVERRIDE'`, never a mutation of the existing row's fields.
- Each override carries `override_of_event_id` (the row it supersedes),
  `override_new_kind` (the corrected classification), and `override_reason`
  (free-text justification).
- The `event_with_effective_kind` view (migration `0007`) projects each event
  alongside its **effective kind** — for an OVERRIDE row, `override_new_kind`;
  for any row that has been overridden, the most recent overrider's
  `override_new_kind`; otherwise the row's own `kind`. Read paths (feed,
  filters, exports) consume the view; writes go to the base table.
- Why append-only: the chain must be tamper-evident. Mutating a classification
  in place would either invalidate every subsequent hash (the chain
  "verifies" a state that no longer exists) or require a re-hashing pass that
  itself becomes a forgery oracle. Append-only sidesteps both — every change
  is itself a chain extension.

### DB-level CHECK constraints (Q5)

The Drizzle `text({ enum: ... })` shape is a TypeScript hint only — Postgres
will happily store any text without explicit CHECKs. The `event` table
therefore carries five CHECK constraints, all in migration `0006`:

- **`event_kind_valid`** — `kind` must be one of the 13 known evidence kinds
  (12 classifiable + `OVERRIDE`).
- **`event_override_new_kind_valid`** — `override_new_kind`, when non-null,
  must be one of the 12 classifiable kinds. `OVERRIDE` is excluded
  intentionally: an override-of-an-override would render the
  `event_with_effective_kind` view's resolution semantics non-obvious.
- **`event_override_invariants`** — biconditional: `kind='OVERRIDE'` iff
  `override_of_event_id`, `override_new_kind`, and `override_reason` are _all_
  populated; non-OVERRIDE iff _all three_ are null. Enforces structural
  integrity that callers can't accidentally violate.
- **`event_hash_format` / `event_prev_hash_format` /
  `event_idempotency_key_format`** — all hex-SHA-256 columns are exactly 64
  lowercase hex chars (`'^[0-9a-f]{64}$'`).
- **CHECK chosen over `pgEnum`** so the migration stays a single file — adding
  a Postgres enum requires `CREATE TYPE` before the table referring to it,
  which Drizzle-kit auto-generation orders awkwardly when several enums share
  one migration. CHECK constraints are inline. Trade-off: CHECK isn't
  polymorphic across columns (we repeat the kinds list once for `kind` and
  once for `override_new_kind`), but the duplication is bounded and the
  migration shape stays clean.

### `event.tenant_id` denormalisation (Q6)

- **`event` carries `tenant_id` directly** (FK to `tenant.id`), even though
  it is derivable from `subject_tenant.tenant_id`.
- Reason: the RLS policy (`tenant_id = current_setting('app.current_tenant_id',
true)::uuid`) becomes a single column lookup with a btree index, not a
  subquery (`tenant_id IN (SELECT tenant_id FROM subject_tenant WHERE id =
...)`). On the hot read path (`/v1/feed?subject_tenant_id=X` returns 50
  events), the subquery alternative would push us into an index-scan +
  subquery-execute combo that adds latency and obscures the EXPLAIN plan.
- The denormalisation can drift in principle (someone updates
  `subject_tenant.tenant_id` and forgets to update `event.tenant_id`).
  Defenses:
  1. The API always inserts `event.tenant_id` from the active session JWT,
     never from `subject_tenant`.
  2. The API adds an explicit `subject_tenant_id` filter on read, which
     means even if RLS somehow let a row through, the application-layer
     query wouldn't return it.
  3. `subject_tenant.tenant_id` is effectively immutable — claimants don't
     change firms; if they did it would be a P3+ "transfer claimant" flow
     with its own migration story.
- Defense-in-depth, not single-layer trust.

### Dual-impl classifier — `HaikuClassifier` + `StubClassifier` (Q7)

- The `Classifier` interface (`packages/agents/src/classifier/types.ts`)
  defines a single `classify(input: ClassifierInput): Promise<ClassifierOutput>`.
- **Two production-grade implementations** satisfy it:
  - `HaikuClassifier` — backed by the Anthropic SDK + Claude Haiku
    (`claude-haiku-4-5` by default, override via `CLASSIFIER_MODEL`).
  - `StubClassifier` — deterministic regex-rule classifier; zero API calls,
    zero side effects, identical output for identical input.
- **Selection via `CLASSIFIER_IMPL` env**, with this resolution order
  (`makeClassifier` in `factory.ts`):
  1. `CLASSIFIER_IMPL` is honored verbatim if set (`stub` or `haiku`).
  2. Otherwise, `CI=true` opts into `stub` (no API key, deterministic).
  3. Otherwise, defaults to `haiku`.
  - Unknown values throw at startup, not at first request.
- This is a **production circuit-breaker pattern**: if Anthropic is degraded
  or our API key is rate-limited, the operator flips `CLASSIFIER_IMPL=stub`
  and capture continues with conservative classifications (default
  `SUPPORTING` at 0.5 confidence) — at the cost of routing more events to
  Needs Review for human reclassification, never blocking the chain.
- It is also the **CI / dev-offline pattern**: GitHub Actions has no API key;
  `CI=true` is set automatically; tests run against the stub. Local
  development without a key works the same way (`CLASSIFIER_IMPL=stub
pnpm test`).

### Idempotency cache — `agent_call_cache` (Q8)

- **`agent_call_cache` is content-addressed**: the PK is
  `SHA-256(prompt_version || NUL || raw_text)` (`computeIdempotencyKey` in
  `packages/agents/src/runtime/idempotency.ts`). The NUL separator prevents
  version/input boundary collisions (`('classify@1.0', '.0hello')` vs
  `('classify@1.0.0', 'hello')`).
- **Not RLS-protected**. The cache key reveals nothing the requester doesn't
  already know — they pasted the text. Identical inputs across tenants
  legitimately share a cache entry, which would be impossible under RLS
  scoping. The migration's RLS section explicitly leaves `agent_call_cache`
  untouched and documents why (migration `0006`, lines 106–110).
- **`ON CONFLICT (idempotency_key) DO NOTHING`** — first-write-wins. A second
  classify of the same text returns the original cached output, never a
  surprise replacement. This gives stronger safety than last-write-wins:
  cached outputs are stable for as long as the cache row exists.
- **No TTL in P2**. Eviction (LRU, age-based, or tier-based) lands in P3+
  when cache size becomes a meaningful cost factor; today the row count is
  bounded by `unique-pastes-ever`, which is small.

### Versioned prompt registry (Q9)

- **Prompts are keyed `name@semver`**. The classify prompt today is
  `classify@1.0.0`, registered as a side effect of importing
  `packages/agents/src/classifier/prompts/classify@1.0.0.ts` (the filename
  itself encodes the version, so a renamed file is a renamed key).
- The runtime registry (`packages/agents/src/runtime/prompt-registry.ts`)
  is an in-process Map; re-registering an identical key is a no-op so
  modules imported via multiple paths don't clobber each other.
- The idempotency cache key includes `prompt_version`, which means **older
  cached classifications stay attributed to their original prompt** even
  after a `classify@1.1.0` lands. New cache entries for the new version
  coexist; old entries stay queryable for explanatory provenance ("this
  event was classified under classify@1.0.0 which used these instructions");
  no implicit invalidation.
- Re-classifying every cached event under the new prompt is a future
  background job (P3+ — likely tied to the milestone-checker rebuild).

### Confidence threshold — 0.7 for "Needs Review" (Q10)

- **Events with `confidence < 0.7` route to Needs Review** in the portal
  (`apps/web` Needs Review tab). Events ≥ 0.7 land directly in the main feed
  with the model's classification visible.
- The architecture brainstorm originally proposed 0.6. We raised it to 0.7
  for P2 because:
  - This is a **compliance-grade tool**. A consultant reviewing 1.0× the
    pasted volume in week 1 will calibrate trust faster than one reviewing
    0.6× of it; over-routing to review is cheaper than under-routing on a
    statutory test.
  - The Haiku prompt explicitly tells the model to use `< 0.7` as the
    "I am not sure" signal — the threshold and the prompt instructions
    agree, so the model's natural calibration aligns with the routing
    decision.
- The threshold is **configurable in the portal filter UI**, not via env.
  Operators can dial it down for a specific tenant if calibration data
  warrants. Env-level config would couple the threshold to deployment cadence,
  which is the wrong granularity for a knob a consultant adjusts per claim.

## Consequences

**Positive**

- Per-claimant chains keep verification work bounded and exports
  self-contained — the Assurance Report (P5) is a one-claimant operation
  end-to-end.
- Hash canonicalisation rejects every silent-coercion path we know of (NaN,
  Infinity, key reordering, integer/string ambiguity), so chains generated by
  P2 will still verify under any future TypeScript / Postgres / drizzle
  upgrade that preserves the canonical surface.
- Advisory-lock serialisation gives us same-chain consistency without
  blocking cross-chain throughput; this is the right shape for a portal
  where multiple consultants paste against different claimants concurrently.
- Append-only overrides + `event_with_effective_kind` keep the audit story
  intact while still letting the UI display "the latest correct
  classification" without join contortions.
- Dual-impl classifier means CI is fast and free, dev works offline, and
  prod has a proven fallback knob — without code branching, just env config.
- Content-addressed idempotency cache eliminates duplicate Anthropic spend
  for the most common shape of duplicate work (a user re-pasting the same
  text), while staying explainable (key includes prompt version).

**Negative**

- The CHECK constraints duplicate the kinds list once for `kind` and once
  for `override_new_kind`. If a 14th kind ever lands, the migration is two
  alters in one file — manageable but worth flagging.
- `event.tenant_id` denormalisation costs one extra column write per insert
  and one consistency invariant the API must uphold. The defense-in-depth
  layers offset this, but a future contributor _could_ introduce a write
  path that forgets to set `tenant_id`. CHECK constraint candidates here
  (a function-based `event_tenant_matches_subject` constraint) were
  considered and deferred to keep the migration size bounded.
- The advisory-lock pattern requires every insert path to be aware of the
  lock; a tools/scripts contributor who writes to `event` directly and skips
  the lock would corrupt the chain. Mitigation: `insertEventWithChain` is
  the only sanctioned write path; raw INSERT into `event` is reviewed at PR
  time.
- Stub classifier rules are heuristic and intentionally conservative; they
  will misclassify edge-cases the live model would handle correctly. CI
  tests that depend on stub output therefore can't substitute for a real
  end-to-end test against Haiku — a small amount of nock-mocked Haiku
  coverage is required for production confidence.

**Reviewable in P3+**

- Whether the `event` insert path benefits from a Postgres trigger that
  _enforces_ `tenant_id = subject_tenant.tenant_id` rather than relying on
  application-layer discipline. Likely yes once a second write path lands.
- Whether the idempotency cache needs a TTL or LRU policy. Today the row
  count grows with unique pastes; in 12 months we'll know the natural
  growth curve.
- Whether `OVERRIDE` should itself be overridable. Today the
  `event_override_new_kind_valid` CHECK forbids it; if compliance review
  workflow surfaces a reviewer-corrects-a-reviewer use-case, we'll relax
  it (and update the view's resolution semantics together).
- Whether to promote `confidence < 0.7` from a UI filter into a stored
  `needs_review` boolean column for index-driven counts. Likely yes once
  the Needs Review tab gains aggregate metrics in P3.
- Re-classification background job (rebuild cached classifications under a
  new prompt version). Lands with the P3 extractor or alongside the first
  prompt bump, whichever comes first.

## Alternatives considered

- **Per-tenant or global chain instead of per-claimant**: rejected. Per-tenant
  bundles unrelated claimants; a single bad event invalidates verification
  across them all. Global is even worse — every operator would need to
  verify the entire platform's chain. Per-claimant is the natural unit of
  audit.
- **`pgEnum` instead of CHECK constraints**: rejected for migration-shape
  reasons (separate `CREATE TYPE` statements complicate Drizzle-kit's
  auto-generation). Re-evaluable if Drizzle-kit's enum support improves.
- **`SERIALIZABLE` isolation instead of advisory locks**: rejected because
  it would serialise unrelated chains and force the API to handle
  serialisation-failure retries that complicate the request shape. Advisory
  locks give us the property we want (same-chain order) and nothing more.
- **In-place override (mutate the original event's classification)**:
  rejected. Mutation breaks the chain's tamper-evidence; a reviewer
  fingering a forged row would be indistinguishable from a legitimate
  reclassification.
- **Single classifier impl (Haiku only)**: rejected. CI would need a real
  API key (cost, secret-handling overhead, flake risk on Anthropic
  outages); offline development would be impossible. Dual-impl with env
  selection is the standard gradient-degradation shape and it costs ~150
  lines of Stub code.
- **`pgEnum` for evidence kind + CHECK for override invariants**: rejected
  because the mixed approach is harder to reason about than uniform
  CHECKs. Either both go enum or both stay CHECK; one-or-the-other simplicity
  wins over micro-optimisation.
- **TTL'd idempotency cache (e.g. 30-day expiry)**: rejected for P2. The
  cache is small, content-addressed, and doesn't carry user identity;
  expiration would just trigger duplicate Anthropic calls without obvious
  benefit. Revisit when we have growth data.
- **0.6 confidence threshold for Needs Review**: rejected per Q10. 0.7 is
  more conservative for a compliance tool and aligns with the Haiku
  prompt's explicit calibration instruction.

## Related decisions

- **P3 extractor** — builds on the same `@cpa/agents` runtime + prompt
  registry; will register `extract@1.0.0` and reuse the idempotency cache.
- **P5 Assurance Report** — consumes `verifyChain` end-to-end; whatever
  format we choose for the export (PDF + JSON sidecar most likely) must
  preserve the canonical surface above so external auditors can recompute.
- **P8 federation** — financiers granted scoped access via delegation
  tokens (ADR-0002) will see a per-claimant chain; no new chain primitive
  needed, just an RLS-policy extension.

## References

- [P2 design](../plans/2026-04-27-p2-event-capture-design.md)
- [P2 implementation plan](../plans/2026-04-27-p2-event-capture-implementation.md)
- [Product feature spec — Module 1, Pillars 1/3/4](../product/2026-04-27-omniscient-feature-spec.md)
- [Architecture design §5 hash chain](../plans/2026-04-25-rdti-grants-platform-design.md)
- [ADR-0001](./0001-monorepo-and-stack.md), [ADR-0002](./0002-identity-and-tenancy.md)
- Migration `0006_fair_network.sql` — event table + CHECK constraints + RLS
- Migration `0007_effective_kind_view.sql` — `event_with_effective_kind` view
- `packages/db/src/chain.ts` — canonicalisation + insert + verify
- `packages/agents/src/classifier/factory.ts` — env-based impl selection
- `packages/agents/src/runtime/idempotency.ts` — content-addressed cache
- Australian Income Tax Assessment Act 1997, Division 355 — statutory anchors
  cited in the classifier prompt
