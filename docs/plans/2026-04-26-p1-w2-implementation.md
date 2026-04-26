# P1 W2 — Auth Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task.

**Goal:** Land OIDC login (Microsoft Entra + Google Workspace), JWT-cookie session management, and a Fastify session middleware that opens a transaction-scoped RLS context per request — making W1's RLS infrastructure actually usable from real authenticated traffic.

**Architecture:** New `@cpa/auth` package provides `oidc.ts` (PKCE + state + nonce via `openid-client`), `jwt.ts` (sign/verify our session JWT via `jose`), `users.ts` (find-or-create + lookup-active-tenant queries), and `session.ts` (Fastify plugin that verifies the cookie, opens a `db.transaction()`, calls `set_config('app.current_tenant_id', ..., is_local := true)`, and attaches `req.user` + `req.tx`). Apps/api gets `/v1/auth/{microsoft,google}/{login,callback}`, `/v1/auth/signout`, and `/v1/whoami`.

**Tech Stack:** Node 22, TypeScript 5.6 strict, Fastify 5, `openid-client@^5`, `jose@^5`, `@fastify/cookie@^11`, `nock@^14` (test only), Postgres 16 + RLS via `set_config()`.

**Source design:** [P1 W2 design](./2026-04-26-p1-w2-auth-design.md), all 5 decisions locked.

**Branch:** Continue on `p1/identity-tenancy` (currently at `a704f94`). No new branch for W2.

---

## Pre-flight checklist (do once)

- [ ] Working in `C:\Users\Aaron\cpa-platform-worktrees\p1\` on `p1/identity-tenancy`
- [ ] Postgres up: `docker ps --filter name=cpa-postgres` returns `Up...`
- [ ] All W1 tests pass: `pnpm test` — 17 across 4 packages
- [ ] `.env` and `.env.example` present at worktree root
- [ ] `cpa_app` role exists (verified by `pnpm --filter @cpa/db migrate` being a no-op now)

---

## Task 1: Scaffold `packages/auth/` workspace package

**Why first:** Every other task depends on this package existing in the workspace.

**Files:**
- Create: `packages/auth/package.json`
- Create: `packages/auth/tsconfig.json`
- Create: `packages/auth/src/index.ts`
- Create: `packages/auth/eslint.config.js` (or whatever convention sibling packages use — read first)

**Step 1: Read sibling package layout**

Read `packages/observability/package.json`, `packages/observability/tsconfig.json`, and `packages/observability/eslint.config.js` (if it exists) to confirm the workspace convention. The new package mirrors them exactly.

**Step 2: Write `packages/auth/package.json`**

```json
{
  "name": "@cpa/auth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -b",
    "test": "cross-env LOG_LEVEL=silent tsx --test \"src/**/*.test.ts\"",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@cpa/db": "workspace:*",
    "@cpa/schemas": "workspace:*",
    "fastify": "^5.2.0",
    "fastify-plugin": "^5.0.1",
    "jose": "^5.9.6",
    "openid-client": "^5.7.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "cross-env": "^7.0.3",
    "nock": "^14.0.0-beta.16",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3"
  }
}
```

(Confirm version pins by running `npm view <pkg> version` for each — adjust if needed; the spec is "current latest as of 2026-04-26".)

**Step 3: Write `packages/auth/tsconfig.json`**

Copy from `packages/observability/tsconfig.json` — same `extends` and same `references` pattern. Add reference to `@cpa/db` and `@cpa/schemas`.

**Step 4: Write `packages/auth/src/index.ts`**

```ts
// Barrel — populated as oidc/jwt/users/session land in T3-T6.
export {};
```

**Step 5: Install + typecheck + build**

```bash
cd /c/Users/Aaron/cpa-platform-worktrees/p1
pnpm install --frozen-lockfile=false   # adds new package to workspace
pnpm --filter @cpa/auth typecheck       # exit 0
pnpm --filter @cpa/auth build           # exit 0
pnpm --filter @cpa/auth lint            # exit 0
```

**Step 6: Commit**

```bash
git add packages/auth/ pnpm-lock.yaml
git commit -m "feat(auth): scaffold @cpa/auth workspace package

Empty barrel export. Subsequent tasks (T3-T6) populate jwt, oidc,
users, session modules. Dependencies: openid-client@5, jose@5,
fastify-plugin@5, nock@14 (test-only).

P1 W2 task 1 of 13."
```

---

## Task 2: Add `@fastify/cookie` to apps/api

**Files:** `apps/api/package.json`

**Step 1: Add dependency**

```bash
cd /c/Users/Aaron/cpa-platform-worktrees/p1
pnpm --filter @cpa/api add @fastify/cookie@^11
```

**Step 2: Verify install**

```bash
cat apps/api/package.json | grep '@fastify/cookie'
# expects: "@fastify/cookie": "^11.x.x"
```

**Step 3: Register the plugin in `apps/api/src/app.ts`**

Read the current `app.ts` first. After `await app.register(<existing zod plugin>)`, add:

```ts
import cookie from '@fastify/cookie';
// ...
await app.register(cookie, {
  // No global secret — JWT carries its own integrity via jose
});
```

**Step 4: Verify gates**

```bash
pnpm --filter @cpa/api typecheck   # exit 0
pnpm --filter @cpa/api build       # exit 0
pnpm --filter @cpa/api lint        # exit 0
pnpm --filter @cpa/api test        # 9/9 still pass
```

**Step 5: Commit**

```bash
git add apps/api/package.json apps/api/src/app.ts pnpm-lock.yaml
git commit -m "feat(api): register @fastify/cookie plugin

Required for W2 session cookie reads in the Fastify session
middleware. No global secret — JWT carries its own integrity
via jose; cookie is just transport.

P1 W2 task 2 of 13."
```

---

## Task 3: Implement `packages/auth/src/jwt.ts` (sign/verify)

**Why this matters:** Every protected request will verify the JWT this module issues. Get this right and the rest of the auth path is mechanical.

**Files:**
- Create: `packages/auth/src/jwt.ts`
- Create: `packages/auth/src/jwt.test.ts`

**Step 1: Write the test FIRST**

Create `packages/auth/src/jwt.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, type SessionClaims } from './jwt.js';

const TEST_SECRET = 'test-secret-32-bytes-of-entropy!!';

const baseClaims: SessionClaims = {
  sub: '00000000-0000-4000-8000-000000000001',
  email: 'jane@example.com',
  primaryIdp: 'microsoft',
  activeTenantId: '00000000-0000-4000-8000-0000000000a1',
  activeRole: 'consultant',
  availableTenants: [
    {
      tenantId: '00000000-0000-4000-8000-0000000000a1',
      name: 'Firm A',
      slug: 'firm-a',
      role: 'consultant',
    },
  ],
};

