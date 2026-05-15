# Beta access gate — design doc

**Date:** 2026-05-15
**Status:** Approved, ready for implementation plan
**Owner:** @aaron
**Scope:** Vercel-edge email-allowlist gate in front of `apps/web` for closed-beta testing

---

## 1. Problem

The Claimsure web app is live at `claimsure.vercel.app` and the API at `cpaapi-production.up.railway.app`. We need to gate the web app for closed-beta testing so that only invited testers can reach the existing `/login` flow. The constraints:

- **Per-tester attribution.** We want to know who's been using the beta, not hand out a single shared password.
- **Vercel-native delivery.** Run at the edge, not in the API. The API is already RLS-locked; the beta gate is a separate concern in front of the web shell.
- **Reversible.** When beta ends, flipping one env var should disable the gate without code removal. When the code is removed (post-launch), nothing in the existing auth flow should change.
- **Cheap.** Stay on Vercel Hobby/Pro pricing, no external services beyond the Resend account we already have.

## 2. Decision summary

**Approach: Next.js Edge Middleware + email-allowlist magic link via existing Resend infrastructure.**

Rejected alternatives:
- **Vercel Pro "Password Protection"** — single shared password, no per-tester attribution. Inconsistent with the "allowlist" choice the user made when asked.
- **Shared passcode** (no magic link) — drops the Resend dependency but loses attribution. Same problem as the Vercel Pro feature.

## 3. Architecture

```
┌──────────────┐
│ User visits  │
│ claimsure.io │
└──────┬───────┘
       ▼
┌────────────────────────────────────┐    no cookie
│ Edge Middleware (middleware.ts)    │ ─────────────┐
│ - Checks beta_session cookie       │              │
│ - Verifies JWT signature + expiry  │              ▼
│ - Skips static + gate's own paths  │     ┌──────────────────┐
└────────────────────────────────────┘     │ /beta-access     │
       │ valid cookie                      │ email form (page)│
       ▼                                   └────────┬─────────┘
┌────────────────────┐                              │ POST
│ Existing Next app  │                              ▼
│ /, /login, etc.    │                     ┌────────────────────────┐
└────────────────────┘                     │ /api/beta/request      │
                                           │ - Validates email      │
                                           │ - Checks BETA_ALLOWLIST│
                                           │ - Mints magic-link JWT │
                                           │ - Sends via Resend     │
                                           │ - Always returns 200   │
                                           └────────┬───────────────┘
                                                    │ email arrives
                                                    ▼
                                           ┌────────────────────────┐
                                           │ User clicks magic link │
                                           │ → /api/beta/verify     │
                                           │ - Verifies JWT         │
                                           │ - Sets beta_session    │
                                           │ - 302 → next= or /     │
                                           └────────────────────────┘
```

## 4. Components

| File | Runtime | Lines | Responsibility |
|---|---|---:|---|
| `apps/web/src/middleware.ts` | Edge | ~60 | Cookie check + 302 to `/beta-access` for unauth'd requests. Skips `/api/beta/*`, `/beta-access`, `/_next/static/*`, `/favicon.ico`. |
| `apps/web/src/app/beta-access/page.tsx` | Server + Client form | ~80 | Email input. On submit, POST to `/api/beta/request`. Shows generic "check your email" message after submit (no enumeration). |
| `apps/web/src/app/api/beta/request/route.ts` | Node serverless | ~80 | Validates email (Zod). If on `BETA_ALLOWLIST`, mints magic-link JWT + sends via Resend. Always returns 200. In-memory rate limit: 5 requests / IP / hour. |
| `apps/web/src/app/api/beta/verify/route.ts` | Node serverless | ~50 | Verifies query-string JWT. On success, sets `beta_session` cookie (30-day TTL, httpOnly, secure, SameSite=Lax). 302 to sanitized `next` param or `/`. |
| `apps/web/src/lib/beta-auth.ts` | Edge + Node | ~50 | Three exports: `parseAllowlist()`, `mintMagicLinkToken(email)`, `verifyToken(token, expectedType)`. Uses `jose` (Edge-compatible). |
| `apps/web/.env.example` | n/a | ~5 | Documents the 3 new env vars. |

Total: 6 files, ~325 lines.

## 5. Data shapes

### Magic-link JWT (15 min TTL)

```json
{
  "iss": "claimsure-beta",
  "typ": "beta-link",
  "sub": "alice@firm.com.au",
  "iat": 1715789012,
  "exp": 1715789912
}
```

Carried in URL: `https://claimsure.vercel.app/api/beta/verify?token=eyJ…&next=%2F`

### Session-cookie JWT (30-day TTL)

```json
{
  "iss": "claimsure-beta",
  "typ": "beta-session",
  "sub": "alice@firm.com.au",
  "iat": 1715789912,
  "exp": 1718381912
}
```

Cookie: `beta_session=eyJ…; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`

Both JWTs are signed with the same secret (`BETA_AUTH_SECRET`) but `typ` claim differs and is asserted at verify time. A magic-link token can never be re-used as a session cookie (verifier rejects), and vice versa.

### Env vars

```
BETA_AUTH_SECRET=<32-byte hex, generate with openssl rand -hex 32>
BETA_ALLOWLIST=alice@firm.com.au,bob@another.co  # comma-separated, lowercased on read
BETA_FROM_ADDRESS=Claimsure Beta <noreply@claimsure.io>
BETA_GATE_ENABLED=1                              # 0 to disable middleware without code change
```

## 6. Sanitization & security rules

