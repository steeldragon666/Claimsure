# P6 Retrospective

> **Status:** SKELETON — populate after Phase 3 rollout completes and 1+ week of telemetry exists. The headline metrics in this document are placeholders; do not interpret them.

**Period:** Plan landed `2026-05-01`; Themes 0–7 PRs merged `2026-05-02` through `2026-05-03`; staged rollout phases ran `2026-05-DD` through `2026-05-DD`. Wall-clock implementation: **N hours** across **M autonomous-agent dispatches**.

**Plan:** `docs/plans/2026-05-01-p6-implementation.md` ([design](../plans/2026-05-01-p6-design.md)).

**Outcome:** All N planned tasks shipped across **6 PRs** (#14, #15, #16, #17, #18, #19). Main is at `<sha>`.

---

## What landed

| Theme | Tasks | PR | Merge SHA |
| --- | --- | --- | --- |
| 0 — Retro inheritance (chain.ts canonical pattern) | 0.1 | #14 | `e3ade56` |
| 1 — Event taxonomy + narrative_draft tables | 1.1–1.5 | #14 | `e3ade56` |
| 2 — Cross-cutting agent runtime | 2.1–2.5 | #14 | `e3ade56` |
| 3 — Agent A (expenditure classifier) | 3.1–3.6 | #15 | `aceee1f` |
| 4 — Agent B (register synthesizer) | 4.1–4.6 | #16 | `5e9d1c8` |
| 5 — Agent C (narrative drafter, streaming) | 5.1–5.9 | #17 | `b0aa4fa` |
| 6 — mapping_rule scalar-string backfill | 6.1 | #18 | `eed4af9` |
| 7 — Eval framework + CI workflow | 7.1, 7.3 (7.2 deferred) | #19 | TBD |
| 8 — Staged rollout | 8.1–8.3 | (no PR — env config only) | — |
| 9 — Retrospective (this document) | 9.1 | TBD | — |

7 new migrations on main: `0026_expenditure_classified_kind` → `0034_mapping_rule_scalar_string_backfill`. Three new agent packages (`classifier-expenditure`, `synthesizer-register`, `narrative-drafter` — under `@cpa/agents`). Two new API routes (`activity-register.ts`, `narrative.ts`) plus an extension to `expenditures.ts` for the reclassify endpoint. One eval framework (`packages/agents/eval/`). One GitHub Actions workflow (`agent-eval.yml`).

## What got descoped

- **Task 7.2 (full golden datasets)** — `packages/agents/eval/*/golden.ndjson` files ship with 5/2/2 placeholder cases. Production-quality 50/10/20 datasets require R&D consultant curation and are tracked as a follow-up PR.
- **pg-boss server bootstrap** — every P6 job (`expenditure-classify`, `activity-register-synthesize`, `narrative-stale-cleanup`) exposes a callable handler today; the pg-boss subscriber wiring is deferred consistent with the existing P5 convention. Auto-trigger hooks fire-and-forget directly via the enqueue shim instead.
- **Concurrent-accept race on `proposed_id`** — Agent B's accept endpoint relies on frontend serialization to prevent duplicate activity creation under concurrent retries. A partial unique index on `event ((payload->>'proposed_id')) WHERE kind='ACTIVITY_CREATED'` would close this deterministically; deferred as a non-blocking follow-up.
- **Pre-existing apps/api lint errors** (191 `no-unsafe-assignment`/`no-unsafe-call`) noticed during this phase but independent of P6's surface — flagged as a separate cleanup PR.

---

## Lessons learned

### 1. Subagent-driven development at parallel scale (the headline finding)

P6 was the first phase fully driven by autonomous-agent dispatches. The pattern that emerged: **one branch per swimlane × one implementer per task × one reviewer per implementation cycle**. Six concurrent worktrees (p6a → p6f) ran in parallel, with the controller (driving agent) maintaining only the dispatch graph + cross-branch coordination state.

Velocity finding: **N task-completion-cycles in M wall-clock hours**, vs P5's roughly comparable load taking ~12 hours of wall-clock with a single-driver workflow. The leverage came from independent themes running concurrently while CI churned on already-landed PRs. Cost: roughly K hours of cross-branch coordination tax (rebases when sibling PRs merged, conflict resolution in `_journal.json` and shared exports).

The pattern that worked: each implementer was given (a) the verbatim task spec, (b) reference file paths, (c) explicit decision points with the recommended choice + rationale. Briefs that left decisions to "implementer judgment" (e.g., "pick whichever shim approach feels cleaner") consistently produced sound choices. Briefs that under-specified ("write the prompt") would have produced low-signal output.

The pattern that didn't work: **assuming "typecheck + lint pass" implies "tests pass"**. Multiple instances where implementers reported "all green locally" but integration tests surfaced bugs only when actually run against postgres. The remedy was always to escalate to "verify the integration test passes locally before reporting" — when this was made explicit in the brief, regressions stopped surfacing.

### 2. Bugs the autonomous workflow caught (and why they would have shipped silently)

Seven distinct bugs surfaced during this phase, all caught by the implementer→integration-test→reviewer loop. Each was found at a stage that would have been **too late** under a single-driver workflow:

1. **`${{...}}::text::jsonb` jsonb anti-pattern** in `migrations.test.ts` (3 sites). The `::text` cast forces postgres-js to encode the parameter as TEXT; bare object → `[object Object]` via implicit `String()` coercion → PostgreSQL rejects with "Token 'object' is invalid". The Theme-1 spec-compliance reviewer caught it on the swimlane PR. **Sealed permanently** by extending `chain.canonical.test.ts`'s revert guard from chain.ts-only to all `packages/db/src/*.ts`, with a regex (`}}::text::jsonb` after object-literal close) that catches the anti-pattern but not the canonical `JSON.stringify(...)::text::jsonb` form.

2. **Migration 0030 `GRANT SELECT, INSERT` was no-op** because migration 0002's `ALTER DEFAULT PRIVILEGES FOR ROLE cpa IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cpa_app` auto-grants ALL CRUD to cpa_app on every newly-created table. Fixed with explicit `REVOKE UPDATE, DELETE ON narrative_draft_version FROM cpa_app`. Same defect noted on `audit_log` (0022) — flagged as a follow-up cleanup. **Sealed permanently** by codifying the REVOKE-after-GRANT discipline in any future append-only migration.

3. **Rate-limit `consume()` recursion didn't honor cumulative `maxWaitMs`** — under sustained contention, a single call could wait far longer than the documented 60s ceiling. Implementer flagged the concern but didn't fix; reviewer caught it. Fixed by tracking absolute deadline at entry and passing through recursive calls.

4. **Agent B's `fiscal_year` semantic was calendar-year, not Australian FY** (FY ending June 2025 should be `2025`, not `2024`). Caught by review as a silent regression for any project starting July–December. Fixed via `LEFT JOIN claim.fiscal_year` with a `deriveAuFiscalYear` fallback (`month >= 6 ? year + 1 : year`).

5. **`AGENT_A_SYSTEM_USER_ID` / `AGENT_B_SYSTEM_USER_ID` not seeded in production** — the chain's `captured_by_user_id` FK requires a user row, but tests seeded it locally and the implementer had no migration. Caught by review. Fixed with idempotent `INSERT ... ON CONFLICT DO NOTHING` migrations (0032 + 0033).

6. **Idempotency-key V8 insertion-order risk** — `JSON.stringify(inputBundle)` relies on V8's insertion-order preservation for non-numeric keys. Future field reorder → silent cache miss across deploys → doubled Anthropic spend. Implementer flagged but didn't fix; reviewer caught. Fixed by promoting `canonicalJsonStringify` from chain.ts module-private to exported (single source of truth for sorted-key serialization across the codebase).

7. **CI parallel test-runner exposed a TENANT-vs-SUBJECT cleanup-scope mismatch** in `expenditures.test.ts` — `beforeEach` deleted by `subject_tenant_id = SUBJECT_A` but assertions checked `WHERE tenant_id = TENANT_A` (broader scope). Locally tests passed (sequential run); CI failed because parallel test files leaked into the broader query. Fixed by narrowing all 5 EXPENDITURE_CLASSIFIED assertions to match cleanup scope.

Pattern across all seven: each was caught **in the iteration step** (review or integration test), not in the implementer's self-review. The single biggest workflow-process insight from P6: **the implementer's "I checked everything" claim is structurally less reliable than a fresh-eyes review or an actual test run** — and the autonomous workflow can afford to do both, where a single-driver workflow trades one for the other.

### 3. The drizzle journal isn't designed for branch-based parallel migration development

Each parallel branch that adds a migration touches `packages/db/migrations/meta/_journal.json`. PR #15 added 0032; PR #16 added 0033; PR #17 (which adds NO migrations) still needed both entries in its journal after rebase. PR #18 added 0034. Every rebase cycle required manual conflict resolution in the journal because each branch wrote its own entry to the same array.

A "journal as ordered set of migration files" model (drizzle generates the journal from the file system at apply time) would handle this automatically. Filed as a future tooling improvement; not in P6's scope.

### 4. Docker Desktop's Inference Manager is fragile

During the autonomous run, Docker Desktop on the development machine entered a broken state where `com.docker.backend.exe` couldn't remove its own stale Unix-socket reparse points (`dockerInference`, `engine.sock`). Fixed by setting `EnableDockerAI: false` in `settings-store.json` and renaming the stale `run/` and `docker-secrets-engine/` directories.

The pattern: standard removal tools (`Remove-Item`, `del`, `fsutil reparsepoint delete`) cannot recognize Docker's custom reparse tag and refuse to operate on the file. Renaming the parent directory works because the directory entry isn't itself a reparse point. A CI move to E:\ (away from C:\) was a useful side fix.

Not P6's bug, but cost ~1 hour of the autonomous run. Documented in the rollout runbook's pre-flight section.

### 5. The δ-hybrid audit anchor design held up

Agent C's "claim segments must cite ≥1 event from clustered_events" contract, enforced by the `validateSegment` helper at the streaming-orchestrator layer, with a 2-retry correction loop and downgrade-to-prose fallback, was the single most ambitious piece of P6's design. **It works**: the orchestrator successfully drives Sonnet through the validate-and-correct loop in tests; the downgrade fallback fires when the model can't produce a valid claim after 2 retries; the validation-downgrade counter surfaces in the SSE `done` event so the UI can render a yellow warning.

What we'll learn from production: how often the correction loop fires (telemetry: `validation_downgraded_count > 0`), whether the prompt's worked-examples are sufficient, whether the 2-retry budget is the right cap.

### 6. Themes 7's eval framework is necessary infrastructure but doesn't replace human review

Task 7.1's framework + Task 7.3's CI workflow are end-to-end functional, but Task 7.2's golden datasets need R&D consultant curation. **Without curated datasets, eval scores are not production-meaningful** — the framework's "70% pass threshold" is meaningless against placeholder cases.

The right way to think about Theme 7: it's the SCAFFOLDING for ongoing prompt-quality monitoring. The actual measurement only happens once the consultant team curates 50/10/20 examples that represent real distributional patterns. This is a multi-week data-labour task; deferred to a separate PR with consultant collaboration.

---

## Production telemetry (placeholder — populate after Phase-3 soak)

> Replace with real numbers from `cpa_*` Grafana panels.

| Metric | Phase 1 (dogfood) | Phase 2 (4 firms) | Phase 3 (all firms, week 1) |
| --- | --- | --- | --- |
| Total `EXPENDITURE_CLASSIFIED` events | <N> | <N> | <N> |
| Total `ACTIVITY_REGISTER_DRAFTED` events | <N> | <N> | <N> |
| Total `NARRATIVE_DRAFTED` events | <N> | <N> | <N> |
| Mean Anthropic cost per day | <$> | <$> | <$> |
| Validation downgrade count (Agent C) | <N> | <N> | <N> |
| `RateLimitExceededError` count | <N> | <N> | <N> |
| Idempotent-skip rate (Agent A) | <%> | <%> | <%> |

## Open follow-ups (post-P6)

- [ ] Task 7.2 — curate the 50/10/20 golden datasets with the consultant team
- [ ] Audit log append-only enforcement — `audit_log` (migration 0022) has the same `GRANT SELECT, INSERT` defect that 0030 had; needs `REVOKE UPDATE, DELETE` migration
- [ ] Concurrent-accept race on Agent B's accept endpoint — partial unique index on `event ((payload->>'proposed_id')) WHERE kind='ACTIVITY_CREATED'`
- [ ] pg-boss server bootstrap — currently every P6 job is callable but the cron wiring is deferred
- [ ] EventCitation hover preview keyboard accessibility — currently uses native `title` attribute; swap to Radix `<HoverCard>`
- [ ] Three-state exit codes in `agent-eval.yml` — distinguish budget-exhausted from genuine regression
- [ ] apps/api lint cleanup (191 pre-existing `no-unsafe-*` warnings)
- [ ] Migration journal "ordered set of files" model — drizzle ergonomic improvement
- [ ] Manual-create POST handler for expenditures — currently only Xero ingest creates them; route shim already supports the call site

---

## Next phase

P7 candidates surfaced during P6 (none committed yet):
- Pre-clustering for Agent B (embeddings + k-means or HDBSCAN) before the LLM synthesis call — design doc §4 explicitly listed this as P7
- Multi-claim-cycle narrative drafting (currently each draft is one fiscal year × one activity; P7 could span multiple cycles for trend narrative)
- Consultant-facing prompt iteration UI (no code changes, but a tool for consultants to propose prompt edits + see eval results)
- Per-tenant prompt overrides — some firms have idiomatic R&D vocabulary that the global prompt may not handle well

Open the P7 brainstorm document when ready.