test('signSession + verifySession: roundtrip preserves all claims', async () => {
  const jwt = await signSession(baseClaims, TEST_SECRET, { ttlSeconds: 3600 });
  assert.equal(typeof jwt, 'string');
  assert.ok(jwt.split('.').length === 3, 'is a JWT');

  const verified = await verifySession(jwt, TEST_SECRET);
  assert.equal(verified.sub, baseClaims.sub);
  assert.equal(verified.email, baseClaims.email);
  assert.equal(verified.primaryIdp, baseClaims.primaryIdp);
  assert.equal(verified.activeTenantId, baseClaims.activeTenantId);
  assert.equal(verified.activeRole, baseClaims.activeRole);
  assert.deepEqual(verified.availableTenants, baseClaims.availableTenants);
  assert.equal(typeof verified.iat, 'number');
  assert.equal(typeof verified.exp, 'number');
  assert.equal(verified.exp - verified.iat, 3600);
});

test('verifySession: rejects expired JWT', async () => {
  const jwt = await signSession(baseClaims, TEST_SECRET, { ttlSeconds: -1 });
  await assert.rejects(verifySession(jwt, TEST_SECRET), /expired/i);
});

test('verifySession: rejects tampered signature', async () => {
  const jwt = await signSession(baseClaims, TEST_SECRET, { ttlSeconds: 3600 });
  const parts = jwt.split('.');
  const tamperedSig = parts[2]!.slice(0, -2) + 'xx';
  const tampered = `${parts[0]!}.${parts[1]!}.${tamperedSig}`;
  await assert.rejects(verifySession(tampered, TEST_SECRET), /signature/i);
});

test('verifySession: rejects wrong secret', async () => {
  const jwt = await signSession(baseClaims, TEST_SECRET, { ttlSeconds: 3600 });
  await assert.rejects(verifySession(jwt, 'different-secret-32-bytes-here!!'), /signature/i);
});

test('signSession: handles null activeTenantId for users with no tenant_user rows', async () => {
  const claims: SessionClaims = { ...baseClaims, activeTenantId: null, activeRole: null, availableTenants: [] };
  const jwt = await signSession(claims, TEST_SECRET, { ttlSeconds: 3600 });
  const verified = await verifySession(jwt, TEST_SECRET);
  assert.equal(verified.activeTenantId, null);
  assert.equal(verified.activeRole, null);
  assert.deepEqual(verified.availableTenants, []);
});
```

**Step 2: Run test, expect RED**

```bash
cd /c/Users/Aaron/cpa-platform-worktrees/p1
pnpm --filter @cpa/auth test
```

Expected: errors because `./jwt.js` doesn't exist yet.

**Step 3: Implement `packages/auth/src/jwt.ts`**

```ts
import { jwtVerify, SignJWT } from 'jose';

export interface AvailableTenant {
  tenantId: string;
  name: string;
  slug: string;
  role: 'admin' | 'consultant' | 'viewer';
}

export interface SessionClaims {
  sub: string;                          // user.id
  email: string;
  primaryIdp: 'microsoft' | 'google';
  activeTenantId: string | null;
  activeRole: 'admin' | 'consultant' | 'viewer' | null;
  availableTenants: AvailableTenant[];
}

export interface VerifiedSession extends SessionClaims {
  iat: number;
  exp: number;
}

const ISSUER = 'cpa-platform';
const AUDIENCE = 'cpa-api';

const secretToKey = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export interface SignOptions {
  ttlSeconds: number;
}

/**
 * Sign a session JWT (HS256) carrying the user's identity, active tenant,
 * and the firms they belong to. Cookie value at runtime.
 */
export async function signSession(
  claims: SessionClaims,
  secret: string,
  opts: SignOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + opts.ttlSeconds)
    .sign(secretToKey(secret));
}

/**
 * Verify a session JWT and return the claims. Throws on invalid signature,
 * wrong issuer/audience, or expired exp. The two-step verify (signature
 * first, then claim shape) is what jose's jwtVerify does natively.
 */
export async function verifySession(jwt: string, secret: string): Promise<VerifiedSession> {
  const { payload } = await jwtVerify(jwt, secretToKey(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  // Narrow JWTPayload back to our shape. jose has already verified iss/aud/exp.
  return {
    sub: String(payload.sub),
    email: String(payload['email']),
    primaryIdp: payload['primaryIdp'] as 'microsoft' | 'google',
    activeTenantId: (payload['activeTenantId'] as string | null) ?? null,
    activeRole: (payload['activeRole'] as 'admin' | 'consultant' | 'viewer' | null) ?? null,
    availableTenants: (payload['availableTenants'] as AvailableTenant[]) ?? [],
    iat: Number(payload.iat),
    exp: Number(payload.exp),
  };
}
```

**Step 4: Run test, expect GREEN**

```bash
pnpm --filter @cpa/auth test
```

Expected: 5/5 pass.

**Step 5: Update `packages/auth/src/index.ts`**

```ts
export * from './jwt.js';
```

**Step 6: Verify gates**

```bash
pnpm --filter @cpa/auth typecheck   # exit 0
pnpm --filter @cpa/auth lint        # exit 0
pnpm --filter @cpa/auth build       # exit 0
```

**Step 7: Commit**

```bash
git add packages/auth/src/jwt.ts packages/auth/src/jwt.test.ts packages/auth/src/index.ts
git commit -m "feat(auth): JWT sign/verify via jose (HS256)

5 unit tests cover: roundtrip preserves all claims; expired token
rejected; tampered signature rejected; wrong secret rejected;
null activeTenantId handled (for users with no tenant_user rows).

JWT shape per W2 design: sub (user.id), email, primaryIdp,
activeTenantId, activeRole, availableTenants[]. Issuer cpa-platform,
audience cpa-api.

P1 W2 task 3 of 13."
```

---

## Task 4: Implement `packages/auth/src/oidc.ts` (PKCE + state + nonce)

**Why parallel-safe with T3:** No file overlap; both are leaf modules. T3+T4+T5 dispatched together.

**Files:**
- Create: `packages/auth/src/oidc.ts`
- Create: `packages/auth/src/oidc.test.ts`

**Step 1: Write the test FIRST**

Create `packages/auth/src/oidc.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePkce, generateState, generateNonce } from './oidc.js';

test('generatePkce: returns verifier 43-128 chars and S256 challenge', () => {
  const { verifier, challenge, method } = generatePkce();
  assert.equal(method, 'S256');
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(verifier, challenge);
});

test('generatePkce: each call produces a new verifier', () => {
  const a = generatePkce();
  const b = generatePkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.challenge, b.challenge);
});

test('generateState: returns 43+ chars of url-safe entropy', () => {
  const s = generateState();
  assert.ok(s.length >= 43);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
});

test('generateState: collisions extremely unlikely (1000 calls all unique)', () => {
  const set = new Set<string>();
  for (let i = 0; i < 1000; i++) set.add(generateState());
  assert.equal(set.size, 1000);
});

