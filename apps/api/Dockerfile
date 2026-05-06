# =============================================================================
# CPA Platform — API Dockerfile
#
# Multi-stage build: deps → builder → runner
#   deps:    installs all dependencies (dev + prod) for the build step
#   builder: compiles TypeScript → dist/
#   runner:  minimal runtime image — no dev deps, non-root user
#
# Build context must be the monorepo root (not apps/api), so that pnpm
# workspace dependencies in packages/ are available:
#
#   docker build -f apps/api/Dockerfile -t cpa-api .
# =============================================================================

# ─── Stage 1: deps ───────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests so pnpm can resolve the workspace graph
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Copy every package.json in packages/ (needed for workspace resolution)
COPY packages/agents/package.json      packages/agents/
COPY packages/audit-score/package.json packages/audit-score/
COPY packages/auth/package.json        packages/auth/
COPY packages/db/package.json          packages/db/
COPY packages/documents/package.json   packages/documents/
COPY packages/email/package.json       packages/email/
COPY packages/integrations/package.json packages/integrations/
COPY packages/observability/package.json packages/observability/
COPY packages/schemas/package.json     packages/schemas/

# API app manifest
COPY apps/api/package.json apps/api/

# Install all deps (dev included — needed for tsc in build stage)
RUN pnpm install --frozen-lockfile --filter @cpa/api...

# ─── Stage 2: builder ────────────────────────────────────────────────────────
FROM deps AS builder

# Copy workspace package sources
COPY packages/ packages/

# Copy API source
COPY apps/api/ apps/api/

# Compile TypeScript → dist/
RUN pnpm --filter @cpa/api build

# ─── Stage 3: runner ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

ENV NODE_ENV=production

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules          ./node_modules
COPY --from=deps /app/packages/agents/node_modules      packages/agents/node_modules
COPY --from=deps /app/packages/audit-score/node_modules packages/audit-score/node_modules
COPY --from=deps /app/packages/auth/node_modules        packages/auth/node_modules
COPY --from=deps /app/packages/db/node_modules          packages/db/node_modules
COPY --from=deps /app/packages/documents/node_modules   packages/documents/node_modules
COPY --from=deps /app/packages/email/node_modules       packages/email/node_modules
COPY --from=deps /app/packages/integrations/node_modules packages/integrations/node_modules
COPY --from=deps /app/packages/observability/node_modules packages/observability/node_modules
COPY --from=deps /app/packages/schemas/node_modules     packages/schemas/node_modules

# Copy compiled packages (workspace deps of the API — js files only, no src)
COPY --from=builder /app/packages/agents/dist          packages/agents/dist
COPY --from=builder /app/packages/agents/package.json  packages/agents/package.json
COPY --from=builder /app/packages/audit-score/dist     packages/audit-score/dist
COPY --from=builder /app/packages/audit-score/package.json packages/audit-score/package.json
COPY --from=builder /app/packages/auth/dist            packages/auth/dist
COPY --from=builder /app/packages/auth/package.json    packages/auth/package.json
COPY --from=builder /app/packages/db/dist              packages/db/dist
COPY --from=builder /app/packages/db/package.json      packages/db/package.json
COPY --from=builder /app/packages/documents/dist       packages/documents/dist
COPY --from=builder /app/packages/documents/package.json packages/documents/package.json
COPY --from=builder /app/packages/email/dist           packages/email/dist
COPY --from=builder /app/packages/email/package.json   packages/email/package.json
COPY --from=builder /app/packages/integrations/dist    packages/integrations/dist
COPY --from=builder /app/packages/integrations/package.json packages/integrations/package.json
COPY --from=builder /app/packages/observability/dist   packages/observability/dist
COPY --from=builder /app/packages/observability/package.json packages/observability/package.json
COPY --from=builder /app/packages/schemas/dist         packages/schemas/dist
COPY --from=builder /app/packages/schemas/package.json packages/schemas/package.json

# Copy compiled API
COPY --from=builder /app/apps/api/dist        apps/api/dist
COPY --from=builder /app/apps/api/package.json apps/api/package.json

# pnpm workspace manifests (needed for module resolution at runtime)
COPY pnpm-workspace.yaml ./
COPY package.json        ./

USER appuser

EXPOSE 3000

CMD ["node", "apps/api/dist/server.js"]
