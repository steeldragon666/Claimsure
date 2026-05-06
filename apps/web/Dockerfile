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

# Copy workspace manifests so pnpm can resolve the workspace graph
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

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

# Build Next.js app
RUN pnpm --filter @cpa/web build

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

# pnpm workspace manifests (needed for module resolution at runtime)
COPY pnpm-workspace.yaml ./
COPY package.json        ./

USER appuser

EXPOSE 5173

# Run next start from the monorepo root so workspace module resolution works
CMD ["node_modules/.bin/next", "start", "--port", "5173", "-d", "apps/web"]