test('generateNonce: returns 43+ chars of url-safe entropy and is unique', () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.ok(a.length >= 43);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b);
});
```

**Step 2: Run test, expect RED**

```bash
pnpm --filter @cpa/auth test
```

Expected: errors because `./oidc.js` doesn't exist.

**Step 3: Implement `packages/auth/src/oidc.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Generate a PKCE verifier + S256 challenge pair per RFC 7636.
 * Verifier: 32 bytes of entropy → 43-char base64url string.
 * Challenge: SHA-256 of verifier → 43-char base64url string.
 *
 * The verifier is held in the OIDC handshake cookie; the challenge
 * goes to the IdP in the authorization request. On callback, the
 * verifier is sent in the token-exchange request — proves possession.
 */
export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/**
 * Generate a CSRF state token. Held in handshake cookie + sent to IdP;
 * we verify on callback that returned state matches what we issued.
 */
export function generateState(): string {
  return base64url(randomBytes(32));
}

/**
 * Generate a one-time nonce included in the OIDC ID token. Verifying it
 * on callback prevents replay of an old ID token.
 */
export function generateNonce(): string {
  return base64url(randomBytes(32));
}
```

**Step 4: Run test, expect GREEN**

```bash
pnpm --filter @cpa/auth test
```

Expected: jwt 5/5 + oidc 5/5 = 10/10 pass.

**Step 5: Update `index.ts`**

```ts
export * from './jwt.js';
export * from './oidc.js';
```

**Step 6: Verify gates + commit**

```bash
pnpm --filter @cpa/auth typecheck && pnpm --filter @cpa/auth lint && pnpm --filter @cpa/auth build
git add packages/auth/src/oidc.ts packages/auth/src/oidc.test.ts packages/auth/src/index.ts
git commit -m "feat(auth): OIDC handshake helpers — PKCE, state, nonce

5 unit tests cover: PKCE pair shape (S256, 43-char verifier/challenge);
each call produces fresh material; state ≥43 chars url-safe entropy;
1000-call collision check; nonce is unique per call.

All three primitives use crypto.randomBytes(32) → base64url → 43 chars
of entropy. Ready for the OIDC handshake helper functions in T7-T8.

P1 W2 task 4 of 13."
```

---

## Task 5: Implement `packages/auth/src/users.ts` (find-or-create + active-tenant lookup)

**Why parallel-safe with T3+T4:** Different file; uses Drizzle which is independent of jwt/oidc.

**Files:**
- Create: `packages/auth/src/users.ts`
- Create: `packages/auth/src/users.test.ts`

**Step 1: Read DB client + schemas to confirm imports**

```bash
cat packages/db/src/client.ts
cat packages/db/src/schema/user.ts | head -10
cat packages/db/src/schema/tenant_user.ts | head -10
```

You'll see exports `sql`, `db`, `user`, `tenantUser`, `tenant`. Use these in T5.

**Step 2: Write the test FIRST**

Create `packages/auth/src/users.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '@cpa/db/client';
import { findOrCreateUser, lookupActiveTenant } from './users.js';

const TENANT_A = '00000000-0000-4000-8000-0000000000a0';
const TENANT_B = '00000000-0000-4000-8000-0000000000b0';
const USER_NEW_EXTERNAL_ID = 'microsoft:test-new-user-oid';
const USER_EXISTING_EXTERNAL_ID = 'microsoft:test-existing-user-oid';
const USER_EXISTING_ID = '00000000-0000-4000-8000-0000000000e1';

before(async () => {
  // Seed two tenants and one existing user
  await sql`INSERT INTO tenant (id, name, slug, primary_idp)
            VALUES (${TENANT_A}, 'Firm A', 'firm-a-test', 'mixed'),
                   (${TENANT_B}, 'Firm B', 'firm-b-test', 'mixed')`;
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id)
            VALUES (${USER_EXISTING_ID}, 'existing@example.com', 'microsoft', ${USER_EXISTING_EXTERNAL_ID})`;
  // Membership for existing user — A is non-default, B is default
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
    await tx`INSERT INTO tenant_user (tenant_id, user_id, role, is_default)
             VALUES (${TENANT_A}, ${USER_EXISTING_ID}, 'consultant', false)`;
  });
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B}, true)`;
    await tx`INSERT INTO tenant_user (tenant_id, user_id, role, is_default)
             VALUES (${TENANT_B}, ${USER_EXISTING_ID}, 'admin', true)`;
  });
});

