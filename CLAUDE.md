# CLAUDE.md — Project Guidance

This file is read by Claude (and Claude Code subagents) when working in this repository. Add project-specific rules here.

## Project context

CPA Platform — an Australian R&D Tax Incentive (R&DTI) consulting tool. Phased delivery (P0–P9). Currently mid-P7. See `docs/plans/` for phase design + implementation plans.

**Stack:**

- Monorepo via pnpm workspaces (Node 20+, TypeScript 5+ strict)
- Backend: Fastify + drizzle-orm + postgres-js, RLS-protected schema
- Frontend: Next.js 15 App Router + React 19 + Tailwind + shadcn/Radix
- Agents: Anthropic SDK; Claude Sonnet 4.5 + Haiku 4.5
- Test runner: `node:test` via `tsx --test`

## Design system — System A (locked, single source of truth)

**There is ONE design system: System A (the "broadcast" / Claude-design theme).** As of the 2026-05-27 lockdown, the legacy "warm cream paper + patina green" (System B) is **retired**. Do not reintroduce it.

System A signature decisions (preserve unless the user explicitly revises):

- **Dark ink base** `#0b0b0d` (ink), elevated surfaces `#131316` / `#1c1c20` / `#252529`
- **Bone text** `#f0ebe2` (primary), `#cdc7bd` / `#8a857c` / `#5d594f` (muted scale)
- **Amber accent** `#e1a23a` (primary/CTA/focus), `#b88a3d` (soft); secondary semantics **sage** `#7a9685` (info/success), **rust** `#c46a48` (error/destructive)
- **Type:** Fraunces (display/serif), Geist (body/sans), JetBrains Mono (mono)
- Hairlines: `rgba(240,235,226,.10)` (rule) / `.22` (rule-strong); radius 4px buttons/inputs

**Canonical token locations:**
- `apps/web/src/app/globals.css` — shadcn `--*` + `--brand-*` CSS variables (the runtime source)
- `apps/web/tailwind.config.ts` — semantic utilities + named `ink`/`bone`/`sage`/`rust`/`rule` colors. The amber accent is `primary` / `brand-accent` (NOT a named `amber` utility — that would clobber Tailwind's built-in amber scale)
- `apps/web/src/app/consultant/_components/tokens.ts` — inline hex mirror used by the consultant workspace + onboarding
- `docs/design/system.md` + `docs/design/tokens.json` — the written spec

When building new UI: use `bg-background text-foreground`, `bg-card`, `text-muted-foreground`, `bg-primary text-primary-foreground`, `border-border`, or the named `bg-ink* / text-bone* / text-sage / text-rust / border-rule*` utilities. Don't hardcode hex unless mirroring an exact design export.

## Architecture rules (immutable)

- **Three-way parity.** New enum values in SQL CHECK constraints must mirror the Zod enum and the `@cpa/db` `AUDIT_KINDS` const. Tests at `packages/db/src/migrations.test.ts` enforce this.
- **JSONB binding double-cast.** When inserting jsonb via `postgres-js` template tags, use `${JSON.stringify(value)}::text::jsonb` (double-cast). Single-cast was a P5 bug; chain.ts fix lives in migration 0031. See `packages/db/src/audit-log.ts` JSDoc.
- **RLS protection.** Every tenant-scoped table has `ENABLE ROW LEVEL SECURITY` and a tenant-isolation policy filtering on `app.current_tenant_id` GUC. Never use `privilegedSql` for application paths; use `db` so RLS fires. Use the canonical `NULLIF(current_setting('app.current_tenant_id', true), '')::uuid` pattern.
- **Append-only audit logs.** `audit_log`, `narrative_draft_version`, `prompt_suggestion_review` all have UPDATE/DELETE revoked. Don't grant them.
- **Forensic metadata is non-negotiable.** Every claim-bearing row carries `first_recorded_at` and (where applicable) `hypothesis_formed_at`. The latter is immutable post-INSERT (PostgreSQL trigger). Body by Michael compliance hangs on this.
- **Citation-only multi-cycle summaries.** The `multi-cycle-summarize@1.0.0` agent's output schema has no free-text field for prior-year content; only references (content_hash + segment_indices) + transition classifications + bounded rationale. Don't loosen the schema.
- **`@cpa/agents` and `@cpa/db` are not imported by `apps/web`.** Web has its own local type mirrors (e.g. `CitationGraphEntry`, `NarrativeSegmentLite`). This is the package boundary; don't violate it.

## Worktrees

Worktrees live at `C:\Users\Aaron\cpa-platform-worktrees\<branch-name>\` (sibling to repo). Established convention from P1. Don't put worktrees inside the repo (gitignore would have to handle them).

## Branch sequencing

P7 themes merge in order: `p7a → p7b → p7c → p7d`. Each branch's worktree rebases onto updated `main` after the prior PR merges. Migrations are numbered with idx-gaps to allow this (e.g. p7a reserves 0037, p7b uses 0038, even if 0037 isn't local yet).

## Testing discipline

- TDD: write failing test first; run-fail; implement; run-pass; commit.
- Each commit is one logical change. Don't bundle.
- Pre-commit hook runs prettier + eslint via husky; if it fails, fix before committing.
- DB-backed tests need Postgres at port 5433 (`pnpm db:up`). If Docker is unavailable, write tests as unit-tests with mocked DB client (DI executor pattern — see `packages/agents/src/multi-cycle/walk-proposed-id.ts` for precedent).

## Subagent-driven development

When executing implementation plans (`docs/plans/*-implementation.md`), use the `superpowers:subagent-driven-development` skill. Per-task: dispatch implementer → spec compliance review → code quality review. Don't skip review loops.

## Commit message style

`type(scope): subject` — lowercase, present tense, no trailing period. Example: `feat(db): migration 0037 — forensic columns + immutability trigger`. The Co-Authored-By trailer is added automatically by the Bash tool's commit prompt.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:

- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
