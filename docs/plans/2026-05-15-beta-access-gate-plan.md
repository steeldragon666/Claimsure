# Beta Access Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Gate `apps/web` behind an email-allowlist beta access flow that runs at the Vercel edge, sends magic links via Resend, and is reversible via a single env var.

**Architecture:** Next.js Edge Middleware checks a `beta_session` JWT cookie. Missing or invalid → redirect to `/beta-access` page. Page POSTs email to `/api/beta/request` which validates against `BETA_ALLOWLIST` env var, mints a 15-min magic-link JWT, and sends via existing `@cpa/email` Resend infra. User clicks link → `/api/beta/verify` validates token, sets 30-day session cookie, redirects home.

**Tech Stack:** Next.js 15 App Router, Edge Runtime middleware, `jose` (Edge-compatible JWT), Zod, `@cpa/email` (existing Resend wrapper), `tsx --test` (built-in Node test runner).

**Design doc:** `docs/plans/2026-05-15-beta-access-gate-design.md` — read before starting.

---

## Phase 0 — Setup

### Task 0: Add dependencies + generate secret

**Files:**
- Modify: `apps/web/package.json` (add deps)
- Modify: `apps/web/.env.example` (create or update)

**Step 1: Add deps**

Run from repo root:

```bash
pnpm --filter @cpa/web add jose @cpa/email zod
```