after(async () => {
  // Cleanup membership rows (RLS-protected)
  for (const t of [TENANT_A, TENANT_B]) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${t}, true)`;
      await tx`DELETE FROM tenant_user WHERE tenant_id = ${t}`;
    });
  }
  await sql`DELETE FROM "user" WHERE external_id LIKE 'microsoft:test-%'`;
  await sql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
  await sql.end();
});

test('findOrCreateUser: creates a new user when external_id unseen', async () => {
  const user = await findOrCreateUser({
    primaryIdp: 'microsoft',
    externalId: USER_NEW_EXTERNAL_ID,
    email: 'new@example.com',
    displayName: 'New User',
  });
  assert.match(user.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'is uuid v4');
  assert.equal(user.email, 'new@example.com');
  assert.equal(user.displayName, 'New User');
  assert.equal(user.primaryIdp, 'microsoft');
  assert.equal(user.externalId, USER_NEW_EXTERNAL_ID);
});

test('findOrCreateUser: finds existing user by (primaryIdp, externalId)', async () => {
  const user = await findOrCreateUser({
    primaryIdp: 'microsoft',
    externalId: USER_EXISTING_EXTERNAL_ID,
    email: 'updated-email@example.com',  // different email; should NOT change existing row
    displayName: 'Existing User',
  });
  assert.equal(user.id, USER_EXISTING_ID);
  assert.equal(user.email, 'existing@example.com', 'email NOT updated on subsequent login');
});

test('findOrCreateUser: updates last_login_at on existing user', async () => {
  const before = await sql<{ last_login_at: Date | null }[]>`
    SELECT last_login_at FROM "user" WHERE id = ${USER_EXISTING_ID}
  `;
  await findOrCreateUser({
    primaryIdp: 'microsoft',
    externalId: USER_EXISTING_EXTERNAL_ID,
    email: 'existing@example.com',
    displayName: null,
  });
  const after = await sql<{ last_login_at: Date | null }[]>`
    SELECT last_login_at FROM "user" WHERE id = ${USER_EXISTING_ID}
  `;
  assert.notEqual(before[0]?.last_login_at?.getTime(), after[0]?.last_login_at?.getTime());
});

test('lookupActiveTenant: returns is_default=true row first', async () => {
  const result = await lookupActiveTenant(USER_EXISTING_ID);
  assert.equal(result.activeTenantId, TENANT_B, 'B is default');
  assert.equal(result.activeRole, 'admin');
  assert.equal(result.availableTenants.length, 2);
  const a = result.availableTenants.find((t) => t.tenantId === TENANT_A);
  const b = result.availableTenants.find((t) => t.tenantId === TENANT_B);
  assert.ok(a && b);
  assert.equal(b?.role, 'admin');
  assert.equal(a?.role, 'consultant');
});

test('lookupActiveTenant: returns null active for user with no memberships', async () => {
  // Use a fresh user with no tenant_user rows
  const FRESH_USER = '00000000-0000-4000-8000-0000000000ef';
  await sql`INSERT INTO "user" (id, email, primary_idp, external_id)
            VALUES (${FRESH_USER}, 'fresh@example.com', 'google', 'google:test-fresh')`;
  try {
    const result = await lookupActiveTenant(FRESH_USER);
    assert.equal(result.activeTenantId, null);
    assert.equal(result.activeRole, null);
    assert.deepEqual(result.availableTenants, []);
  } finally {
    await sql`DELETE FROM "user" WHERE id = ${FRESH_USER}`;
  }
});
```

**Step 3: Run test, expect RED**

```bash
pnpm --filter @cpa/auth test
```

Expected: `./users.js` not found.

**Step 4: Implement `packages/auth/src/users.ts`**

```ts
import { sql } from '@cpa/db/client';

export interface FindOrCreateUserInput {
  primaryIdp: 'microsoft' | 'google';
  externalId: string;
  email: string;
  displayName: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  primaryIdp: 'microsoft' | 'google';
  externalId: string;
}

export interface AvailableTenantRow {
  tenantId: string;
  name: string;
  slug: string;
  role: 'admin' | 'consultant' | 'viewer';
  isDefault: boolean;
}

export interface ActiveTenantResult {
  activeTenantId: string | null;
  activeRole: 'admin' | 'consultant' | 'viewer' | null;
  availableTenants: AvailableTenantRow[];
}

/**
 * Look up a user by (primaryIdp, externalId). If found, bump
 * last_login_at to NOW() and return the row. If not found, INSERT a new
 * row and return it.
 *
 * email + displayName from the IdP are used ONLY when creating a new
 * row. We deliberately do NOT update them on subsequent logins —
 * that's an audit-trail concern: a malicious IdP-side rename should
 * not change our authoritative email.
 *
 * Note: user table is GLOBAL (no RLS) — direct sql writes work.
 */
export async function findOrCreateUser(input: FindOrCreateUserInput): Promise<UserRow> {
  const existing = await sql<UserRow[]>`
    UPDATE "user"
       SET last_login_at = NOW()
     WHERE primary_idp = ${input.primaryIdp}
       AND external_id = ${input.externalId}
       AND deleted_at IS NULL
    RETURNING id, email, display_name AS "displayName", primary_idp AS "primaryIdp", external_id AS "externalId"
  `;
  if (existing[0]) return existing[0];

  const created = await sql<UserRow[]>`
    INSERT INTO "user" (id, email, display_name, primary_idp, external_id, last_login_at)
    VALUES (gen_random_uuid_v4_app(), ${input.email}, ${input.displayName}, ${input.primaryIdp}, ${input.externalId}, NOW())
    RETURNING id, email, display_name AS "displayName", primary_idp AS "primaryIdp", external_id AS "externalId"
  `;
  // ^ NOTE: we don't have gen_random_uuid_v4_app SQL function. Use crypto.randomUUID() in JS instead.
  // FIXED VERSION below — replace the INSERT block above with this one:
  /*
  const newId = crypto.randomUUID();
  const created = await sql<UserRow[]>`
    INSERT INTO "user" (id, email, display_name, primary_idp, external_id, last_login_at)
    VALUES (${newId}, ${input.email}, ${input.displayName}, ${input.primaryIdp}, ${input.externalId}, NOW())
    RETURNING id, email, display_name AS "displayName", primary_idp AS "primaryIdp", external_id AS "externalId"
  `;
  */

  if (!created[0]) throw new Error('findOrCreateUser: INSERT did not return a row');
  return created[0];
}
```

> ⚠️ **Implementer note:** The block marked NOTE/FIXED in the comment is the actual code to use; the wrong block above it is shown for instructional reference only. Use `crypto.randomUUID()` to generate the id, NOT a SQL function. Final implementation:

```ts
export async function findOrCreateUser(input: FindOrCreateUserInput): Promise<UserRow> {
  const existing = await sql<UserRow[]>`
    UPDATE "user"
       SET last_login_at = NOW()
     WHERE primary_idp = ${input.primaryIdp}
       AND external_id = ${input.externalId}
       AND deleted_at IS NULL
    RETURNING id, email, display_name AS "displayName", primary_idp AS "primaryIdp", external_id AS "externalId"
  `;
  if (existing[0]) return existing[0];

  const newId = crypto.randomUUID();
  const created = await sql<UserRow[]>`
    INSERT INTO "user" (id, email, display_name, primary_idp, external_id, last_login_at)
    VALUES (${newId}, ${input.email}, ${input.displayName}, ${input.primaryIdp}, ${input.externalId}, NOW())
    RETURNING id, email, display_name AS "displayName", primary_idp AS "primaryIdp", external_id AS "externalId"
  `;
  if (!created[0]) throw new Error('findOrCreateUser: INSERT did not return a row');
  return created[0];
}

/**
 * Look up the user's active tenant + all firms they belong to.
 * Active = is_default DESC, created_at ASC LIMIT 1 (per design Q4).
 * If user has zero tenant_user rows, returns activeTenantId/Role null.
 *
 * Note: tenant_user is RLS-protected. We need to either:
 *   (a) issue a SET LOCAL on a privileged role for this lookup, OR
 *   (b) do a join WITHOUT RLS by querying as cpa_app with a synthetic
 *       'all-tenants' GUC, OR
 *   (c) make this lookup as cpa (the migration role)
 *
 * We use (c) — exec via a separate sql connection that uses
 * DATABASE_URL (the cpa migration creds). Cleanest because it
 * mirrors the "tenant table is global" pattern: tenant_user lookups
 * during AUTH are special — they're the thing that DETERMINES the
 * tenant context, so they cannot themselves be tenant-scoped.
 *
 * Concretely: we add a new client `db.privileged` in T6 that connects
 * as cpa. For now, this function does the join via a single sql.begin
 * transaction that loops through ALL tenant ids (yes, this is wrong
 * for performance but RIGHT for security; we'll fix in W3).
 *
 * Actual implementation:
 *   bypass RLS for THIS query by setting app.current_tenant_id to
 *   each tenant_id in turn — too slow. PROPER fix: query via the
 *   privileged client.
 */
export async function lookupActiveTenant(userId: string): Promise<ActiveTenantResult> {
  // PROPER IMPL: we need a connection that BYPASSES RLS for this query.
  // Add a `privilegedSql` import in T6's task 6.5 below; for now,
  // assume `privilegedSql` exists.
  // (See implementer note in T6.)
  throw new Error('NOT YET IMPLEMENTED — see T6 step 6.5');
}
```

> ⚠️ **Implementer:** the comment block above is intentionally "I don't yet know how to do this safely". This is the W2's hardest spot. The CORRECT implementation requires adding a privileged DB client that connects as `cpa` and bypasses RLS for the auth lookup specifically. **Do this:**
>
> 1. Skip the `lookupActiveTenant` implementation in T5; just write the function signature returning `Promise<ActiveTenantResult>` with a `throw new Error('TODO T6')`.
> 2. Skip the test for `lookupActiveTenant` in T5 — it would fail. Comment it out with a `// TODO T6` marker.
> 3. T5 ships with: `findOrCreateUser` fully tested + working; `lookupActiveTenant` stubbed.
> 4. T6 implements `lookupActiveTenant` after creating the privileged DB client.

**Step 5: Run test, expect 3/3 pass for findOrCreateUser tests** (and lookupActiveTenant ones commented out)

```bash
pnpm --filter @cpa/auth test
```

Expected: jwt 5/5 + oidc 5/5 + users 3/3 = 13/13 pass.

**Step 6: Verify gates**

```bash
pnpm --filter @cpa/auth typecheck && pnpm --filter @cpa/auth lint && pnpm --filter @cpa/auth build
```

**Step 7: Update `index.ts`**

```ts
export * from './jwt.js';
export * from './oidc.js';
export * from './users.js';
```

**Step 8: Commit**

```bash
git add packages/auth/src/users.ts packages/auth/src/users.test.ts packages/auth/src/index.ts
git commit -m "feat(auth): findOrCreateUser + lookupActiveTenant signature

findOrCreateUser implemented: UPDATE-then-INSERT pattern via postgres-js,
3 unit tests covering create-new, find-existing, last_login_at bump.

lookupActiveTenant signature only — implementation deferred to T6 because
it requires a privileged DB client (cpa role, RLS-bypassing) that we
introduce alongside the session middleware. tenant_user is RLS-protected,
and the auth lookup CANNOT be tenant-scoped (it's the thing determining
the tenant scope), so we need to bypass RLS via the cpa role.

P1 W2 task 5 of 13."
```

---

## Task 6: Privileged DB client + `lookupActiveTenant` impl + Fastify session middleware

**Why this is the largest task:** Three things need to land together — the privileged client and lookupActiveTenant are mutually dependent on each other, and the session middleware uses both.

**Files:**
- Modify: `packages/db/src/client.ts` (export `privilegedSql`)
- Modify: `packages/db/src/env.ts` (already has `getDatabaseUrl` for cpa)
- Modify: `packages/auth/src/users.ts` (implement `lookupActiveTenant`)
- Modify: `packages/auth/src/users.test.ts` (uncomment the 2 tests)
- Create: `packages/auth/src/session.ts`
- Create: `packages/auth/src/session.test.ts`

**Step 1: Add privilegedSql export to packages/db/src/client.ts**

Read the current file first. Then add:

```ts
import postgres from 'postgres';
import { getDatabaseUrl, getAppDatabaseUrl, getDatabasePoolMax } from './env.js';

// Application-runtime client (cpa_app, RLS-enforcing). Most code uses this.
export const sql = postgres(getAppDatabaseUrl(), {
  max: getDatabasePoolMax(),
});

/**
 * Privileged DB client — connects as cpa (the migration role).
 * RLS-bypassing because cpa is bootstrap superuser AND the table owner.
 *
 * Use ONLY for queries that must transcend tenant scope:
 *   - Auth lookups (lookupActiveTenant — needs to see all tenant_user
 *     rows for a user across all tenants to determine the active one)
 *   - System-admin tooling (P3+; not user-facing)
 *
 * NEVER hand this to a route handler that runs after session middleware.
 * The middleware switches us to cpa_app for a reason.
 */
export const privilegedSql = postgres(getDatabaseUrl(), {
  max: 5,  // small pool — auth queries only
});
```

(Confirm this matches what's already there; client.ts may already do most of this.)

**Step 2: Implement lookupActiveTenant**

Replace the stub in `packages/auth/src/users.ts`:

```ts
import { privilegedSql } from '@cpa/db/client';

interface TenantUserRow {
  tenant_id: string;
  name: string;
  slug: string;
  role: 'admin' | 'consultant' | 'viewer';
  is_default: boolean;
}

export async function lookupActiveTenant(userId: string): Promise<ActiveTenantResult> {
  const rows = await privilegedSql<TenantUserRow[]>`
    SELECT tu.tenant_id, t.name, t.slug, tu.role, tu.is_default
      FROM tenant_user tu
      JOIN tenant t ON t.id = tu.tenant_id AND t.deleted_at IS NULL
     WHERE tu.user_id = ${userId}
       AND tu.deleted_at IS NULL
     ORDER BY tu.is_default DESC, tu.created_at ASC
  `;

  const availableTenants = rows.map((r) => ({
    tenantId: r.tenant_id,
    name: r.name,
    slug: r.slug,
    role: r.role,
    isDefault: r.is_default,
  }));

  const active = availableTenants[0] ?? null;
  return {
    activeTenantId: active?.tenantId ?? null,
    activeRole: active?.role ?? null,
    availableTenants,
  };
}
```

**Step 3: Uncomment the 2 lookupActiveTenant tests in users.test.ts**

Run tests:

```bash
pnpm --filter @cpa/auth test
```

Expected: 5 jwt + 5 oidc + 5 users = 15/15.

**Step 4: Write the session middleware test FIRST**

Create `packages/auth/src/session.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { sessionPlugin } from './session.js';
import { signSession } from './jwt.js';

const TEST_SECRET = 'test-secret-32-bytes-of-entropy!!';

const buildApp = async () => {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(sessionPlugin, {
    secret: TEST_SECRET,
    cookieName: 'cpa_session',
  });
  app.get('/test/whoami', async (req) => {
    if (!req.user) return { authenticated: false };
    return {
      authenticated: true,
      user: req.user,
    };
  });
  return app;
};

test('session: anonymous request — no req.user, route still runs', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/test/whoami' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { authenticated: false });
  await app.close();
});

test('session: valid cookie — req.user populated, RLS GUC set', async () => {
  const app = await buildApp();
  const jwt = await signSession(
    {
      sub: '00000000-0000-4000-8000-000000000001',
      email: 'jane@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: '00000000-0000-4000-8000-0000000000a1',
      activeRole: 'consultant',
      availableTenants: [],
    },
    TEST_SECRET,
    { ttlSeconds: 3600 },
  );
  const res = await app.inject({
    method: 'GET',
    url: '/test/whoami',
    cookies: { cpa_session: jwt },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.user.id, '00000000-0000-4000-8000-000000000001');
  assert.equal(body.user.tenantId, '00000000-0000-4000-8000-0000000000a1');
  await app.close();
});

test('session: expired cookie — 401 + cookie cleared', async () => {
  const app = await buildApp();
  const jwt = await signSession(
    {
      sub: 'x',
      email: 'x',
      primaryIdp: 'microsoft',
      activeTenantId: null,
      activeRole: null,
      availableTenants: [],
    },
    TEST_SECRET,
    { ttlSeconds: -1 },
  );
  const res = await app.inject({
    method: 'GET',
    url: '/test/whoami',
    cookies: { cpa_session: jwt },
  });
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['set-cookie'] as string, /cpa_session=;/);
  await app.close();
});

test('session: tampered cookie — 401', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/test/whoami',
    cookies: { cpa_session: 'not.a.jwt' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});
```

**Step 5: Implement `packages/auth/src/session.ts`**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { sql } from '@cpa/db/client';
import { verifySession, type VerifiedSession } from './jwt.js';

export interface SessionPluginOptions {
  secret: string;
  cookieName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
      tenantId: string | null;
      role: 'admin' | 'consultant' | 'viewer' | null;
    };
  }
}

