# 03 — Engagement Letter PDF Render Job

**Depends on:** 01, 02

## Goal

Async pg-boss job that renders a signed engagement letter as a PDF, stores it as evidence, and links the evidence row to `engagement_letter.pdf_evidence_id`.

## Files to add

- `apps/api/src/jobs/engagement-letter-render-pdf.ts` — job handler
- `apps/api/src/jobs/engagement-letter-render-pdf.test.ts` — test
- Register in the job-runner bootstrap (look in `apps/api/src/jobs/` for the pg-boss registration pattern — likely an `index.ts` or `worker.ts`)

## Implementation

1. Job payload: `{ engagementLetterId: string }`.
2. Handler steps:
   - Load `engagement_letter` row via `privilegedSql` (job runs without session context).
   - If `pdf_evidence_id` already set → no-op (idempotent).
   - Render markdown → HTML via existing renderer (look for `marked` or `markdown-it` already in deps; if not, add `marked`).
   - Render HTML → PDF via existing renderer (look for puppeteer/playwright/pdfkit in deps; coordinate with whatever the existing `document-extract` or compliance-capture jobs use).
   - Upload PDF bytes to evidence storage (use the existing `evidence` table pattern + blob storage).
   - INSERT `evidence` row (kind = `engagement_letter_signed`, owning tenant from the engagement row).
   - UPDATE `engagement_letter.pdf_evidence_id` to new evidence id.
3. On failure: pg-boss retry per existing job conventions (max 3 retries, exponential backoff).

## Architecture rules

- Use `privilegedSql` (no session in jobs).
- Set `app.current_tenant_id` GUC manually if writing into RLS-scoped tables (mirror existing job patterns).
- Add a `kind = 'engagement_letter_signed'` value to the evidence-kind CHECK constraint if it doesn't already permit it — may need a small migration.

## Acceptance

- [ ] Job handler is idempotent (running twice on the same engagementLetterId doesn't produce two evidence rows).
- [ ] Test inserts a fake engagement letter row, enqueues the job, runs the worker, asserts a PDF evidence row exists.
- [ ] `typecheck` + `lint` pass.

## Deliverable

PR titled `feat(api): engagement-letter-render-pdf pg-boss job`.

## Notes

If the codebase doesn't have an existing HTML→PDF renderer, the task includes choosing one. Recommendation: reuse whatever the existing `documents` package or `compliance-capture` migration setup uses. If nothing exists, add `puppeteer-core` (lightest weight) and document the choice.
