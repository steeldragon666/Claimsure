# ADR-0001: Monorepo and stack

**Status:** Accepted
**Date:** 2026-04-26
**Authors:** Aaron Newson + AI pair (Claude Opus 4.7)

## Context

We are building a white-label SaaS platform (R&DTI Intelligence Platform + Australian Grants module) targeting Australian R&D tax and grant consultants. The platform must support TypeScript across mobile (Expo), web (Next.js), and API (Fastify); persist evidence in a hash-chained ledger backed by Postgres + pgvector; and run agents on Anthropic Claude.

This ADR captures the foundational stack decisions made during P0 (T1–T18). Subsequent ADRs document per-phase architectural calls (federation, hash chain, agent runtime, document templates).

## Decision

The following decisions are grouped by domain.

### Repo and tooling

- **Single greenfield monorepo** named `cpa-platform`, hosted at `github.com/steeldragon666/cpa-platform` (private).
- **pnpm 10.26.0** with `packageManager` field pinned for corepack determinism. Bumped from pnpm 9 during P0 because pnpm 9.12.3 had Windows install reliability bugs that pnpm 10 fixed (and which surfaced when we briefly tried to host the workspace on an exFAT drive).
- **turbo 2** for task orchestration with the standard build / dev / lint / test / typecheck graph.
- **Node 22 LTS** as the minimum runtime (`engines.node >= 22.0.0`).
- **TypeScript 5.6+** with strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `isolatedModules`.
- **ESM-only** — every `package.json` carries `"type": "module"`. CommonJS is not supported in our source.
- **`module: NodeNext`** + `.js` extensions in source-side relative imports (TypeScript-ESM convention). Source files end in `.ts`; their imports look like `import { x } from './foo.js'` — TypeScript and tsx both resolve this correctly, and Node's ESM resolver does too at runtime after build.

### Database and migrations

- **Postgres 16 + pgvector 0.8.0** via the official `pgvector/pgvector:0.8.0-pg16` image. Local dev runs in docker compose, bound to host port `127.0.0.1:5433` (port 5433 to coexist with any native Postgres on 5432; loopback bind to close LAN-exposure path on the trivial `cpa/cpa` dev creds).
- **The canonical local dev DB URL `postgres://cpa:cpa@localhost:5433/cpa_dev` lives in 4 places** that must agree if changed: `.env.example`, `packages/db/src/env.ts` (`DEV_DATABASE_URL`), `packages/db/drizzle.config.ts`, and `docker-compose.yml`. CI uses port 5432 because there is no host conflict in GitHub Actions runners.
- **`getDatabaseUrl()` is fail-fast in production** — it throws if `DATABASE_URL` is unset when `NODE_ENV === 'production'`, rather than silently falling back to the dev URL. Silent fallback would be a silent connect-to-the-wrong-thing bug.
- **Drizzle ORM 0.36.x** with **drizzle-kit** for migration generation. Schema is hand-authored in TypeScript; migrations are generated SQL committed to the repo at `packages/db/migrations/`.
- **`drizzle.config.ts` schema uses an extglob pattern** `'./src/schema/!(*.test|index).ts'` to auto-discover every domain table file. Excluding `*.test.ts` and `index.ts` keeps drizzle-kit's CJS loader from tripping on test imports or the barrel re-export's `.js` extensions. Trade-off: cannot use a simple `*.ts` glob, but every new table file is picked up automatically — no per-table config edit.
- **App-side UUID v4** via `crypto.randomUUID()` (Node global) using Drizzle's `$defaultFn(() => crypto.randomUUID())`. We do NOT use `gen_random_uuid()` from pgcrypto at the schema layer. Reason: matches the strict `Uuid` zod schema in `@cpa/schemas` (regex enforces v4 only); rejects v1 (MAC-leaking) and v3/v5 by construction.
- **pgcrypto is loaded** by `tools/postgres/init.sql` for two reasons: (a) it provides `gen_random_uuid()`, which we deliberately do _not_ use today (see UUID v4 reasoning above), and (b) it provides crypto primitives we'll wire into hash-chain helpers in P2. Keeping it loaded now means migrations don't need to add it later under load.
- **Audit-column convention** — every domain table carries `created_at` (notNull, defaultNow), `updated_at` (notNull, defaultNow, with Drizzle `$onUpdate(() => new Date())`), and `deleted_at` (nullable, soft-delete marker). Established in T10's `system` table. Note: `$onUpdate` only fires on the ORM `db.update()` path; raw `sql\`UPDATE\``calls must set`updated_at = NOW()`manually. A DB-side trigger may replace this when`audit_log` lands in P2.
- **Append-only audit tables in P2 (e.g. `event`, `weekly_log`, `document`) will NOT carry `deleted_at`** — they're immutable by design. The audit-column convention is "domain tables follow this shape unless documented otherwise."