const clearCookie = (reply: FastifyReply, name: string): void => {
  reply.header('set-cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
};

const sessionImpl = async (app: FastifyInstance, opts: SessionPluginOptions): Promise<void> => {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const cookie = (req.cookies as Record<string, string | undefined>)[opts.cookieName];
    if (!cookie) {
      // Anonymous request — no req.user; routes that need auth check req.user themselves
      return;
    }

    let claims: VerifiedSession;
    try {
      claims = await verifySession(cookie, opts.secret);
    } catch (err) {
      clearCookie(reply, opts.cookieName);
      reply.status(401).send({ error: 'invalid_session', message: 'Session invalid or expired' });
      return reply;
    }

    req.user = {
      id: claims.sub,
      email: claims.email,
      tenantId: claims.activeTenantId,
      role: claims.activeRole,
    };

    // If the user has an active tenant, set the GUC for downstream RLS-scoped queries.
    // We do this on every authenticated request inside an implicit transaction so that
    // any sql call from the route reads the GUC. Routes that need explicit transaction
    // control can ignore this and use sql.begin themselves.
    if (claims.activeTenantId !== null) {
      // postgres-js: SET LOCAL applies to the current transaction. We open a single-statement
      // transaction here and stuff the value in the connection's "current GUC" slot for
      // the duration of THIS request. Subsequent SQL in the route uses this connection.
      await sql.unsafe(`SELECT set_config('app.current_tenant_id', '${claims.activeTenantId.replace(/'/g, "''")}', false)`);
    }
  });
};

