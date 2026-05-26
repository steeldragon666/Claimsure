# 07 — IP Search Verdict PDF Report Job

**Depends on:** 01, 06

## Goal

Async pg-boss job that renders a per-claim IP-search verdict report as PDF for audit defence. Triggered when the consultant clicks "Export verdict report" OR automatically when ALL verdicts in a claim are approved.

## Files to add

- `apps/api/src/jobs/ip-search-report-render-pdf.ts`
- `apps/api/src/jobs/ip-search-report-render-pdf.test.ts`
- Register in job-runner bootstrap
- API endpoint `POST /v1/claims/:id/ip-search/report/generate` (session-required) that enqueues the job — add this to task 06's route registration OR ship as a small follow-up patch to that PR

## Implementation

1. Job payload: `{ claimId: string }`.
2. Handler steps:
   - Load claim + all `ip_search_verdict` rows for the claim (must be `approved_at IS NOT NULL` only).
   - For each verdict, load supporting hits via `ip_search_run` JOIN `ip_search_hit`.
   - Render report markdown:
     - Cover page (claim, claimant, FY, consultant)
     - One section per hypothesis with: hypothesis text, queries run (per database), top 5 hits (title + URL + relevance), analyst-approved verdict + analysis, sign-off.
   - Markdown → HTML → PDF via the same renderer used by task 03 (engagement letter PDF).
   - Upload PDF to evidence storage.
   - INSERT `evidence` row (kind = `ip_search_verdict_report`).
   - UPDATE each `ip_search_verdict.pdf_evidence_id` to the new evidence id (one report covers many verdicts, but each verdict can link back to it).

## Architecture rules

- Use `privilegedSql` (jobs run without session).
- Idempotency: if all verdicts in the claim already have the same `pdf_evidence_id` set, no-op.
- Add `kind = 'ip_search_verdict_report'` to evidence-kind allowlist (may need a small migration if a CHECK constraint exists).

## Acceptance

- [ ] Job handler renders a valid PDF for a claim with 1 hypothesis + 1 approved verdict.
- [ ] Job handler renders a valid PDF for a claim with 5 hypotheses (table of contents, paginated).
- [ ] Idempotent on re-run.
- [ ] `typecheck` + tests pass.

## Deliverable

PR titled `feat(api): ip-search-report-render-pdf pg-boss job + export endpoint`.
