# =============================================================================
# CPA Platform — Web Dockerfile
#
# Multi-stage build: deps → builder → runner
#   deps:    installs all dependencies for the build step
#   builder: runs `next build`
#   runner:  minimal runtime image with Next.js server, non-root user
#
# Build context must be the monorepo root (not apps/web), so that pnpm
# workspace dependencies in packages/ are available:
#
#   docker build -f apps/web/Dockerfile -t cpa-web .
# =============================================================================

# ─── Stage 1: deps ───────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests so pnpm can resolve the workspace graph,
# plus the root tsconfig.base.json that apps/web/tsconfig.json extends.
# Next.js's TypeScript pipeline resolves tsconfig.json's `extends` field
# at build time; if /app/tsconfig.base.json is missing, `next build` fails
# with TS5083: Cannot read file '/app/tsconfig.base.json'.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# Copy every package.json in packages/ (needed for workspace resolution)
COPY packages/agents/package.json       packages/agents/
COPY packages/audit-score/package.json  packages/audit-score/
COPY packages/auth/package.json         packages/auth/
COPY packages/db/package.json           packages/db/
COPY packages/documents/package.json    packages/documents/
COPY packages/email/package.json        packages/email/
COPY packages/integrations/package.json packages/integrations/
COPY packages/observability/package.json packages/observability/
COPY packages/schemas/package.json      packages/schemas/

# Web app manifest
COPY apps/web/package.json apps/web/

# Install all deps (dev included — needed for next build in builder stage)
RUN pnpm install --frozen-lockfile --filter @cpa/web...

# ─── Stage 2: builder ────────────────────────────────────────────────────────
FROM deps AS builder

ENV NEXT_TELEMETRY_DISABLED=1

# Copy workspace package sources
COPY packages/ packages/

# Copy web app source
COPY apps/web/ apps/web/

# Build workspace deps FIRST, then web.
#
# Why: every workspace package's package.json `exports` field points at
# `./dist/index.js` (the compiled output). When Next.js's webpack tries
# to resolve `import { Foo } from '@cpa/schemas'` during `next build`,
# it reads packages/schemas/package.json, finds
# `"import": "./dist/index.js"`, and looks for that file — which doesn't
# exist unless we built schemas first.
#
# An earlier attempt used `pnpm -r --filter=...@cpa/web build` for
# topological build order, but in this Dockerfile's builder context
# that filter produced no upstream builds — only @cpa/web's `next build`
# ran. Rather than debug pnpm's filter behaviour against a Docker
# builder image, we just enumerate the deps explicitly. Slower to
# maintain (every new workspace dep of web has to be added here) but
# deterministic.
#
# Order matches the runtime dep graph from apps/web/package.json:
#   schemas → email → web (auth and db are devDeps; type-only imports
#   don't need dist/ at runtime, so we skip them).
#
# (The api Dockerfile is fine with `pnpm --filter @cpa/api build`
# because @cpa/api's build script is `tsc -b`, which IS project-
# reference-aware and builds upstream packages topologically. Next.js's
# `next build` is not — hence this explicit chain.)
RUN pnpm --filter @cpa/schemas build \
 && pnpm --filter @cpa/email   build \
 && pnpm --filter @cpa/web     build

# ─── Stage 3: runner ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy compiled workspace packages that web depends on at runtime
COPY --from=deps /app/node_modules               ./node_modules
COPY --from=deps /app/packages/schemas/node_modules packages/schemas/node_modules

COPY --from=builder /app/packages/schemas/dist         packages/schemas/dist
COPY --from=builder /app/packages/schemas/package.json packages/schemas/package.json

# Copy Next.js build output
COPY --from=builder /app/apps/web/.next      apps/web/.next
COPY --from=builder /app/apps/web/public     apps/web/public
COPY --from=builder /app/apps/web/package.json apps/web/package.json

# Copy next.config.ts so `next start` can resolve the outputFileTracingRoot
COPY --from=builder /app/apps/web/next.config.ts apps/web/next.config.ts

# Workspace symlinks from pnpm (e.g., apps/web/node_modules/@cpa/schemas ->
# ../../packages/schemas). Next.js's server-side runtime resolves these at
# request time, so the symlinks must be present in the runner image. First
# deploy crash-loop on archiveone.com.au was MODULE_NOT_FOUND from web start.
COPY --from=deps /app/apps/web/node_modules    apps/web/node_modules

# pnpm workspace manifests (needed for module resolution at runtime)
COPY pnpm-workspace.yaml ./
COPY package.json        ./

USER appuser

EXPOSE 5173

# Run `next start` from the monorepo root so workspace module resolution
# works.
#
# Path is `apps/web/node_modules/.bin/next`, NOT `node_modules/.bin/next` —
# pnpm installs per-app binaries in the consuming workspace's
# node_modules/.bin/, not in the root. The previous root-relative path
# crash-looped with MODULE_NOT_FOUND: '/app/node_modules/.bin/next'
# on first VPS deploy.
#
# `next start` takes the project directory as a POSITIONAL argument, not
# via `-d` (which next.js doesn't have — the original CMD had `-d apps/web`
# and crash-looped with `error: unknown option '-d'`).
CMD ["apps/web/node_modules/.bin/next", "start", "--port", "5173", "apps/web"]