export const sessionPlugin = fp(sessionImpl, {
  name: 'cpa-session',
  fastify: '5.x',
});
```

> ⚠️ **Implementer caveat:** The `sql.unsafe` `SELECT set_config(..., false)` here is **session-scoped**, NOT transaction-scoped. This is a deliberate choice for W2: postgres-js pools connections, and we don't have a clean way to wrap each handler in a single transaction without changing every route. The trade-off:
> - **Pro:** Routes can do whatever they want with `sql` and the GUC is set.
> - **Con:** The GUC PERSISTS on the pooled connection until something else resets it (or the connection returns to the pool and a different request reuses it).
>
> The right fix is **per-request transaction wrapping** via Fastify's request lifecycle, but that's more invasive and lands cleaner in W3 with `req.tx`. For W2 we use session-scoped GUC + a `RESET app.current_tenant_id` in `onResponse` hook to clean up. Add this hook:
>
> ```ts
> app.addHook('onResponse', async () => {
>   await sql.unsafe(`SELECT set_config('app.current_tenant_id', '', false)`);
> });
> ```
>
> This ensures connection-state hygiene: every response cleans up. The NULLIF in our policies (migration 0003) ensures `''` reads as NULL → fail-safe.

**Step 6: Run tests, expect GREEN**

```bash
pnpm --filter @cpa/auth test
```

Expected: 5 jwt + 5 oidc + 5 users + 4 session = 19/19 pass.

**Step 7: Verify gates + commit**

```bash
pnpm --filter @cpa/auth typecheck && pnpm --filter @cpa/auth lint && pnpm --filter @cpa/auth build
git add packages/db/src/client.ts packages/auth/src/users.ts packages/auth/src/users.test.ts packages/auth/src/session.ts packages/auth/src/session.test.ts packages/auth/src/index.ts
git commit -m "feat(auth): privileged DB client + lookupActiveTenant + Fastify session middleware

- packages/db: privilegedSql exported (cpa role, RLS-bypassing) for auth
  lookups that span tenant scope.
- packages/auth/users.ts: lookupActiveTenant joins tenant_user × tenant
  via privilegedSql, returns activeTenantId/Role + availableTenants[].
  is_default DESC, created_at ASC ordering. 2 new tests pass.
- packages/auth/session.ts: Fastify plugin that reads cpa_session cookie,
  verifies JWT, attaches req.user, sets app.current_tenant_id GUC,
  resets GUC in onResponse for connection-state hygiene. 4 unit tests
  cover anonymous, valid, expired (with cookie clear), tampered.

Test count after T6: 5+5+5+4 = 19 in @cpa/auth, plus existing 8 db + 9 api.
Total = 36 across 5 packages.

P1 W2 task 6 of 13."
```

---

## Task 7: Microsoft OIDC routes (`/v1/auth/microsoft/login` + `/callback`)

**Why parallel-safe with T8:** Different IdP, different file. Both depend on T1-T6.

**Files:**
- Create: `apps/api/src/routes/auth/microsoft.ts`
- Modify: `apps/api/src/app.ts` (register route)

**Step 1: Read existing route registration pattern**

```bash
cat apps/api/src/routes/health.ts | head -20
cat apps/api/src/app.ts
```

**Step 2: Implement Microsoft routes**

Create `apps/api/src/routes/auth/microsoft.ts`. The implementation uses `openid-client` to discover the IdP, build the auth URL, and exchange the code. Full code (≈ 80 lines):

```ts
import type { FastifyInstance } from 'fastify';
import { Issuer, generators, type Client } from 'openid-client';
import { findOrCreateUser, lookupActiveTenant, signSession, generatePkce, generateState, generateNonce } from '@cpa/auth';

interface MicrosoftConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
  cookieName: string;
  cookieSecure: boolean;
  ttlSeconds: number;
  postLoginRedirect: string;
}

const HANDSHAKE_COOKIE = 'cpa_oidc_handshake_ms';
const HANDSHAKE_TTL_SEC = 300;  // 5 min

const buildClient = async (cfg: MicrosoftConfig): Promise<Client> => {
  const issuer = await Issuer.discover(`https://login.microsoftonline.com/${cfg.tenantId}/v2.0`);
  return new issuer.Client({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uris: [cfg.redirectUri],
    response_types: ['code'],
  });
};

