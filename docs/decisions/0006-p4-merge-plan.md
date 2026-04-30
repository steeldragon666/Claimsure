# 0006 — P4 merge plan: evidence engine, Xero expenditure, pipeline documents

**Status:** Approved — D1 readiness assessment, executing.
**Date:** 2026-04-29
**Decided by:** P4 controller (post-D1 review).

## Context

Three feature branches have completed their planned scope and are ready
to merge into `main`:

- `p4a/evidence-engine` (A1–A10) — projects/claims/activities CRUD,
  artefact-link events, activity detail editor, technical uncertainty
  register, project pages, activity application PDF, hash-chain
  extension tests, e2e coverage.
- `p4b/xero-expenditure` (B1–B10) — Xero accounting OAuth, four sync
  paths (invoices, bank-tx, receipts, contacts/accounts), recurring
  pg-boss sync job, Xero stub, mapping-rules engine + persistence +
  REST + apply-rules preview.
- `p4c/pipeline-documents` (C1–C9) — pipeline list/kanban/table, claim
  detail page, expenditure mapping UI, apportionment slider, claim
  summary PDF + Documents tab, apportionment report PDF.

## Branch tips at the time of this plan

- p4a: `dac6fc3` (A10 follow-up — env-var API base URL + scoped chip selector + cascade docs)
- p4b: `0e61afd` (B10 follow-up — UUID-sort comment + missing tests + named error)
- p4c: `f177903` (C9 follow-up — kind-default trap + strict source typing + tidy)

## Recommended merge order: A → B → C

### Why A first

A is the most foundational. It defines `PROJECT_UPDATED` event kind, the
projects/claims/activities API surface that C consumes, and the hash-chain
canonicalisation tests covering all P4 kinds (including B's reserved
kinds).

### Why B before C

B was authored knowing A would merge first — its `_journal.json` skips
`idx: 15` to leave room for A's migration. C consumes B's expenditure
surface and benefits from the `'manual'` source mapping reconciliation
(see section 4.1) being applied during C's rebase rather than as a
follow-up.

## Expected file-level conflicts

Four textual conflicts, all mechanically resolvable:

1. `packages/db/migrations/meta/_journal.json` — A and B both append after
   `idx: 14`. B pre-skipped `idx: 15`, so resolution is union sorted by idx.

2. `packages/schemas/src/event.ts` — A appends `'PROJECT_UPDATED'` to
   `evidenceKind`; B appends three `MAPPING_RULE_*` kinds. Resolution: take
   both blocks; update the docstring count to "18".

3. `packages/db/src/schema/event.ts` — same pattern as #2 for
   `EVIDENCE_KINDS`.

4. `apps/api/src/app.ts` — all three branches add imports + `app.register`
   blocks. Resolution: take all three sets of registrations.

Plus minor:

