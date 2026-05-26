# 06 — IP Search API + Wizard Step 2 UI

**Depends on:** 01, 02, 03, 04, 05

## Goal

API endpoints that orchestrate the integration packages + agents, plus the wizard's Step 2 UI that drives the consultant through query review → run → verdict approval.

## API files to add

- `apps/api/src/routes/ip-search/index.ts` — register all routes
- `apps/api/src/routes/ip-search/queries.ts` — `POST /v1/claims/:id/activities/:aid/ip-search/queries` (generate candidate queries via ip-search-query agent; returns the JSON of per-database queries WITHOUT running them)
- `apps/api/src/routes/ip-search/run.ts` — `POST /v1/claims/:id/activities/:aid/ip-search/run` (body: `{ queries: { ip_australia: string[], ... } }`; for each query, check cache (30-day TTL); if miss → call integration; insert ip_search_run + ip_search_hit rows. Returns all hits grouped by database.)
- `apps/api/src/routes/ip-search/verdict.ts` — `POST /v1/claims/:id/activities/:aid/ip-search/verdict` (body: `{ hypothesisText }`; loads recent hits for this hypothesis; calls ip-search-verdict agent; INSERT into ip_search_verdict with `draft_verdict` populated)
- `apps/api/src/routes/ip-search/approve.ts` — `POST /v1/ip-search/verdicts/:id/approve` (consultant approves the draft as final)
- `apps/api/src/routes/ip-search/override.ts` — `POST /v1/ip-search/verdicts/:id/override` (consultant changes verdict; body: `{ verdict, reasoningMarkdown }`)
- `apps/api/src/routes/ip-search/list.ts` — `GET /v1/claims/:id/ip-search/verdicts` (returns all verdicts for a claim, with status: draft / approved)
- Tests for each endpoint.

## Web files to add

- `apps/web/src/app/consultant/_components/wizard-step-2.tsx` — Step 2 panel of the wizard
- `apps/web/src/app/consultant/_components/hypothesis-card.tsx` — one card per hypothesis with: queries / hits / verdict
- `apps/web/src/lib/hooks/use-ip-search.ts` — hook bundle for the above endpoints (generateQueries, runSearches, draftVerdict, approve, override, list)

## Wizard Step 2 UX flow

```
For each hypothesis in the claim:
  ┌─────────────────────────────────────────────────────────┐
  │ HYPOTHESIS #1                                            │
  │ "We sought to determine whether..."                      │
  │                                                          │
  │ [Generate search queries] →                              │
  │                                                          │
  │   IP AUSTRALIA:  ☑ "cryogenic process AND yield"        │
  │                  ☑ "thermal process improvement"         │
  │   SEMANTIC SCHOLAR: ☑ "cryogenic yield improvement..."  │
  │   PUBMED:        ☐ "..."  [unchecked]                   │
  │   ARXIV:         ☑ "..."                                │
  │                                                          │
  │ [Run selected searches] →                                │
  │                                                          │
  │   Found 12 hits across 3 databases. [Show all]          │
  │                                                          │
  │ [Draft verdict] →                                        │
  │                                                          │
  │   DRAFT: PASS                                            │
  │   "No prior art found that addresses this specific..."  │
  │   [Approve verdict] [Override → modal]                   │
  │                                                          │
  └─────────────────────────────────────────────────────────┘
```

## Architecture rules

- All endpoints session-scoped via `requireSession`.
- Run endpoint MUST use cache: check `ip_search_run` for any row matching `(hypothesis_hash, database_name, query, ran_at > now() - interval '30 days')`. If found, return cached hits; otherwise call integration.
- Verdict endpoint atomically: load hits + call agent + INSERT verdict in one transaction.
- All writes scoped to caller's tenant via session GUC.

## Acceptance

- [ ] All 6 endpoints implemented + tested (happy path + cross-tenant isolation per endpoint).
- [ ] Cache verified: identical query within 30 days does NOT re-call the integration (assert via spy or mock).
- [ ] UI cycle: generate → tick → run → verdict → approve works end-to-end against a real claim.
- [ ] Override modal forces consultant to provide reasoning before accepting.
- [ ] `typecheck` + `lint` + tests pass.

## Deliverable

PR titled `feat(consultant): wizard step 2 — IP search per hypothesis (API + UI)`.

## Notes

This is the largest single PR in the Step 2 batch. May want to split into "API only" + "UI only" PRs if reviewer load is too heavy.