- **Email comparison**: lowercase + trim before comparing to allowlist (which is also lowercased on parse). Idempotent regardless of how testers type their email.
- **`next` param**: must start with `/` but not `//`. If invalid, fall back to `/`. Prevents off-site redirect attack (`?next=https://evil.com`).
- **Generic 200 on `/api/beta/request`**: response is identical whether the email is on the allowlist or not. Prevents allowlist enumeration via probing.
- **Rate limit on `/api/beta/request`**: 5 requests/IP/hour. In-memory map; restart resets. Acceptable for beta scale; replace with Upstash KV if we need persistence.
- **Cross-JWT-type rejection**: verifier asserts `typ` claim. Reuse impossible.
- **`BETA_GATE_ENABLED=0`** flag: middleware short-circuits if set, letting all traffic through. For "turn off the beta gate" without a redeploy.

## 7. Behavior matrix

| Scenario | Behavior |
|---|---|
| No cookie, request to `/` | 302 → `/beta-access?next=%2F` |
| No cookie, request to `/api/beta/*` | Pass through (gate's own routes) |
| No cookie, request to `/_next/static/*` | Pass through (static asset) |
| Valid session cookie | Pass through |
| Tampered/expired session cookie | Treat as missing → 302 to `/beta-access` |
| `BETA_GATE_ENABLED=0` | Pass through (gate disabled) |
| Email submitted on allowlist | Send magic link via Resend, return 200 "check your email" |
| Email submitted NOT on allowlist | Return 200 "check your email" (same response, no enumeration) |
| Magic link clicked, valid + within 15 min | Set cookie, 302 to `next` (sanitized) or `/` |
| Magic link clicked, expired | 302 to `/beta-access?error=expired&next=…` |
| Magic link clicked, tampered/invalid sig | 302 to `/beta-access?error=invalid` |
| >5 `/api/beta/request` from one IP in 1 hr | 429 with `Retry-After` header |

## 8. Defaults the user didn't override

The user approved 3 design items explicitly and didn't override these defaults:

- **Cookie cross-domain scope**: NO. Cookie is set on `claimsure.vercel.app` only. API authenticates separately via its own session JWT; beta gate is web-only.
- **Local dev behavior**: middleware auto-bypasses when `process.env.NODE_ENV !== 'production'`. No magic link needed for local dev. Simple and predictable.
- **`BETA_GATE_ENABLED` flag**: yes, env var (not code) controls the gate. Default `1` (enabled). Setting `0` disables in production without redeploying code.
- **Observability**: successful `/api/beta/verify` emits a single-line JSON log to stdout: `{"event": "beta.verified", "email": "alice@firm.com.au", "ts": "..."}`. No PII beyond the email itself. Ships with Vercel's built-in log pipeline.

## 9. Testing

### Unit (`apps/web/src/lib/beta-auth.test.ts`)

- `parseAllowlist()` — comma-separated parsing, lowercase normalization, empty/whitespace handling
- `mintMagicLinkToken()` + `verifyToken('beta-link')` round-trip
- `verifyToken('beta-session')` rejects a token minted with `typ='beta-link'` (type-cross check)
- Expired token rejected with the expected error class
- Tampered signature rejected

### Integration (`apps/web/src/app/api/beta/__tests__/`)

- `POST /api/beta/request` with allowlisted email → 200, Resend stub called once with valid magic-link URL
- `POST /api/beta/request` with non-allowlisted email → 200, Resend stub NOT called
- `POST /api/beta/request` with malformed email → 400 with `field: email`
- `POST /api/beta/request` 6th call from same IP in 1 hr → 429
- `GET /api/beta/verify?token=<valid>` → 302 to `/` with `Set-Cookie: beta_session=…`
- `GET /api/beta/verify?token=<expired>` → 302 to `/beta-access?error=expired`
- `GET /api/beta/verify?token=<tampered>` → 302 to `/beta-access?error=invalid`
- `GET /api/beta/verify?token=…&next=https://evil.com` → 302 to `/` (next param sanitized)

### E2E (manual, post-deploy)

- Deploy to Vercel preview
- Hit `/` cold → confirm 302 to `/beta-access`
- Enter allowlisted email → confirm email arrives in Resend test inbox
- Click magic link → confirm redirect home + cookie set in DevTools
- Hit `/login` → confirm reaches the existing login page (gate is upstream of it)
- Set `BETA_GATE_ENABLED=0` in Vercel env, redeploy → confirm gate disabled
- Set `NODE_ENV=development` locally → confirm gate auto-bypasses

## 10. Out of scope (explicit YAGNI)

- **Persistent rate-limit store** (Upstash KV). In-memory is fine for beta scale (~50 testers). Restart resets the counter, which is acceptable since a determined attacker would just hit a different region anyway.
- **Audit log in DB.** The Vercel structured log + the env-var allowlist together are the audit trail.
- **Admin UI for managing the allowlist.** Edit env var, redeploy. Three-line config change.
- **Multi-region cookie sync.** Vercel handles this; the cookie is set on the apex domain and works across PoPs.
- **Removing the beta gate post-launch.** Plan is: delete the 6 files + 3 env vars. Existing `/login` is untouched.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Resend API key leaks via env | Already maintained as a secret; same pattern as the rest of the platform |
| Magic link email hits spam | We're on a verified domain; copy reads like a normal transactional email |
| Beta tester forwards their magic link | Token is single-use-but-not-enforced; 15 min expiry limits damage. Cookie is per-browser, so forwarded magic link gives the recipient their own session. Acceptable for closed beta. |
| `BETA_AUTH_SECRET` rotation | Rotating invalidates all in-flight magic links and existing sessions. Acceptable; we issue a notice and have testers re-verify. |
| Hostile actor probes allowlist | Generic 200 + rate limit + structured logs let us detect + manually ban abusive IPs |

## 12. Implementation plan reference

The implementation plan that breaks this design into concrete steps lives at `docs/plans/2026-05-15-beta-access-gate-plan.md` (generated by the writing-plans skill in the next step of this brainstorming session).