- `apps/api/tsconfig.json` (A and C insert `documents` reference at
  different positions; pick C's position)
- `apps/api/package.json` (A and C add identical `@cpa/documents`)
- `packages/documents/src/index.ts` (A and C append exports)

## Cross-swimlane semantic conflicts

### MUST reconcile before merge

**4.1 `'manual'` source → kind mapping**

- B (`apps/api/src/routes/preview-rules.ts:149-150`) maps `'manual' → 'RECEIPT'`
- C (`apps/api/src/routes/claim-pdf.ts:651-659`) maps `'manual' → 'INVOICE'`

Resolution: keep B's `'RECEIPT'`. Manual entries are typically user-captured
proof (closer to receipt) than vendor-issued invoices. Apply during C's rebase.

**4.2 Spec doc taxonomy drift**

Any spec doc still referring to the old `OBSERVATION/NEW_KNOWLEDGE/ITERATION`
predecessors should use the canonical names from `summarise-event.ts`:
`OBSERVATION`, `NEW_KNOWLEDGE`, `ITERATION`. Doc-only patch alongside C's
rebase. Verified clean in P5 swimlane D Task 6.1 — the only remaining
references in `docs/` are this paragraph (descriptive, not prescriptive)
plus the P5 plan's own description of this task.

### SHOULD reconcile in coordinated commit on main after merge (P5 candidates)

**4.3 Missing direct FKs (claim → project, expenditure → claim)**

Three swimlanes hit this. Add `claim.project_id` (nullable; backfill from
activity.project_id; NOT NULL after backfill) and `expenditure.claim_id`
(populated when an expenditure is mapped). Drop fiscal-year-window join in
`preview-rules.ts` once `expenditure.claim_id` is populated.

**4.4 `expenditure_line` UUID-sort**

B10 uses `ORDER BY id ASC` with id as randomUUID. Add `line_number` column
to `expenditure_line` (NOT NULL DEFAULT 1, unique per expenditure_id).
Update preview-rules' two `ORDER BY id ASC` clauses.

**4.5 Firm-scoped events**

B9 reserves `MAPPING_RULE_*` event kinds but emits no events because
`event.subject_tenant_id` is NOT NULL and mapping rules are firm-scoped.
Either make `subject_tenant_id` nullable with a CHECK whitelist OR
introduce a separate `audit_log` table (cleaner — keeps the chain
invariant intact).

### NICE TO HAVE (P5 backlog)

**4.6 `@cpa/types` meta-package**

B9 inlined types from `@cpa/integrations` into `@cpa/db` to avoid a dep
cycle. Proper fix is a meta-package both packages import from.

**4.7 `LIST_PAGE_SIZE` constant**

Multiple sites use `limit: 200` literal. Extract to shared constant in
`@cpa/schemas/event.ts`.

## Reconciliation summary

| Item                     | Bucket | Action site          | Effort |
| ------------------------ | ------ | -------------------- | ------ |
| 4.1 `'manual'` → kind    | MUST   | C's rebase           | <1 hr  |
| 4.2 Spec doc taxonomy    | MUST   | doc-only patch       | 5 min  |
| 4.3 Missing FKs          | SHOULD | P5 task post-merge   | days   |
| 4.4 `line_number` column | SHOULD | post-merge migration | hours  |
| 4.5 Firm-scoped events   | SHOULD | post-merge           | days   |
| 4.6 `@cpa/types` meta    | NICE   | P5 backlog           | hours  |
| 4.7 `LIST_PAGE_SIZE`     | NICE   | P5 backlog           | <1 hr  |

## CI considerations

The workflow's push trigger filters to `[main, 'p1/**', 'p2/**', 'p3/**']` —
**`p4/**`branches are not triggered on push**. This means worktree heads
don't run automatic CI; CI runs on PR-to-main. Adding`'p4/\*\*'` to the
push trigger as part of this commit so each rebase verifies via CI before
PR.

## Migration ordering

| Branch | New migrations                                  | Journal idx |
| ------ | ----------------------------------------------- | ----------- |
| A      | `0015_project_updated_kind.sql`                 | 15          |
| B      | `0016_xero_caches.sql`, `0017_mapping_rule.sql` | 16, 17      |
| C      | (none)                                          | (n/a)       |

No collisions under A → B → C. If order ever inverted, A would renumber
to `0018_project_updated_kind.sql` and update its journal entry.

## Risk register

| Step                   | Probability | Severity | Mitigation                        |
| ---------------------- | ----------- | -------- | --------------------------------- |
| Step 1: merge A        | low         | low      | Standard PR + CI gate             |
| Step 2: rebase B       | medium      | low      | 4 mechanical conflicts; rerere on |
| Step 3: rebase C       | medium-high | medium   | 5 conflicts + 4.1 reconciliation  |
| Step 4: post-merge ADR | low         | low      | Plain refactor                    |

## Decision

Proceed with merge order A → B → C. Apply item 4.1 reconciliation
(`'manual'` → `'RECEIPT'`) in C's rebase. Apply item 4.2 (spec doc
taxonomy) alongside. Defer items 4.3–4.7 to ADR `0007-p4-followups` after
all three branches merge.
