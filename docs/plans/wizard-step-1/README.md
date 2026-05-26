# Wizard Step 1 — Engagement Letter E-Signing

**Design doc:** [../2026-05-25-wizard-step-1-engagement-letter-design.md](../2026-05-25-wizard-step-1-engagement-letter-design.md)
**Status:** Decisions locked — ready for dispatch
**Goal:** Build the in-house e-signing flow for the engagement letter that the claimant signs on first mobile-app launch (with web fallback) and the consultant counter-signs in the web app.

## Decisions

- **In-house** signing (no DocuSign).
- **Per-firm template** (`tenant.engagement_letter_template_md`) + per-claim variable substitution.
- **Mobile-first + web email-link fallback** (`/engagement/[token]/sign`).
- **Claimant + consultant counter-sign** (bilateral consent).
- **Auto-remind at 7d + 14d; auto-expire at 30d.**
- **PDF rendered async via pg-boss** immediately after sign.

## Task list

| ID | File | Surface | Depends on |
|----|------|---------|------------|
| 01 | [01-migration.md](01-migration.md) | DB schema | — |
| 02 | [02-engagement-api.md](02-engagement-api.md) | API endpoints | 01 |
| 03 | [03-engagement-pdf-job.md](03-engagement-pdf-job.md) | pg-boss job | 01, 02 |
| 04 | [04-engagement-reminder-expire-job.md](04-engagement-reminder-expire-job.md) | pg-boss job | 01, 02 |
| 05 | [05-mobile-sign-screen.md](05-mobile-sign-screen.md) | apps/mobile | 02 |
| 06 | [06-web-fallback.md](06-web-fallback.md) | apps/web public route | 02 |
| 07 | [07-wizard-step-1-countersign.md](07-wizard-step-1-countersign.md) | consultant wizard | 02 |

## Cross-task conventions

- All new tables RLS-scoped via `tenant_id = current_setting('app.current_tenant_id', true)::uuid`.
- All endpoints session-scoped via `requireSession` preHandler (except `/engagement/[token]/sign` which is token-gated).
- Match design language tokens (`tokens.ts`, `MonoLabel`, `Diamond`). No Tailwind.
- Run `pnpm prettier --write` + `pnpm eslint --max-warnings=0` before commit. Never `--no-verify`.

## Suggested handoff sequence (~1.5 weeks total)

| Day | Track A | Track B |
|-----|---------|---------|
| 1 | 01 (migration) | — |
| 2 | 02 (API) | — |
| 3 | 03 (PDF job) | 04 (reminder job) |
| 4 | 05 (mobile sign) | 06 (web fallback) |
| 5 | 07 (wizard countersign) | smoke test + cleanup |