### Test runner

- **Node 22 native test runner** via `tsx --test "src/**/*.test.ts"` for unit and integration tests. tsx is the TypeScript loader; node is the runner.
- Globs in package scripts use **double quotes** because Windows cmd.exe doesn't honour single quotes (silently matches zero files — a CI-green-but-broken footgun caught in T8).
- DB integration tests run against the live docker compose Postgres, not a mock. Each test file calls `await sql.end()` in `after()` so the runner exits cleanly.
- **Tests exercise both surfaces** — raw `sql\`...\``template literals AND the ORM`db.select().from(table)`. The two paths have different parser semantics: drizzle's `drizzle()`factory monkey-patches the postgres-js timestamptz parser for raw queries, so raw returns ISO strings while ORM returns`Date` objects. Tests must lock in both contracts.

### Linting + formatting

- **ESLint 9 flat config** with `typescript-eslint`'s `recommendedTypeChecked` for type-aware rules.
- **The test-file ESLint override** resolves a structural tension: each package's main `tsconfig.json` excludes `**/*.test.ts` (so the build never emits test artifacts), yet ESLint with `recommendedTypeChecked` requires every linted file to be in _some_ TS project. The resolution: each package has a sibling `tsconfig.test.json` (with `noEmit: true`) that includes only the test files; the root `eslint.config.mjs` adds a `files: ['**/*.test.ts']` block that uses the legacy `parserOptions.project: ['**/tsconfig.test.json']` to find them. The same override block also disables `@typescript-eslint/no-floating-promises` for tests because `node:test`'s `test()` returns a Promise that idiomatic test code does not await.
- Files with extensions `.js`/`.mjs`/`.cjs` get `tseslint.configs.disableTypeChecked` so root-level config files (e.g. `eslint.config.mjs` itself) lint cleanly without being in any tsconfig.
- **Prettier** with `printWidth: 100`, `singleQuote: true`, `endOfLine: lf`, `proseWrap: preserve`. `.prettierignore` scopes the markdown ignore to `docs/plans/**/*.md` (frozen artefacts) — README, ADRs, and other markdown ARE formatted.

### Observability

- **OpenTelemetry SDK Node** with **OTLP/HTTP exporter** to **Grafana Cloud** (`ap-southeast-1` for AU residency).
- **pino** for structured logs at level `info` by default (`LOG_LEVEL` env override).
- The implementation lands in T11+ (`packages/observability`, `apps/api`). Wire-up details (auto-instrumentation choices, per-span attribute conventions including `tenant_id` and `prompt_version`) will be captured in a follow-up ADR once the code lands and the conventions are validated under real traffic.

### CI

- **GitHub Actions** at `.github/workflows/ci.yml` gates push to `main` and every PR. Runs typecheck + lint + test + migrate + format:check against an inline Postgres 16 + pgvector service (image pinned to `0.8.0-pg16`).
- The Postgres service initialises extensions by `psql -f tools/postgres/init.sql` — the same file mounted by docker compose locally, so local and CI are guaranteed to load the same set.
- Concurrency group `${{ github.workflow }}-${{ github.ref }}` cancels in-progress runs on the same ref. Job-level `timeout-minutes: 20` and `permissions: contents: read` for tighter resource and security bounds.
- **Pinned**: Node 22, pnpm 10 (matches `packageManager`).
- **CI uses port 5432** (no native conflict in runners) — the only place the canonical port-5433 URL diverges.

### Filesystem layout

- Source repo on **NTFS** (C: drive). exFAT does not support symlinks, which pnpm requires for both its `.pnpm/` store layout and workspace-package linkage. Discovered the hard way by briefly trying to host the repo on an exFAT D: drive — install fails. NTFS is mandatory for the dev machine.
- **WSL2 swap on D:** (`D:\\dev\\.wsl\\swap.vhdx`, 8GB) — relieves C: RAM pressure without affecting symlink semantics. Configured via `~/.wslconfig`.
- Docker Desktop's WSL2 disk image — recommended to relocate to D: via Docker Desktop GUI (Settings → Resources → Advanced → Disk image location) when convenient. Doesn't require code changes.

