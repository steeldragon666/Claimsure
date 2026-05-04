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

## Design system

**Always read `docs/design/system.md` and `docs/design/brief.md` before making any visual or UI decisions.** All font choices, colors, spacing, and aesthetic direction are defined there. The token spec at `docs/design/tokens.json` is the binding source of truth.

Do not deviate without explicit user approval. In QA mode, flag any code that doesn't match `system.md`. The three signature decisions (Fraunces serif, warm cream paper base `#FAF8F3`, patina green accent `#5C7A6B`) must be preserved unless explicitly revised.

If you're about to write a new shadcn/Radix component variant, check `system.md` Component variant overrides first.

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