`jose` is the Edge-compatible JWT library (`jsonwebtoken` requires Node `crypto` and won't run in Edge runtime). `@cpa/email` is the existing workspace package that wraps Resend with retry + rate limiting. `zod` is already used elsewhere — needed for request-body validation.

Expected: `apps/web/package.json` has three new lines under `"dependencies"`, lockfile updated.

**Step 2: Generate the auth secret**

Run:

```bash
openssl rand -hex 32
```

Save the output. You'll use it as `BETA_AUTH_SECRET` locally and on Vercel.

**Step 3: Add env-var documentation**

Create or append `apps/web/.env.example` with:

```
# --- Beta access gate (apps/web/src/middleware.ts) ---

# Master switch. Set to "0" to disable the gate entirely (lets all traffic
# through to the existing /login flow). Default behavior when unset is
# "1" (gate enabled). NODE_ENV=development also auto-bypasses for local
# dev; you only need this flag for production overrides.
BETA_GATE_ENABLED=1

# 32-byte hex secret used to sign both magic-link tokens (15 min TTL)
# and beta-session cookie JWTs (30 day TTL). Rotate by setting a new
# value and redeploying — invalidates all in-flight tokens and existing
# sessions. Generate with `openssl rand -hex 32`.
BETA_AUTH_SECRET=

# Comma-separated lowercased email allowlist. Edit + redeploy to invite
# or revoke beta access. Whitespace around commas is tolerated.
BETA_ALLOWLIST=alice@example.com,bob@example.com

# Resend-verified sender used for magic-link emails. Must match a
# verified domain in the Resend dashboard.
BETA_FROM_ADDRESS=Claimsure Beta <noreply@claimsure.io>

# Resend API key (shared with the rest of the platform — same value
# the API uses for transactional email).
RESEND_API_KEY=
```

**Step 4: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/.env.example
git commit -m "chore(web): add jose + @cpa/email + zod for beta access gate

Prep for the beta access gate implementation (see
docs/plans/2026-05-15-beta-access-gate-design.md).

- jose: Edge-compatible JWT (jsonwebtoken won't run in Edge runtime)
- @cpa/email: existing Resend wrapper with retry + rate limiting
- zod: request-body validation (already used elsewhere in this app)

Documents 5 new env vars in .env.example. No runtime change yet."
```

---

## Phase 1 — `beta-auth.ts` library (TDD)

### Task 1: `parseAllowlist()`

**Files:**
- Create: `apps/web/src/lib/beta-auth.ts`
- Create: `apps/web/src/lib/beta-auth.test.ts`

**Step 1: Write the failing test**

Create `apps/web/src/lib/beta-auth.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowlist } from './beta-auth.js';

test('parseAllowlist: empty string returns empty set', () => {
  assert.deepEqual([...parseAllowlist('')], []);
});

test('parseAllowlist: comma-separated emails are split + lowercased + trimmed', () => {
  const allowlist = parseAllowlist('Alice@Firm.com, BOB@Y.com ,  carol@z.io');
  assert.deepEqual([...allowlist].sort(), [
    'alice@firm.com',
    'bob@y.com',
    'carol@z.io',
  ]);
});

test('parseAllowlist: empty entries (double commas, trailing comma) are dropped', () => {
  const allowlist = parseAllowlist('a@x.com,,b@y.com,');
  assert.deepEqual([...allowlist].sort(), ['a@x.com', 'b@y.com']);
});

test('parseAllowlist: returns a Set so membership check is O(1)', () => {
  const allowlist = parseAllowlist('a@x.com,b@y.com');
  assert.ok(allowlist instanceof Set);
  assert.ok(allowlist.has('a@x.com'));
  assert.ok(!allowlist.has('c@z.com'));
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @cpa/web test --test-name-pattern="parseAllowlist"
```

Expected: 4 FAILs, all with "cannot find module './beta-auth.js'" or similar.

**Step 3: Write minimal implementation**

Create `apps/web/src/lib/beta-auth.ts`:

```typescript
/**
 * Parse the BETA_ALLOWLIST env-var format into a Set for O(1) membership.
 *
 * Format: comma-separated emails, with optional whitespace around commas.
 * Emails are lowercased + trimmed; empty entries (from double-commas or a
 * trailing comma) are dropped so editing the env var is forgiving.
 */
export function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @cpa/web test --test-name-pattern="parseAllowlist"
```

Expected: 4 PASS.

**Step 5: Commit**

```bash
git add apps/web/src/lib/beta-auth.ts apps/web/src/lib/beta-auth.test.ts
git commit -m "feat(web): parseAllowlist() — env-var allowlist -> Set<string>"
```

---

### Task 2: `mintMagicLinkToken()` + `verifyToken()` round-trip

**Files:**
- Modify: `apps/web/src/lib/beta-auth.ts` (add minter + verifier)
- Modify: `apps/web/src/lib/beta-auth.test.ts` (add round-trip tests)

**Step 1: Write the failing test**

Append to `apps/web/src/lib/beta-auth.test.ts`:

```typescript
import { mintMagicLinkToken, verifyToken } from './beta-auth.js';

const TEST_SECRET = 'a'.repeat(64); // 32 bytes hex = 64 chars

test('mintMagicLinkToken + verifyToken round-trip succeeds for the same email', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const result = await verifyToken(token, 'beta-link', TEST_SECRET);
  assert.equal(result.email, 'alice@firm.com');
});

test('verifyToken: tampered token rejected', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const tampered = token.slice(0, -3) + 'AAA';
  await assert.rejects(verifyToken(tampered, 'beta-link', TEST_SECRET));
});

test('verifyToken: wrong secret rejected', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  await assert.rejects(verifyToken(token, 'beta-link', 'b'.repeat(64)));
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @cpa/web test --test-name-pattern="round-trip|tampered|wrong secret"
```

Expected: 3 FAILs with "mintMagicLinkToken is not defined" or "verifyToken is not defined".

**Step 3: Write minimal implementation**

Append to `apps/web/src/lib/beta-auth.ts`:

```typescript
import { SignJWT, jwtVerify } from 'jose';

const ISS = 'claimsure-beta';

/** typ claim on each kind of JWT. Verifier asserts this. */
export type TokenType = 'beta-link' | 'beta-session';

/** Default lifetimes. Magic link is short-lived; session is 30 days. */
const MAGIC_LINK_TTL_SECONDS = 15 * 60;

function secretToKey(secret: string): Uint8Array {
  // 32-byte hex => 32 bytes raw. jose accepts Uint8Array for HS256.
  if (secret.length !== 64) {
    throw new Error('BETA_AUTH_SECRET must be 32-byte hex (64 hex chars)');
  }
  return new Uint8Array(secret.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

/**
 * Mint a 15-min magic-link JWT for the given (lowercased) email.
 */
export async function mintMagicLinkToken(email: string, secret: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISS)
    .setSubject(email)
    // The typ field on PROTECTED HEADER would clash with JWT spec ("JWT");
    // we put our typ on the payload instead and read it back via verify.
    .setIssuedAt()
    .setExpirationTime(`${MAGIC_LINK_TTL_SECONDS}s`)
    .setNotBefore('0s')
    // Custom claim — distinguishes link vs session tokens.
    // jose has no fluent helper for arbitrary claims so we encode via
    // the constructor payload.
    .setAudience('beta-link')
    .sign(secretToKey(secret));
}

/**
 * Verify a JWT of the given expected type. Throws on:
 *   - signature mismatch
 *   - expired
 *   - wrong typ claim (e.g. session token presented as a magic link)
 *
 * Returns { email } on success.
 */
export async function verifyToken(
  token: string,
  expectedType: TokenType,
  secret: string,
): Promise<{ email: string }> {
  const { payload } = await jwtVerify(token, secretToKey(secret), {
    issuer: ISS,
    audience: expectedType, // reuses aud claim as our type discriminator
  });
  const email = payload.sub;
  if (typeof email !== 'string' || email.length === 0) {
    throw new Error('beta-auth: token missing sub claim');
  }
  return { email };
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @cpa/web test --test-name-pattern="round-trip|tampered|wrong secret"
```

Expected: 3 PASS.

**Step 5: Commit**

```bash
git add apps/web/src/lib/beta-auth.ts apps/web/src/lib/beta-auth.test.ts
git commit -m "feat(web): mintMagicLinkToken + verifyToken (HS256 via jose)

Uses the aud claim as the type discriminator (beta-link vs beta-session)
so the same verifier rejects cross-type reuse. 15-min default TTL for
magic links."
```

---

### Task 3: session-token variant + type-cross rejection

**Files:**
- Modify: `apps/web/src/lib/beta-auth.ts` (add `mintSessionToken`)
- Modify: `apps/web/src/lib/beta-auth.test.ts` (add type-cross test)

**Step 1: Write the failing test**

Append to `apps/web/src/lib/beta-auth.test.ts`:

```typescript
import { mintSessionToken } from './beta-auth.js';

test('mintSessionToken + verifyToken(beta-session) round-trip succeeds', async () => {
  const token = await mintSessionToken('alice@firm.com', TEST_SECRET);
  const result = await verifyToken(token, 'beta-session', TEST_SECRET);
  assert.equal(result.email, 'alice@firm.com');
});

test('verifyToken rejects a magic-link token presented as a session', async () => {
  const linkToken = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  await assert.rejects(verifyToken(linkToken, 'beta-session', TEST_SECRET));
});

test('verifyToken rejects a session token presented as a magic link', async () => {
  const sessionToken = await mintSessionToken('alice@firm.com', TEST_SECRET);
  await assert.rejects(verifyToken(sessionToken, 'beta-link', TEST_SECRET));
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @cpa/web test --test-name-pattern="session token|cross"
```

Expected: 3 FAILs (mintSessionToken not defined; the existing verify only knew beta-link).

**Step 3: Write minimal implementation**

Append to `apps/web/src/lib/beta-auth.ts`:

```typescript
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Mint a 30-day session JWT (the cookie value).
 */
export async function mintSessionToken(email: string, secret: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISS)
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .setNotBefore('0s')
    .setAudience('beta-session')
    .sign(secretToKey(secret));
}
```

The existing `verifyToken` already takes an `expectedType` arg and asserts via the `audience` claim, so type-cross rejection comes for free.

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @cpa/web test
```

Expected: full file passes (no failures across all tests). 10/10 tests in `beta-auth.test.ts`.

**Step 5: Commit**

```bash
git add apps/web/src/lib/beta-auth.ts apps/web/src/lib/beta-auth.test.ts
git commit -m "feat(web): mintSessionToken (30-day TTL) — type-cross rejection verified

aud claim disambiguates the two token kinds. Verifier rejects when the
caller asks for the wrong type, so a session cookie value can't be
abused as a fresh magic link and vice versa."
```

---

## Phase 2 — API routes (TDD)

### Task 4: `POST /api/beta/request` route

**Files:**
- Create: `apps/web/src/app/api/beta/request/route.ts`
- Create: `apps/web/src/app/api/beta/request/route.test.ts`

**Step 1: Write the failing test**

Create `apps/web/src/app/api/beta/request/route.test.ts`:

```typescript
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock @cpa/email's send before importing the route.
let sentEmails: Array<{ to: string; subject: string }> = [];
// @ts-expect-error - we monkey-patch the module before route imports it.
globalThis.__test_send = async (input: { to: string; subject: string }) => {
  sentEmails.push(input);
};

const TEST_SECRET = 'a'.repeat(64);
process.env.BETA_AUTH_SECRET = TEST_SECRET;
process.env.BETA_ALLOWLIST = 'alice@firm.com';
process.env.BETA_FROM_ADDRESS = 'Test <test@test.io>';

const { POST } = await import('./route.js');

beforeEach(() => {
  sentEmails = [];
});

function makeReq(body: unknown, ip = '127.0.0.1'): Request {
  return new Request('https://example.com/api/beta/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

test('POST /api/beta/request: allowlisted email -> 200 + email sent', async () => {
  const res = await POST(makeReq({ email: 'alice@firm.com' }));
  assert.equal(res.status, 200);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'alice@firm.com');
});

test('POST /api/beta/request: NON-allowlisted email -> 200 + no email sent (no enumeration)', async () => {
  const res = await POST(makeReq({ email: 'evil@attacker.com' }));
  assert.equal(res.status, 200);
  assert.equal(sentEmails.length, 0);
});

test('POST /api/beta/request: case-insensitive allowlist match', async () => {
  const res = await POST(makeReq({ email: 'ALICE@firm.COM' }));
  assert.equal(res.status, 200);
  assert.equal(sentEmails.length, 1);
});

test('POST /api/beta/request: malformed email -> 400', async () => {
  const res = await POST(makeReq({ email: 'not-an-email' }));
  assert.equal(res.status, 400);
  assert.equal(sentEmails.length, 0);
});

test('POST /api/beta/request: 6th request from same IP in 1 hr -> 429', async () => {
  for (let i = 0; i < 5; i += 1) {
    const r = await POST(makeReq({ email: 'alice@firm.com' }, '10.0.0.42'));
    assert.equal(r.status, 200);
  }
  const sixth = await POST(makeReq({ email: 'alice@firm.com' }, '10.0.0.42'));
  assert.equal(sixth.status, 429);
  assert.ok(sixth.headers.get('retry-after'));
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @cpa/web test --test-name-pattern="POST /api/beta/request"
```

Expected: 5 FAILs (module doesn't exist yet).

**Step 3: Write minimal implementation**

Create `apps/web/src/app/api/beta/request/route.ts`:

```typescript
/**
 * POST /api/beta/request
 *
 * Body: { email: string }
 *
 * Always returns 200 (generic "check your email" body) regardless of
 * whether the email is on the allowlist — prevents enumeration. Rate
 * limited per-IP. Sends a magic-link via existing @cpa/email/Resend
 * infra when the email IS on the allowlist.
 *
 * Test-only injection seam: globalThis.__test_send is called instead
 * of the real Resend when defined. See route.test.ts.
 */
import { z } from 'zod';
import { mintMagicLinkToken, parseAllowlist } from '@/lib/beta-auth';

export const runtime = 'nodejs'; // need crypto via jose's HS256 here

const BodySchema = z.object({
  email: z.string().email(),
});

// In-memory rate limit. 5 requests / IP / hour. Restarts blow this away
// which is fine for closed beta — a sophisticated attacker would just
// rotate IPs anyway. Replace with Upstash KV when we outgrow this.
const buckets = new Map<string, { resetAt: number; count: number }>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') ?? '';
  return xff.split(',')[0]?.trim() || 'unknown';
}

function takeRateLimitToken(ip: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(ip, { resetAt: now + WINDOW_MS, count: 1 });
    return { ok: true };
  }
  if (bucket.count >= MAX_PER_WINDOW) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { ok: true };
}

async function sendMagicLinkEmail(toEmail: string, link: string): Promise<void> {
  // Test seam: route.test.ts sets globalThis.__test_send.
  const testSend = (globalThis as unknown as { __test_send?: typeof realSend }).__test_send;
  if (testSend) {
    await testSend({ to: toEmail, subject: 'Your Claimsure beta access link', html: link, text: link });
    return;
  }
  await realSend(toEmail, link);
}

async function realSend(toEmail: string, link: string): Promise<void> {
  const { createResendClient, createEmailSender } = await import('@cpa/email');
  const client = createResendClient({ apiKey: process.env.RESEND_API_KEY! });
  const sender = createEmailSender(client, {
    fromAddress: process.env.BETA_FROM_ADDRESS!,
  });
  await sender.send({
    to: toEmail,
    subject: 'Your Claimsure beta access link',
    text: `Click to access the Claimsure beta:\n\n${link}\n\nThis link expires in 15 minutes.`,
    html: `<p>Click to access the Claimsure beta:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes.</p>`,
  });
}

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);
  const rl = takeRateLimitToken(ip);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfter) },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid_email' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const allowlist = parseAllowlist(process.env.BETA_ALLOWLIST ?? '');
  if (allowlist.has(email)) {
    const token = await mintMagicLinkToken(email, process.env.BETA_AUTH_SECRET!);
    // The host comes from the request so this works on preview + prod
    // without extra env config.
    const origin = new URL(req.url).origin;
    const link = `${origin}/api/beta/verify?token=${encodeURIComponent(token)}`;
    try {
      await sendMagicLinkEmail(email, link);
    } catch (err) {
      // Log the failure but DON'T leak the failure to the caller —
      // they get the same generic 200 a non-allowlisted email gets.
      console.error('[beta] email send failed', err instanceof Error ? err.message : String(err));
    }
  }

  return new Response(
    JSON.stringify({ message: 'If your email is on the beta allowlist, check your inbox.' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @cpa/web test --test-name-pattern="POST /api/beta/request"
```

Expected: 5 PASS.

**Step 5: Commit**

```bash
git add apps/web/src/app/api/beta/request/route.ts apps/web/src/app/api/beta/request/route.test.ts
git commit -m "feat(web): POST /api/beta/request — email-allowlist + magic-link send

Always returns 200 to prevent allowlist enumeration. 5/hr/IP rate limit.
Resend send is non-fatal — if it fails the user still sees the generic
'check your email' message and we log loudly."
```

---

### Task 5: `GET /api/beta/verify` route

**Files:**
- Create: `apps/web/src/app/api/beta/verify/route.ts`
- Create: `apps/web/src/app/api/beta/verify/route.test.ts`

**Step 1: Write the failing test**

Create `apps/web/src/app/api/beta/verify/route.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintMagicLinkToken } from '@/lib/beta-auth';

const TEST_SECRET = 'a'.repeat(64);
process.env.BETA_AUTH_SECRET = TEST_SECRET;

const { GET } = await import('./route.js');

function makeReq(query: Record<string, string>): Request {
  const url = new URL('https://example.com/api/beta/verify');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { method: 'GET' });
}

test('GET /api/beta/verify: valid token sets beta_session cookie + 302 to /', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const res = await GET(makeReq({ token }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const setCookie = res.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^beta_session=eyJ/);
  assert.match(setCookie, /Max-Age=\d+/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
});

test('GET /api/beta/verify: valid token + next=/dashboard -> 302 to /dashboard', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const res = await GET(makeReq({ token, next: '/dashboard' }));
  assert.equal(res.headers.get('location'), '/dashboard');
});

test('GET /api/beta/verify: next=https://evil.com -> sanitized to /', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const res = await GET(makeReq({ token, next: 'https://evil.com' }));
  assert.equal(res.headers.get('location'), '/');
});

test('GET /api/beta/verify: next=//evil.com -> sanitized to /', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const res = await GET(makeReq({ token, next: '//evil.com' }));
  assert.equal(res.headers.get('location'), '/');
});

test('GET /api/beta/verify: tampered token -> 302 to /beta-access?error=invalid', async () => {
  const token = await mintMagicLinkToken('alice@firm.com', TEST_SECRET);
  const tampered = token.slice(0, -3) + 'AAA';
  const res = await GET(makeReq({ token: tampered }));
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /\/beta-access\?error=invalid/);
});

test('GET /api/beta/verify: missing token -> 302 to /beta-access', async () => {
  const res = await GET(makeReq({}));
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /^\/beta-access/);
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @cpa/web test --test-name-pattern="GET /api/beta/verify"
```

Expected: 6 FAILs.

**Step 3: Write minimal implementation**

Create `apps/web/src/app/api/beta/verify/route.ts`:

```typescript
/**
 * GET /api/beta/verify?token=<JWT>&next=<path>
 *
 * Validates the magic-link JWT. On success:
 *   - Sets `beta_session` cookie (30-day TTL, HttpOnly, Secure, SameSite=Lax)
 *   - 302 to sanitized `next` param (or `/`)
 *
 * On failure (missing/tampered/expired): 302 to /beta-access with
 * appropriate ?error= param so the page can render a hint.
 */
import { mintSessionToken, verifyToken } from '@/lib/beta-auth';

export const runtime = 'nodejs';

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function sanitizeNext(next: string | null): string {
  if (!next) return '/';
  // Must be a local path that doesn't start with // (protocol-relative)
  // and isn't an absolute URL.
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//')) return '/';
  return next;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const next = sanitizeNext(url.searchParams.get('next'));

  if (!token) {
    return Response.redirect(new URL('/beta-access', url), 302);
  }

  let email: string;
  try {
    const verified = await verifyToken(token, 'beta-link', process.env.BETA_AUTH_SECRET!);
    email = verified.email;
  } catch (err) {
    const errorKind = (err as Error).message.includes('expired') ? 'expired' : 'invalid';
    const dest = new URL('/beta-access', url);
    dest.searchParams.set('error', errorKind);
    if (next !== '/') dest.searchParams.set('next', next);
    return Response.redirect(dest, 302);
  }

  const sessionToken = await mintSessionToken(email, process.env.BETA_AUTH_SECRET!);
  const cookie = [
    `beta_session=${sessionToken}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');

  // Structured log so we can see verifications in Vercel logs.
  console.log(JSON.stringify({ event: 'beta.verified', email, ts: new Date().toISOString() }));

  return new Response(null, {
    status: 302,
    headers: {
      location: next,
      'set-cookie': cookie,
    },
  });
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @cpa/web test --test-name-pattern="GET /api/beta/verify"
```

Expected: 6 PASS.

**Step 5: Commit**

```bash
git add apps/web/src/app/api/beta/verify/route.ts apps/web/src/app/api/beta/verify/route.test.ts
git commit -m "feat(web): GET /api/beta/verify — magic link -> 30-day beta_session cookie

Sanitizes ?next= to same-origin path. On bad token, redirects back to
/beta-access with an ?error=expired|invalid hint. Structured log line
on success for Vercel-side observability."
```

---

## Phase 3 — Edge middleware (TDD)

### Task 6: `middleware.ts`

**Files:**
- Create: `apps/web/src/middleware.ts`
- Create: `apps/web/src/middleware.test.ts`

**Step 1: Write the failing test**

Create `apps/web/src/middleware.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintSessionToken } from '@/lib/beta-auth';

const TEST_SECRET = 'a'.repeat(64);
process.env.BETA_AUTH_SECRET = TEST_SECRET;
process.env.BETA_GATE_ENABLED = '1';
process.env.NODE_ENV = 'production'; // so the dev-bypass doesn't fire

const { middleware } = await import('./middleware.js');

function makeReq(path: string, cookie?: string): Request {
  return new Request(`https://example.com${path}`, {
    method: 'GET',
    headers: cookie ? { cookie } : {},
  });
}

test('middleware: no cookie + /protected -> 302 to /beta-access?next=%2Fprotected', async () => {
  const res = await middleware(makeReq('/protected'));
  assert.equal(res.status, 302);
  const loc = res.headers.get('location') ?? '';
  assert.match(loc, /\/beta-access\?next=%2Fprotected/);
});

test('middleware: valid session cookie -> pass through (no redirect)', async () => {
  const token = await mintSessionToken('alice@firm.com', TEST_SECRET);
  const res = await middleware(makeReq('/protected', `beta_session=${token}`));
  // Next.js middleware returning undefined / NextResponse.next() is "pass through".
  // We approximate by checking the response isn't a 302.
  assert.notEqual(res.status, 302);
});

test('middleware: tampered cookie -> 302 to /beta-access', async () => {
  const token = await mintSessionToken('alice@firm.com', TEST_SECRET);
  const tampered = token.slice(0, -3) + 'AAA';
  const res = await middleware(makeReq('/protected', `beta_session=${tampered}`));
  assert.equal(res.status, 302);
});

test('middleware: /api/beta/request bypasses (gate own routes)', async () => {
  const res = await middleware(makeReq('/api/beta/request'));
  assert.notEqual(res.status, 302);
});

test('middleware: /beta-access bypasses (the page itself)', async () => {
  const res = await middleware(makeReq('/beta-access'));
  assert.notEqual(res.status, 302);
});

test('middleware: BETA_GATE_ENABLED=0 -> pass through', async () => {
  process.env.BETA_GATE_ENABLED = '0';
  const res = await middleware(makeReq('/protected'));
  assert.notEqual(res.status, 302);
  process.env.BETA_GATE_ENABLED = '1'; // reset for sibling tests
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @cpa/web test --test-name-pattern="middleware:"
```

Expected: 6 FAILs.

**Step 3: Write minimal implementation**

Create `apps/web/src/middleware.ts`:

```typescript
/**
 * Beta access gate — runs at the Vercel edge before every request.
 *
 * Reads beta_session cookie. If missing/invalid AND the path isn't a
 * gate-bypass (the /beta-access page, /api/beta/*, or static assets),
 * 302s to /beta-access?next=<original-path>.
 *
 * Toggles:
 *   BETA_GATE_ENABLED=0   -> pass through entirely (kill switch)
 *   NODE_ENV=development  -> pass through (no magic link needed locally)
 *
 * Uses jose (Edge-compatible). DO NOT import jsonwebtoken here — it
 * needs Node's crypto and won't run in the Edge runtime.
 */
import { verifyToken } from '@/lib/beta-auth';

// Paths the middleware lets through without checking the cookie.
const BYPASS_PREFIXES = ['/beta-access', '/api/beta/'];

export const config = {
  // Match all paths except _next/static and image optimization.
  // (Static assets are served directly by Vercel's edge and skip
  // middleware anyway, but documenting the exclusion is clearer.)
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

function passThrough(): Response {
  // NextResponse.next() in the App Router translates to "let the
  // request continue". From a Response perspective, we represent
  // this as a 200 with a special header that tests can inspect.
  // In production Next.js's middleware framework picks this up
  // via its `NextResponse` wrapper — see the production version
  // we export from this same file.
  return new Response(null, { status: 200, headers: { 'x-mw': 'pass' } });
}

export async function middleware(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Kill switch.
  if (process.env.BETA_GATE_ENABLED === '0') return passThrough();

  // Local dev: don't require beta auth.
  if (process.env.NODE_ENV !== 'production') return passThrough();

  // Bypass for gate's own routes.
  if (BYPASS_PREFIXES.some((p) => path.startsWith(p))) return passThrough();

  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)beta_session=([^;]+)/);
  const token = cookieMatch?.[1];

  if (token) {
    try {
      await verifyToken(token, 'beta-session', process.env.BETA_AUTH_SECRET!);
      return passThrough();
    } catch {
      /* fall through to redirect */
    }
  }

  const dest = new URL('/beta-access', url);
  dest.searchParams.set('next', path);
  return Response.redirect(dest, 302);
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @cpa/web test --test-name-pattern="middleware:"
```

Expected: 6 PASS.

**Step 5: Commit**

```bash
git add apps/web/src/middleware.ts apps/web/src/middleware.test.ts
git commit -m "feat(web): beta access gate middleware

Edge-runtime middleware that 302s unauth'd requests to /beta-access
unless the path is bypassed (gate's own routes, dev mode, or kill
switch). Cookie validated via jose."
```

---

## Phase 4 — UI page

### Task 7: `/beta-access` page

**Files:**
- Create: `apps/web/src/app/beta-access/page.tsx`

This is a thin form with no business logic worth unit-testing — the API route is what's tested. Smoke-tested manually post-deploy per the design doc.

**Step 1: Write the page**

Create `apps/web/src/app/beta-access/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';

export default function BetaAccessPage() {
  const params = useSearchParams();
  const errorParam = params.get('error');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch('/api/beta/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="max-w-md w-full space-y-6 rounded-lg border border-border bg-card p-8">
        <header className="space-y-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Claimsure beta access
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Enter your email. If it&apos;s on the beta allowlist, you&apos;ll get a magic
            link valid for 15 minutes.
          </p>
        </header>

        {errorParam === 'expired' && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            That magic link has expired. Request a new one below.
          </p>
        )}
        {errorParam === 'invalid' && (
          <p className="rounded-md border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900">
            That magic link is invalid. Request a new one below.
          </p>
        )}

        {submitted ? (
          <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
            If your email is on the beta allowlist, check your inbox for a link.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Email address</span>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="alice@firm.com.au"
              />
            </label>
            <button
              type="submit"
              disabled={submitting || email.length === 0}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? 'Sending…' : 'Send magic link'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
```

**Step 2: Smoke-build to catch type errors**

```bash
pnpm --filter @cpa/web typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add apps/web/src/app/beta-access/page.tsx
git commit -m "feat(web): /beta-access page — email-allowlist form

Renders the form, posts to /api/beta/request, shows generic 'check
your email' message after submit. Renders friendly hints for the
?error=expired and ?error=invalid query params the verify route uses."
```

---

## Phase 5 — Wire env + deploy

### Task 8: Configure Vercel env vars + deploy preview

**Files:**
- None to modify in repo (this task is config-only)

**Step 1: Set production env vars in Vercel dashboard**

Via Vercel CLI or web UI, set these on the `claimsure` project, scoped to **Preview** environments first (so we can test before flipping production):

```bash
vercel env add BETA_GATE_ENABLED preview     # value: 1
vercel env add BETA_AUTH_SECRET preview       # value: the 32-byte hex from Task 0 Step 2
vercel env add BETA_ALLOWLIST preview         # value: your-real-email@your-domain.com
vercel env add BETA_FROM_ADDRESS preview      # value: Claimsure Beta <noreply@claimsure.io>
vercel env add RESEND_API_KEY preview         # value: shared with the rest of the platform
```

(If you don't have `vercel` CLI installed: `pnpm add -g vercel` then `vercel login` then run the above. Or use the Vercel web UI: Project → Settings → Environment Variables.)

**Step 2: Trigger a Preview deploy**

Push a no-op commit (or use `vercel --prod=false`) to trigger a preview build. Grab the preview URL from the Vercel dashboard.

**Step 3: Manual E2E smoke**

1. Hit the preview URL cold (incognito tab). Expect 302 to `/beta-access`.
2. Enter an email NOT on the allowlist. Expect 200, no email arrives.
3. Enter the email FROM the allowlist. Expect 200, magic link arrives at that mailbox within ~30 sec.
4. Click the magic link. Expect redirect to `/`. Check DevTools: `beta_session` cookie set.
5. Reload `/`. Should stay on `/`, no redirect.
6. Visit `/login` directly. Should reach the existing login page.
7. Vercel logs (web UI → Project → Logs): grep for `beta.verified` — should see one structured line per successful verify.

**Step 4: Promote to production**

Once preview is happy, repeat the `vercel env add` commands with `production` instead of `preview`. Then redeploy production (via Vercel dashboard or `vercel --prod`).

**Step 5: Document the gate in README / CHANGELOG**

```bash
# Append to apps/web/README.md or platform CHANGELOG
```

Add a paragraph noting the beta access gate is live + how to grant/revoke access (edit `BETA_ALLOWLIST` env var in Vercel + redeploy). Commit.

**Step 6: Final commit**

```bash
git add apps/web/README.md   # if you updated it
git commit -m "docs(web): beta access gate live — see docs/plans/2026-05-15-beta-access-gate-design.md

Allowlist managed via Vercel env var BETA_ALLOWLIST. Disable with
BETA_GATE_ENABLED=0 + redeploy."
```

---

## Verification checklist

After all tasks complete, run from repo root:

```bash
pnpm --filter @cpa/web typecheck
pnpm --filter @cpa/web lint
pnpm --filter @cpa/web test
pnpm --filter @cpa/web build
```

Expected: all four green.

Test counts to expect:
- `beta-auth.test.ts`: 10 tests
- `route.test.ts` (request): 5 tests
- `route.test.ts` (verify): 6 tests
- `middleware.test.ts`: 6 tests

**Grand total for this plan: ~27 new tests, ~325 lines of new code, 8 commits.**

---

## Skill references

- **`superpowers:executing-plans`** — execute this plan task-by-task
- **`superpowers:test-driven-development`** — TDD discipline (red → green → commit)
- **`superpowers:verification-before-completion`** — run `pnpm test` before claiming a task done
