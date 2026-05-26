# tools/scripts

One-off and operational CLI scripts. Each script is a standalone `tsx`
entry point — invoke via `pnpm exec tsx` or one of the `pnpm` aliases
declared in `package.json`.

## Smoke checks

### `smoke-data-plane.ts` — data-plane smoke check

Walks the read endpoints behind a session cookie, asserting HTTP status
and response shape via inline zod schemas. Complements (does not overlap
with) the signup smoke check on `chore/signup-smoke-check`, which covers
the unauthenticated auth surface.

**Endpoints exercised (in order):**

1. `GET /healthz`
2. `GET /v1/whoami`
3. `GET /v1/subject-tenants`
4. `GET /v1/claims`
5. `GET /v1/projects`
6. `GET /v1/employees`

**Usage:**

```bash
# 1. Mint a dev session cookie (requires SESSION_JWT_SECRET in .env)
pnpm exec tsx --env-file=../../.env tools/scripts/mint-dev-cookie.ts

# 2. Export the JWT it prints (the "Raw JWT" line)
export SMOKE_SESSION_COOKIE="<paste-jwt-here>"
export SMOKE_BASE_URL="http://localhost:3000"   # optional; this is the default

# 3. Run the smoke check
pnpm --filter @cpa/tools-scripts smoke:data-plane
```

**Exit code semantics:** 0 if every endpoint passes; otherwise the number
of failed endpoints (so `1` = one failure, `3` = three failures, etc.).
The script bails on the first `5xx` response — those mean the API is
down, not a data-shape issue, so further steps would just produce noise.

If `SMOKE_SESSION_COOKIE` is unset the script prints instructions and
exits with code `2`.
