# @cpa/integrations

Adapters to external services consumed by the platform — voice
transcription, document signing, payroll providers, and the shared
runtime that ties them together (OAuth helpers, webhook signature
verification, retry, rate-limit, AES-256-GCM token encryption, email
sender stub).

This package is internal (`"private": true`) and consumed via pnpm
workspace links from `apps/api` (route handlers), `apps/api`
job-handlers (sync workers, webhook receivers), and the
`apps/web` server-action layer where it touches integration state.

The architectural rationale for several patterns here lives in
[ADR-0005](../../docs/decisions/0005-white-label-and-hostname-routing.md)
(custom-domain CNAME polling reuses the runtime's DNS resolver) and
the broader P3 design doc [§5
integrations](../../docs/plans/2026-04-27-p3-mobile-scribe-design.md).

## Subpath exports

Each provider is its own subpath. Import the narrowest path that
satisfies the call site so the adapters you don't need stay tree-
shaken out of the consumer's bundle.

```ts
// Shared runtime helpers (OAuth, retry, rate-limit, webhook verify, email stub).
import {
  withRetry,
  tryAcquire,
  generatePkceVerifier,
  exchangeCodeForTokens,
  verifyHmacSha256,
  verifyDocuSignSignature,
  resolveCname,
  sendEmail,
} from '@cpa/integrations/runtime';

// Voice transcription (Deepgram Nova-3, AU region).
import { transcribe } from '@cpa/integrations/deepgram';

// Document signing (DocuSign envelopes + webhook).
import { createEnvelope } from '@cpa/integrations/docusign';

// Payroll providers — each its own subpath.
import { syncEmployees } from '@cpa/integrations/payroll/employment-hero';
import { syncTimeEntries } from '@cpa/integrations/payroll/keypay';
import { startInstall } from '@cpa/integrations/payroll/deputy';
import { exchangeXeroCode } from '@cpa/integrations/payroll/xero-payroll';
```

The `payroll` umbrella subpath (`@cpa/integrations/payroll`) is
re-exported as a namespaced grouping for cases that genuinely need
multiple providers in one file (e.g. the admin-portal "connect any
provider" UI). Most consumers should reach for the narrower subpath.

## Environment variables

| Variable                                | Required                         | Notes                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_ENCRYPTION_KEY`                  | yes (production)                 | 32-byte hex (64 chars). AES-256-GCM key for `encryptToken`/`decryptToken`. Rotation strategy is a P9 task — current scheme requires a migration to re-encrypt old rows under a new key. |
| `DEEPGRAM_API_KEY`                      | when calling Deepgram            | Workspace-scoped. AU region inferred from the URL the client posts to.                                                                                                                  |
| `DOCUSIGN_INTEGRATION_KEY`              | when calling DocuSign            | Per integration_connection row at runtime; this env var is only the dev-mode default.                                                                                                   |
| `DOCUSIGN_WEBHOOK_SECRET`               | when receiving DocuSign webhooks | The shared HMAC secret configured in DocuSign Connect.                                                                                                                                  |
| `EMPLOYMENT_HERO_CLIENT_ID` / `_SECRET` | when calling Employment Hero     | OAuth 2.0 client credentials.                                                                                                                                                           |
| `KEYPAY_API_KEY`                        | when calling KeyPay              | API-key auth (no OAuth).                                                                                                                                                                |
| `DEPUTY_CLIENT_ID` / `_SECRET`          | when calling Deputy              | OAuth 2.0 with per-tenant install URL.                                                                                                                                                  |
| `XERO_CLIENT_ID` / `_SECRET`            | when calling Xero Payroll        | OAuth 2.0 PKCE; tenant-id header per call.                                                                                                                                              |
| `PLATFORM_CNAME_TARGET`                 | no                               | Used by the custom-domain state machine (defaults to `platform-cnames.platform.com.au`). Same value as `apps/api/src/routes/brand-config.ts` consumes.                                  |

## Adding a new integration (recipe)

The shape is consistent across every provider; copy the closest
existing one (OAuth → Employment Hero; API-key → KeyPay) and adapt.

1. **Create `src/<provider>/types.ts`** with the entity shapes and
   auth config the provider exposes. Keep types provider-flavoured
   (snake_case if the provider's API is snake_case) so the round-trip
   to the wire is mechanical.
2. **Create `src/<provider>/oauth.ts`** if the provider uses OAuth.
   Wire `buildAuthUrl()`, `exchangeCode()`, and (if the provider
   supports it) `refreshTokens()`. For PKCE flows, reuse
   `generatePkceVerifier()` and `pkceChallengeFromVerifier()` from
   `runtime/oauth.ts`. **Skip this file** for API-key auth (KeyPay).
3. **Create `src/<provider>/client.ts`** with the resource-specific
   functions (`listEmployees`, `listTimeEntries`, `createEnvelope`,
   etc.). Wrap every external HTTP call in `withRetry(...)` from the
   runtime — see "Retry policy" below for the gotcha about thrown vs
   resolved errors.
4. **Create `src/<provider>/index.ts`** that re-exports the
   client + oauth + types so callers import from the subpath root,
   not a deep path.
5. **Add the subpath to `package.json#exports`** with both `types`
   and `import` entries. Mirror the existing entries' shape exactly
   (`./dist/<provider>/index.d.ts` and `./dist/<provider>/index.js`).
6. **Re-export under namespace** — for payroll providers, add the
   re-export to `src/payroll/index.ts` so the umbrella subpath
   surfaces it. Top-level integrations (`deepgram`, `docusign`)
   don't need this step.
7. **Add tests** with `nock` mocking the provider's base URL. For
   DB-touching code (e.g. payroll syncs that upsert into
   `subject_tenant_employee` and `time_entry`), inject a
   postgres-js-compatible sql client via the optional `sql_client`
   parameter pattern — see "Testing" below.

## OAuth flow recipe

Most providers in this package use OAuth 2.0 (Employment Hero,
Deputy, Xero Payroll, DocuSign). The flow is the same shape across
all of them:

1. **`buildAuthUrl()` returns the provider's authorize URL** with
   the required `client_id`, `redirect_uri`, `state` (CSRF — use
   `generateOAuthState()`), and (for PKCE flows) `code_challenge`.
2. **Consultant clicks "Connect <Provider>"** in the admin portal
   (`/admin/integrations/<provider>/connect`). The route stores the
   PKCE verifier + state in a short-lived session blob and 302s the
   browser to `buildAuthUrl()`'s output.
3. **Provider redirects back** to
   `/v1/integrations/<provider>/callback?code=…&state=…`. The route
   verifies state matches the stored value, then calls
   `exchangeCode()`.
4. **`exchangeCode()` → `OAuthTokens`**. The runtime helper
   `exchangeCodeForTokens(...)` handles the standard PKCE token
   exchange; provider-specific clients can wrap it if the provider
   has additional fields (e.g. Xero's `xero_userid` or
   DocuSign's `accounts[]`).
5. **Encrypt tokens** before storage:
   ```ts
   import { encryptToken, getTokenEncryptionKey } from '@cpa/integrations/runtime';
   const enc = encryptToken(tokens.access_token, getTokenEncryptionKey());
   ```
6. **UPSERT** an `integration_connection` row keyed by
   `(tenant_id, provider)`:
   ```ts
   await sql`
     INSERT INTO integration_connection
       (tenant_id, provider, access_token_encrypted,
        refresh_token_encrypted, expires_at, scopes,
        external_account_id, sync_state, created_at)
     VALUES (...)
     ON CONFLICT (tenant_id, provider) DO UPDATE
       SET access_token_encrypted = EXCLUDED.access_token_encrypted,
           refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
           expires_at = EXCLUDED.expires_at,
           scopes = EXCLUDED.scopes,
           sync_state = 'idle',
           last_error = NULL
   `;
   ```
7. **Periodic sync job** (pg-boss cron) reads the connection,
   `decryptToken(...)` the stored ciphertext, and uses the tokens
   for the next API call. If `expires_at` has passed, refresh
   first.

## Token encryption

Stored OAuth tokens are encrypted at rest using **AES-256-GCM** with a
random 12-byte IV per write. The wire format is:

```
<iv-hex>.<authtag-hex>.<ciphertext-hex>
```

three dot-separated hex strings, all lowercase. Decryption splits on
the dot, reconstructs the IV and auth tag, and verifies the tag —
**any tampering with the ciphertext fails the auth-tag check and
decryption throws**, never returns garbage plaintext.

```ts
import { encryptToken, decryptToken, getTokenEncryptionKey } from '@cpa/integrations/runtime';

const key = getTokenEncryptionKey(); // reads + validates TOKEN_ENCRYPTION_KEY env
const ciphertext = encryptToken('access-token-from-provider', key);
// store ciphertext as TEXT column

// later
const plaintext = decryptToken(ciphertext, key);
```

`getTokenEncryptionKey()` reads `TOKEN_ENCRYPTION_KEY` (32-byte hex)
and throws if missing or malformed — fail-fast in production rather
than silently encrypting under an empty key.

## Webhook verification

Two helpers in `runtime/webhook-verify.ts`:

- **`verifyHmacSha256({ payload, signature_header, secret })`** —
  hex-encoded HMAC-SHA256 (lowercase). Used by most providers (e.g.
  payroll webhook receivers).
- **`verifyDocuSignSignature({ payload, signature_header, secret })`**
  — base64-encoded HMAC-SHA256. DocuSign's Connect webhook uses
  base64 in the `X-DocuSign-Signature-1` header.

**Both use `crypto.timingSafeEqual` for constant-time comparison** —
do not compare signatures with `===`. The helper returns `false` on
length mismatch and on any decode error rather than throwing, so
callers can treat all "not valid" cases uniformly with a single
`return reply.code(401)`.

The `payload` argument is the **raw request body** (a `Buffer` for
DocuSign, a `Buffer` or `string` for the generic helper). Never pass
the parsed JSON — HMAC is computed over bytes, and `JSON.parse →
JSON.stringify` round-trips do not preserve the original byte
sequence (whitespace, key order, escapes).

## Retry policy

`withRetry(fn, opts?)` runs `fn` up to `max_attempts` times (default
**5**), with exponential backoff: `initial_delay_ms * 2 ** attempt`
(default initial 200ms), capped at `max_delay_ms` (default 30s),
plus symmetric jitter of `±jitter_ratio` (default ±30%) to avoid
thundering-herd sync across callers.

```ts
import { withRetry } from '@cpa/integrations/runtime';

const employees = await withRetry(() => fetchFromProvider('/employees'));
```

**Important gotcha** — `withRetry` only catches **thrown** errors. If
`fn` resolves a `Response` with a 5xx status, `withRetry` will NOT
retry. To retry on 5xx, throw inside the callback:

```ts
await withRetry(async () => {
  const res = await fetch(url);
  if (res.status >= 500) throw new Error(`5xx from upstream: ${res.status}`);
  if (!res.ok) throw new Error(`non-OK from upstream: ${res.status}`);
  return res.json();
});
```

This is intentional — the retry helper has no opinion about what
"failure" means at the HTTP level (some 4xx are retryable, e.g. 429;
most aren't). The caller decides what to throw on.

## Rate-limiting

`tryAcquire(key, opts)` is a token-bucket rate limiter. Returns
`true` if a token is available (consuming one) or `false` if the
bucket is empty.

```ts
import { tryAcquire } from '@cpa/integrations/runtime';

const ok = tryAcquire(`${tenantId}:deepgram`, {
  capacity: 60, // max tokens in the bucket
  refill_per_second: 1, // 60-per-minute steady state
});
if (!ok) {
  // Surface a 429 to the caller, or queue for later.
}
```

**Per-key buckets** — typical key shape is `${tenant_id}:${provider}`
so noisy tenants can't starve quiet ones at the integration boundary.

**In-memory only for v1** — the bucket map is process-local. This is
fine while the API runs as a single Fastify instance. **Multi-instance
horizontal scale needs a Redis-backed bucket** — keep the
`tryAcquire(key, opts)` signature stable so the swap is a one-file
mechanical change (`runtime/rate-limit.ts`).

## Testing

```sh
pnpm --filter @cpa/integrations test       # all unit + integration tests
pnpm --filter @cpa/integrations typecheck
pnpm --filter @cpa/integrations lint
```

Test runner is Node 22's native via `tsx --test`, matching ADR-0001.
Tests live alongside source (`*.test.ts`).

### Mocking HTTP with nock

Every provider client hits a known base URL, so `nock` is the
standard interception layer. Pin the host pattern, not the path
suffix, when you want all requests to a provider intercepted at
once:

```ts
import nock from 'nock';

beforeEach(() => {
  nock.cleanAll();
});

test('listEmployees retries on 503', async () => {
  nock('https://api.employmenthero.com')
    .get('/v1/employees')
    .reply(503, 'service unavailable')
    .get('/v1/employees')
    .reply(200, { employees: [{ id: 'e1', email: 'a@b' }] });

  const result = await listEmployees({ token: 't' });
  // First call 503ed; withRetry caught the throw + retried; second call returned 200.
});
```

### DB-touching tests — `sql_client` injection

Payroll-sync code touches `subject_tenant_employee` and `time_entry`
in Postgres. Tests run against the live docker-compose Postgres
(per repo convention — ADR-0001) but should pass an explicit
postgres-js-compatible client through the optional `sql_client`
parameter pattern, not reach for a module-level `import { sql } from
'@cpa/db'`.

```ts
import { syncEmployees } from '@cpa/integrations/payroll/employment-hero';
import postgres from 'postgres';

test('syncEmployees upserts new employees', async () => {
  const sql = postgres(testDatabaseUrl);
  try {
    await syncEmployees({ tenant_id: '...', token: '...', sql_client: sql });
    const rows = await sql`SELECT * FROM subject_tenant_employee WHERE …`;
    // assertions
  } finally {
    await sql.end();
  }
});
```

The DI hole keeps the module testable without `sinon`-style
module-level stubbing, and the production code can default
`sql_client` to the real DB when omitted.

### DKIM / DNS-touching tests

The runtime's `resolveCname` is consumed by the custom-domain state
machine (`apps/api/src/jobs/custom-domain-state-machine.ts`). Tests
inject a `CnameResolver` stub through the job's `deps.resolveCname`
parameter rather than mocking `node:dns` at module level — the
resolver type is exported (`CnameResolver`) so the stub's TypeScript
contract is checked at compile time.

## Reference layout

```
packages/integrations/src/
├── index.ts                     barrel — re-exports runtime/*
├── runtime/
│   ├── oauth.ts                 PKCE helpers + exchangeCodeForTokens
│   ├── webhook-verify.ts        verifyHmacSha256, verifyDocuSignSignature
│   ├── retry.ts                 withRetry — exponential backoff + jitter
│   ├── rate-limit.ts            tryAcquire — in-memory token bucket
│   ├── email.ts                 EmailSender interface + console-stub
│   ├── dns-resolver.ts          resolveCname wrapper + CnameResolver type
│   ├── types.ts                 OAuthTokens, RetryOptions, RateLimitOptions
│   └── index.ts
├── deepgram/
│   ├── client.ts                POST /v1/listen with audio bytes (Nova-3, AU)
│   └── index.ts
├── docusign/
│   ├── client.ts                createEnvelope, downloadDocument
│   ├── webhook.ts               Connect HMAC verifier + envelope-status mapper
│   └── index.ts
└── payroll/
    ├── employment-hero/         OAuth + employee sync + timesheet pull
    ├── keypay/                  API-key auth + same surface
    ├── deputy/                  OAuth + per-tenant install URL
    ├── xero-payroll/            PKCE OAuth + tenant-id header
    └── index.ts                 namespace re-exports
```