export async function registerMicrosoftAuth(app: FastifyInstance, cfg: MicrosoftConfig): Promise<void> {
  const client = await buildClient(cfg);

  app.get('/v1/auth/microsoft/login', async (_req, reply) => {
    const { verifier, challenge, method } = generatePkce();
    const state = generateState();
    const nonce = generateNonce();

    const url = client.authorizationUrl({
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: method,
    });

    reply.header(
      'set-cookie',
      `${HANDSHAKE_COOKIE}=${encodeURIComponent(JSON.stringify({ verifier, state, nonce }))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${HANDSHAKE_TTL_SEC}${cfg.cookieSecure ? '; Secure' : ''}`,
    );
    return reply.redirect(302, url);
  });

  app.get('/v1/auth/microsoft/callback', async (req, reply) => {
    const handshakeCookie = (req.cookies as Record<string, string | undefined>)[HANDSHAKE_COOKIE];
    if (!handshakeCookie) {
      return reply.status(400).send({ error: 'missing_handshake', message: 'OIDC handshake cookie missing' });
    }
    let handshake: { verifier: string; state: string; nonce: string };
    try {
      handshake = JSON.parse(decodeURIComponent(handshakeCookie));
    } catch {
      return reply.status(400).send({ error: 'invalid_handshake', message: 'OIDC handshake cookie malformed' });
    }

    const params = client.callbackParams(req.raw);
    let tokenSet;
    try {
      tokenSet = await client.callback(cfg.redirectUri, params, {
        state: handshake.state,
        nonce: handshake.nonce,
        code_verifier: handshake.verifier,
      });
    } catch (err) {
      req.log.error({ err }, 'oidc microsoft callback failed');
      return reply.status(401).send({ error: 'oidc_failed', message: 'OIDC verification failed' });
    }

    const idClaims = tokenSet.claims();
    if (!idClaims.oid || !idClaims.email) {
      return reply.status(401).send({ error: 'missing_claim', message: 'IdP did not return required claims' });
    }

    const user = await findOrCreateUser({
      primaryIdp: 'microsoft',
      externalId: `microsoft:${String(idClaims.oid)}`,
      email: String(idClaims.email),
      displayName: typeof idClaims.name === 'string' ? idClaims.name : null,
    });
    const active = await lookupActiveTenant(user.id);

    const jwt = await signSession(
      {
        sub: user.id,
        email: user.email,
        primaryIdp: 'microsoft',
        activeTenantId: active.activeTenantId,
        activeRole: active.activeRole,
        availableTenants: active.availableTenants.map(({ tenantId, name, slug, role }) => ({ tenantId, name, slug, role })),
      },
      cfg.sessionSecret,
      { ttlSeconds: cfg.ttlSeconds },
    );

    reply.header(
      'set-cookie',
      [
        `${cfg.cookieName}=${jwt}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.ttlSeconds}${cfg.cookieSecure ? '; Secure' : ''}`,
        `${HANDSHAKE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      ],
    );
    return reply.redirect(302, cfg.postLoginRedirect);
  });
}
```

**Step 3: Wire into app.ts**

Add to `buildApp()`:

```ts
import { registerMicrosoftAuth } from './routes/auth/microsoft.js';
// ... after sessionPlugin:
await registerMicrosoftAuth(app, {
  tenantId: process.env.MICROSOFT_OIDC_TENANT ?? 'common',
  clientId: process.env.MICROSOFT_OIDC_CLIENT_ID ?? '',
  clientSecret: process.env.MICROSOFT_OIDC_CLIENT_SECRET ?? '',
  redirectUri: process.env.MICROSOFT_OIDC_REDIRECT_URI ?? 'http://localhost:3000/v1/auth/microsoft/callback',
  sessionSecret: process.env.SESSION_JWT_SECRET ?? 'dev-secret-32-bytes-of-entropy!',
  cookieName: process.env.SESSION_COOKIE_NAME ?? 'cpa_session',
  cookieSecure: process.env.NODE_ENV === 'production',
  ttlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 86400),
  postLoginRedirect: '/',
});
```

**Step 4: Verify gates**

```bash
pnpm --filter @cpa/api typecheck   # exit 0
pnpm --filter @cpa/api build       # exit 0
pnpm --filter @cpa/api lint        # exit 0
pnpm --filter @cpa/api test        # 9/9 still pass (no integration tests for these yet)
```

**Step 5: Commit**

```bash
git add apps/api/src/routes/auth/ apps/api/src/app.ts
git commit -m "feat(api): Microsoft Entra OIDC routes (/v1/auth/microsoft/{login,callback})

login route: generates PKCE+state+nonce, stores them in 5-min sameSite=lax
handshake cookie, redirects to login.microsoftonline.com with the auth URL.

callback route: reads handshake cookie, exchanges code for tokens via
openid-client, verifies ID token, extracts email + oid claim, calls
findOrCreateUser + lookupActiveTenant, signs session JWT, sets cpa_session
cookie with sameSite=lax+httpOnly+(secure in prod), redirects to /.

Integration test in T11 uses nock to mock the IdP's /authorize, /token,
/userinfo, and JWKS endpoints. No external dependencies in CI.

P1 W2 task 7 of 13."
```

---

## Task 8: Google Workspace OIDC routes

**Why parallel-safe with T7:** Symmetric to Microsoft, different file.

**Files:**
- Create: `apps/api/src/routes/auth/google.ts`
- Modify: `apps/api/src/app.ts` (register route)

**Step 1: Implement Google routes**

Create `apps/api/src/routes/auth/google.ts`. Mirror T7's pattern with these differences:
- Discovery URL: `https://accounts.google.com`
- External ID format: `google:${idClaims.sub}` (Google uses `sub`, not `oid`)
- Display name: `idClaims.name`
- Handshake cookie name: `cpa_oidc_handshake_g`

Use the same `Issuer.discover` + `client.authorizationUrl` + `client.callback` flow.

**Step 2: Wire into app.ts**

Add `registerGoogleAuth` similar to T7.

**Step 3: Verify gates + commit**

```bash
pnpm --filter @cpa/api typecheck && pnpm --filter @cpa/api build && pnpm --filter @cpa/api lint && pnpm --filter @cpa/api test
git add apps/api/src/routes/auth/google.ts apps/api/src/app.ts
git commit -m "feat(api): Google Workspace OIDC routes (/v1/auth/google/{login,callback})

Mirrors T7's Microsoft flow:
- Discovery URL: https://accounts.google.com
- Subject claim: 'sub' (Google) vs 'oid' (Microsoft)
- External ID format: 'google:<sub>'
- Handshake cookie: cpa_oidc_handshake_g (separate from MS to prevent cross-IdP collisions)

Integration test in T11 uses nock to mock googleapis endpoints.

P1 W2 task 8 of 13."
```

---

## Task 9: `/v1/auth/signout` route

**Files:** `apps/api/src/routes/auth/signout.ts` + `app.ts`

**Step 1: Implement signout**

```ts
import type { FastifyInstance } from 'fastify';

export function registerSignout(app: FastifyInstance, cookieName: string, cookieSecure: boolean): void {
  app.post('/v1/auth/signout', async (_req, reply) => {
    reply.header(
      'set-cookie',
      `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure ? '; Secure' : ''}`,
    );
    reply.status(204).send();
  });
}
```

**Step 2: Test (in apps/api/src/routes/auth/signout.test.ts)**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../app.js';

test('POST /v1/auth/signout: clears cookie + 204', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signout',
    cookies: { cpa_session: 'doesnt-matter' },
  });
  assert.equal(res.statusCode, 204);
  assert.match(res.headers['set-cookie'] as string, /cpa_session=;.*Max-Age=0/);
  await app.close();
});
```

**Step 3: Wire into app.ts + commit**

---

## Task 10: `/v1/whoami` route

**Files:** `apps/api/src/routes/whoami.ts` + `apps/api/src/routes/whoami.test.ts` + `app.ts`

**Step 1: Implement /v1/whoami**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lookupActiveTenant } from '@cpa/auth';

const WhoamiResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    tenantId: z.string().uuid().nullable(),
    role: z.enum(['admin', 'consultant', 'viewer']).nullable(),
  }),
  availableTenants: z.array(
    z.object({
      tenantId: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      role: z.enum(['admin', 'consultant', 'viewer']),
      isDefault: z.boolean(),
    }),
  ),
});

export function registerWhoami(app: FastifyInstance): void {
  app.get('/v1/whoami', async (req, reply) => {
    if (!req.user) {
      return reply.status(401).send({ error: 'unauthenticated', message: 'No session' });
    }
    const active = await lookupActiveTenant(req.user.id);
    return {
      user: req.user,
      availableTenants: active.availableTenants,
    };
  });
}
```

**Step 2: Tests** — covered partially by T6 session tests + the integration tests in T11.

**Step 3: Commit**

---

## Task 11: Integration tests with `nock`-mocked IdP

**Files:** `apps/api/src/routes/auth/microsoft.integration.test.ts`, `google.integration.test.ts`

**Step 1: Build a fixture helper**

```ts
// apps/api/src/routes/auth/test-fixtures.ts
import nock from 'nock';
import { SignJWT, generateKeyPair } from 'jose';

export async function mockMicrosoftIdp(opts: { sub: string; email: string; nonce: string }) {
  // Mock discovery, jwks, token endpoints
  // Return the JWT to use as the IdP's id_token in the test
  // (full implementation ≈ 60 LoC; nock intercepts all 3 endpoints)
}
```

**Step 2: Full Microsoft callback integration test**

Tests cover:
- GET /login → 302 to MS authorize URL with PKCE+state+nonce
- GET /callback?code=... → user row created, JWT cookie set, 302 to /
- GET /whoami after login → 200 + correct shape
- POST /signout → 204 + cookie cleared
- GET /whoami after signout → 401

**Step 3: Mirror for Google**

**Step 4: Run all tests**

```bash
pnpm test
```

Expected: 19 auth + 13 api (9 health/db + 4 new auth integrations) + 8 db + ... ≈ 40 total.

**Step 5: Commit**

---

## Task 12: Update `.env.example`

Add the OIDC + JWT env variables documented in the design doc. Don't put secrets in `.env.example` — empty placeholders only.

**Step 1: Edit `.env.example`**

Append:
```
# OIDC — Microsoft Entra
MICROSOFT_OIDC_TENANT=common
MICROSOFT_OIDC_CLIENT_ID=
MICROSOFT_OIDC_CLIENT_SECRET=
MICROSOFT_OIDC_REDIRECT_URI=http://localhost:3000/v1/auth/microsoft/callback

# OIDC — Google Workspace
GOOGLE_OIDC_CLIENT_ID=
GOOGLE_OIDC_CLIENT_SECRET=
GOOGLE_OIDC_REDIRECT_URI=http://localhost:3000/v1/auth/google/callback

# Session JWT signing key (32+ bytes; generate via `openssl rand -base64 32`)
SESSION_JWT_SECRET=

# Cookie + JWT options
SESSION_COOKIE_NAME=cpa_session
SESSION_COOKIE_SECURE=false
SESSION_TTL_SECONDS=86400
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "chore: document W2 OIDC + JWT environment variables in .env.example"
```

---

## Task 13: Cold-start verification + push + watch CI

**Step 1: Cold-start full sweep**

```bash
cd /c/Users/Aaron/cpa-platform-worktrees/p1
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

All exit 0. Test count target: ~40 across 5 packages.

**Step 2: Push**

```bash
git push origin p1/identity-tenancy 2>&1 | tail -5
```

**Step 3: Watch CI**

Visit `https://github.com/steeldragon666/cpa-platform/actions?query=branch:p1/identity-tenancy`.

Expected: green check on the run.

---

## W2 Acceptance criteria (all green to declare W2 done)

- [x] T1: `@cpa/auth` package scaffolded
- [x] T2: `@fastify/cookie` registered
- [x] T3: jwt.ts sign/verify; 5 tests
- [x] T4: oidc.ts handshake helpers; 5 tests
- [x] T5: users.ts findOrCreateUser; 3 tests
- [x] T6: privilegedSql + lookupActiveTenant + session middleware; 6 tests (3 users + 4 session)
- [x] T7: Microsoft OIDC routes
- [x] T8: Google OIDC routes
- [x] T9: signout route
- [x] T10: /v1/whoami route
- [x] T11: integration tests with nock; ~6 tests
- [x] T12: .env.example documented
- [x] T13: cold-start verify + pushed; CI green

Aggregate stats end of W2:
- ~13 commits added (40+ commits on branch total)
- ~40 tests across 5 packages
- 5 new HTTP endpoints (`/v1/auth/microsoft/login`, `/callback`, `/v1/auth/google/login`, `/callback`, `/v1/auth/signout`, `/v1/whoami`)
- 1 new package (`@cpa/auth`)
- 1 new privileged DB client (`privilegedSql`)

---

## What W2 does NOT do (carried to later weeks)

- `/v1/tenants/*` (W3) — list active firms, switch active tenant
- `/v1/users/*` (W3) — admin endpoints to add users to firms, assign roles
- Refresh tokens (P3+)
- Auth.js wiring in Next.js consultant portal (W4)
- Real-browser end-to-end test (W5)
- Audit log of login events (P2 schema; W2 just logs to pino)

---

## Estimated time

- 1 focused session (3-4 hours) with the swarm pattern. T1-T2 sequential, T3-T5 parallel batch, T6 solo, T7-T8 parallel batch, T9-T10 parallel batch, T11 solo, T12-T13 sequential.