## Consequences

**Positive**

- Single language (TypeScript) across mobile, web, API, and infrastructure-as-code (Drizzle schemas) reduces context switching and lets us share zod schemas (`@cpa/schemas`) between request validation and DB row shapes.
- Modern strict TS catches a class of bugs at typecheck time (the `noUncheckedIndexedAccess` setting alone has prevented several `Cannot read property 'x' of undefined` patterns in P0 code reviews).
- Hash-chain integrity from app-side UUID v4 generation: the entropy is provably v4 and the schema rejects v1 by construction, so audit-trail content addressing can never silently degrade if a future contributor switches to `gen_random_uuid()`.
- The drizzle-kit extglob discovery means new tables don't require a config edit — friction-free for contributors.

**Negative**

- The double-quoted glob convention is a Windows-compat workaround that costs us a small style oddity in `package.json` files.
- Drizzle-kit being CJS-only is a known long-term friction; we'll need to track upstream movement on https://github.com/drizzle-team/drizzle-kit/issues for an ESM resolution. The extglob workaround is good but it's still working around an upstream limitation.
- Raw-SQL UPDATE statements bypass the `$onUpdate` ORM hook on `updated_at`. A DB-side trigger would close this gap but adds boilerplate to every migration.

**Reviewable in P1**

- Connection pool size (`DATABASE_POOL_MAX`) — currently 10 for the runtime client. Bump configurably when the API hits real concurrent load.
- `updated_at` auto-bump — currently ORM-only via `$onUpdate`. May want a DB trigger when the table count exceeds 5 OR when raw-SQL UPDATE paths multiply.
- Whether to use Drizzle's `$default` vs `$defaultFn` for non-UUID generated columns (e.g. ULIDs, snowflake IDs) when those land.

## Alternatives considered

- **Prisma instead of Drizzle**: Prisma has a stronger ecosystem and migration tooling, but the ORM is opinionated (always-flat queries, generated client) and harder to escape to raw SQL. We will need raw SQL for RLS policies in P1, where Drizzle's type-passthrough patterns are more direct. Rejected.
- **Vitest instead of Node test runner**: Vitest has better DX (snapshots, mocking, watch UI) but adds a heavyweight dep. Node 22's native test runner is fast and zero-config. Acceptable until we hit a feature gap that pushes us back. Revisit when test ergonomics become painful.
- **Bun instead of Node + pnpm**: Bun is impressive but production support for Mobile (Expo) + Next.js + Drizzle is still uneven in early 2026. Once those mature, revisit.
- **Yarn Berry instead of pnpm**: Berry's PnP is unfamiliar to most contributors and has its own ecosystem rough edges. pnpm's symlinked layout is well understood. Pnpm wins on familiarity + Windows install reliability (with the v10 bump).
- **Kysely instead of Drizzle**: Kysely is more SQL-faithful and has better composability for complex queries, but Drizzle's first-class TypeScript schema and Drizzle Studio for ad-hoc inspection wins on developer ergonomics for our team size. Revisit at scale.
- **NTFS-formatted dev drive**: rejected for now because reformatting D: requires evacuating ~150 GB. The hybrid (source on C: NTFS; Docker + swap on D: exFAT — both single-file blobs that exFAT handles fine) covers most of the disk-pressure relief without the reformat.

## Related decisions

This ADR is the foundation. Likely future ADRs (numbered as they're written):

- Federated multi-tenancy and delegation tokens (P1)
- Hash chain construction and verification (P2)
- Agent runtime — classifier + extractor + drafter (P2)
- Document template engine — deterministic vs LLM-generated split (P4)

## References

- Architecture design: [`../plans/2026-04-25-rdti-grants-platform-design.md`](../plans/2026-04-25-rdti-grants-platform-design.md)
- P0 implementation plan: [`../plans/2026-04-25-p0-foundation.md`](../plans/2026-04-25-p0-foundation.md)
- pgvector ≥ 0.5 extension naming change: see commit `e4431aa` rationale ("pgvector >= 0.5.0 registers it as 'vector'")
- pnpm 10 release notes: https://github.com/pnpm/pnpm/releases/tag/v10.0.0
