# P3 — Mobile Scribe + Full Module 3 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Ship the per-claimant mobile capture loop + four payroll integrations + DocuSign + full white-label (custom subdomain + custom domain + ACME cert lifecycle) + audit-readiness scoring, on top of the P2 event-chain foundation.

**Architecture:** Hybrid Expo + PWA. New `subject_tenant_employee` identity + magic-link email auth. Server-authoritative chain reconciliation (per architecture §7 risk #3) — mobile queues raw payloads to local SQLite + drains via background sync. Three parallelisable swimlanes after a 2-week foundation: capture loop, integrations (DocuSign + 4 payroll), brand+status. Hostname-based tenant resolution at edge for custom-domain support.

**Tech Stack:** Expo SDK 51 / React Native 0.74 · Expo Router · expo-sqlite · expo-secure-store · expo-notifications · expo-camera · expo-av · TanStack Query · zustand · Deepgram Nova-3 (AU region) · DocuSign · Employment Hero / KeyPay / Deputy / Xero Payroll APIs · AWS Certificate Manager (ACME) · AWS SES · pg-boss for async jobs · Detox for native e2e · Playwright for PWA e2e.

**Design doc:** [`./2026-04-27-p3-mobile-scribe-design.md`](./2026-04-27-p3-mobile-scribe-design.md)
**Builds on:** [`./2026-04-27-p2-event-capture-design.md`](./2026-04-27-p2-event-capture-design.md) — events, classifier, chain helpers.

**Working directory for all tasks:** `C:\Users\Aaron\cpa-platform-worktrees\p3` (branch `p3/mobile-scribe`).

**Discipline notes (apply to every task):**
- `@cpa/...` workspace imports — never relative paths across packages
- TypeScript strict; ESM with `.js` import suffix; node:test runner; verbatimModuleSyntax
- Tests use `tsx --env-file-if-exists=../../.env --test "src/**/*.test.ts"`
- Migrations: `pnpm --filter @cpa/db generate` then hand-author RLS portion; **never `generate` after a hand-edit on the same migration** (per the warning in 0006)
- All commits: conventional-commits format + co-author trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- Commit per task. Push at end of each phase (or sooner per controller direction).

**Pillar verification:** every task should advance ≥1 of the 5 Pillars from `docs/product/2026-04-27-omniscient-feature-spec.md`. Use the PR description's "Pillar(s)" line.

---

## Phasing overview

| Phase | Tasks | Calendar weeks | Dependency |
|---|---|---|---|
| **Foundation** | F1–F17 | W14–W15 (2w) | P2 merged to main |
| **Swimlane A — Capture loop** | A1–A15 | W16–W19 (4w) | Foundation |
| **Swimlane B — Integrations** | B1–B23 | W16–W22 (7w, parallel-friendly) | Foundation; parallel with A and C |
| **Swimlane C — Brand + Status** | C1–C15 | W18–W23 (6w) | Foundation |
| **Final — Audit score + e2e + docs** | D1–D10 | W23–W26 (3w) | A + B + C |

Total: ~12–14 weeks. Swimlanes A/B/C can split across parallel implementers if available; default sequential within a swimlane.

---

## Foundation phase (F1–F17)

### Task F1: Generate base schemas (drizzle) for 7 new tables

**Files:**
- Create: `packages/db/src/schema/subject_tenant_employee.ts`
- Create: `packages/db/src/schema/magic_link_token.ts`
- Create: `packages/db/src/schema/mobile_session.ts`
- Create: `packages/db/src/schema/media_artefact.ts`
- Create: `packages/db/src/schema/time_entry.ts`
- Create: `packages/db/src/schema/signing_request.ts`
- Create: `packages/db/src/schema/brand_config.ts`
- Modify: `packages/db/src/schema/index.ts` (re-export all 7)

**Approach:** Match the existing convention from P2 (camelCase TS / snake_case SQL, `pgTable('table', { ... }, (t) => ({ indexes }))`). Each schema as defined in the design doc §2.1. Add nullable FKs for forward-compat where the target table arrives later (none for P3 — all FKs target existing tables).

**Step 1: Read existing schemas first**
- `packages/db/src/schema/subject_tenant.ts`, `tenant.ts`, `event.ts` for shape

**Step 2: Write each schema file (7 files)** with full column + index definitions per design doc §2.1.

**Step 3: Re-export from `index.ts`**

**Step 4: Generate migration**
```bash
pnpm --filter @cpa/db generate
```
Expected output: `0008_<adj>_<noun>.sql` containing CREATE TABLE for all 7 tables + their indexes.

**Step 5: Inspect the generated migration** — verify:
- 7 CREATE TABLE statements
- All FK constraints present
- Unique partial indexes correctly emit `WHERE deleted_at IS NULL` etc.
- No surprise columns or constraints from drizzle inferring something we didn't intend

**Step 6: Build + typecheck**
```bash
pnpm --filter @cpa/db build && pnpm --filter @cpa/db typecheck
```
Expected: clean.

**Step 7: Commit**
```bash
git add packages/db/src/schema/ packages/db/migrations/
git commit -m "feat(db): P3 schemas — employee, sessions, media, time, signing, brand_config + migration 0008"
```

---

### Task F2: Hand-author RLS + CHECK constraints for migration 0008

**Files:** Modify: `packages/db/migrations/0008_<adj>_<noun>.sql` (append RLS + CHECK block)

**Approach:** Same pattern as P2's 0006_fair_network.sql hand-authored block.

**Step 1:** Read `packages/db/migrations/0006_fair_network.sql` for the precedent.

**Step 2:** Append a hand-authored block at the end of 0008. Critical constraints:

```sql
--> statement-breakpoint
-- ============================================================
-- DB-level CHECK constraints
-- ============================================================

ALTER TABLE "subject_tenant_employee" ADD CONSTRAINT employee_email_format
  CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

ALTER TABLE "magic_link_token" ADD CONSTRAINT magic_link_token_hash_format
  CHECK (token_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE "mobile_session" ADD CONSTRAINT mobile_session_refresh_hash_format
  CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE "media_artefact" ADD CONSTRAINT media_content_hash_format
  CHECK (content_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE "time_entry" ADD CONSTRAINT time_entry_apportionment_range
  CHECK (apportionment_pct IS NULL OR (apportionment_pct >= 0 AND apportionment_pct <= 100));

ALTER TABLE "time_entry" ADD CONSTRAINT time_entry_duration_positive
  CHECK (duration_minutes > 0 AND ended_at > started_at);

ALTER TABLE "brand_config" ADD CONSTRAINT brand_config_color_format
  CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$' AND accent_color ~ '^#[0-9a-fA-F]{6}$');

--> statement-breakpoint
-- ============================================================
-- RLS — same pattern as 0002 (FORCE + USING + WITH CHECK)
-- ============================================================

ALTER TABLE "subject_tenant_employee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subject_tenant_employee" FORCE ROW LEVEL SECURITY;
CREATE POLICY "employee_tenant_isolation" ON "subject_tenant_employee"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE "media_artefact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_artefact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "media_artefact_tenant_isolation" ON "media_artefact"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE "time_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "time_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "time_entry_tenant_isolation" ON "time_entry"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE "signing_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signing_request" FORCE ROW LEVEL SECURITY;
CREATE POLICY "signing_request_tenant_isolation" ON "signing_request"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE "brand_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY "brand_config_tenant_isolation" ON "brand_config"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- magic_link_token NOT RLS-protected: lookup is by token_hash before
-- tenant context is established. The hash IS the secret.

-- mobile_session NOT directly RLS-protected: accessed via employee_id
-- which IS RLS-scoped. Refresh-flow lookup is by refresh_token_hash.

GRANT SELECT, INSERT, UPDATE, DELETE ON "subject_tenant_employee" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "magic_link_token" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "mobile_session" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "media_artefact" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "time_entry" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "signing_request" TO cpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_config" TO cpa_app;
```

**Step 3:** Add `-- DO NOT REGENERATE` header at top of the file (matches P2's 0006 pattern).

**Step 4:** Apply migration locally if Postgres available; otherwise CI validates. Build + typecheck still must pass.

**Step 5:** Commit
```bash
git commit -am "feat(db): RLS + CHECK constraints for P3 tables"
```

---

### Task F3: Add `integration_connection` table (for OAuth state)

**Files:** Modify migration 0008 (or create 0009 if cleaner) to add integration_connection table

**Approach:** Used by Swimlane B for storing encrypted OAuth tokens per `(tenant_id, provider)`.

```ts
// packages/db/src/schema/integration_connection.ts
export const INTEGRATION_PROVIDERS = [
  'docusign', 'employment_hero', 'keypay', 'deputy', 'xero_payroll',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const integration_connection = pgTable('integration_connection', {
  id: uuid('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenant_id: uuid('tenant_id').notNull().references(() => tenant.id),
  provider: text('provider', { enum: INTEGRATION_PROVIDERS }).notNull(),
  access_token_encrypted: text('access_token_encrypted').notNull(),
  refresh_token_encrypted: text('refresh_token_encrypted'),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  scopes: text('scopes').array(),
  external_account_id: text('external_account_id'),
  last_synced_at: timestamp('last_synced_at', { withTimezone: true }),
  sync_state: text('sync_state', { enum: ['idle', 'syncing', 'failed'] }).notNull().default('idle'),
  last_error: text('last_error'),
  created_at: timestamp(...).notNull().defaultNow(),
  updated_at: timestamp(...).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  tenantProviderUnique: uniqueIndex('integration_connection_tenant_provider_unique')
    .on(t.tenant_id, t.provider),
}));
```

Encryption: use `pgcrypto`'s `pgp_sym_encrypt` with a KMS-derived key passed via `app.encryption_key` GUC. Application-side encryption is also acceptable; choose one approach and document in ADR-0004.

RLS + GRANT same pattern as F2.

Commit: `feat(db): integration_connection — encrypted OAuth state per (tenant, provider)`

---

### Task F4: Hostname-based tenant resolver middleware

**Files:**
- Create: `apps/api/src/middleware/hostname-tenant-resolver.ts`
- Create: `apps/web/src/middleware.ts` (or update if it exists)
- Test: `apps/api/src/middleware/hostname-tenant-resolver.test.ts`

**Approach:** Two-stage hostname → tenant lookup:
1. Match hostname against `(.+)\.platform\.com\.au$` → look up `brand_config.custom_subdomain`
2. Otherwise look up by `brand_config.custom_domain` (full match)

**API middleware (Fastify hook):**
```ts
// apps/api/src/middleware/hostname-tenant-resolver.ts
import type { FastifyInstance } from 'fastify';
import { sql } from '@cpa/db/client';

const SUBDOMAIN_RE = /^([a-z0-9-]+)\.platform\.com\.au$/i;

export async function registerHostnameTenantResolver(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req) => {
    const host = req.headers.host?.toLowerCase() ?? '';
    let row: { tenant_id: string; brand: any } | undefined;
    const subdomainMatch = host.match(SUBDOMAIN_RE);
    if (subdomainMatch) {
      const [{ tenant_id, ...rest }] = await sql`
        SELECT tenant_id, display_name, primary_color, accent_color, logo_s3_key
        FROM brand_config WHERE custom_subdomain = ${subdomainMatch[1]}
      `;
      row = { tenant_id, brand: rest };
    } else if (host && host !== 'platform.com.au') {
      const r = await sql`
        SELECT tenant_id, display_name, primary_color, accent_color, logo_s3_key
        FROM brand_config WHERE custom_domain = ${host}
      `;
      if (r[0]) row = { tenant_id: r[0].tenant_id, brand: r[0] };
    }
    if (row) {
      (req as any).resolvedBrand = row;
    }
  });
}
```

**Tests:**
```ts
test('subdomain matches → resolves tenant', async () => { ... });
test('custom_domain matches → resolves tenant', async () => { ... });
test('unknown hostname → no resolution', async () => { ... });
test('default platform.com.au → no resolution (uses session)', async () => { ... });
```

**Web middleware (Next.js Edge):** Mirror shape; injects resolved tenant into `request.headers['x-tenant-id']` for downstream use in server components.

Commit: `feat(api,web): hostname-based tenant resolver middleware`

---

### Task F5: Mobile JWT verifier middleware

**Files:**
- Create: `apps/api/src/middleware/mobile-jwt-verifier.ts`
- Test: `apps/api/src/middleware/mobile-jwt-verifier.test.ts`

**Approach:** Verify mobile-audience JWTs (`aud: 'mobile'`) and set `req.user = { kind: 'employee', employeeId, tenantId, subjectTenantId }`. Reject non-mobile audience.

```ts
// apps/api/src/middleware/mobile-jwt-verifier.ts
import { jwtVerify, type JWTPayload } from 'jose';

export async function verifyMobileJwt(token: string, secret: Uint8Array): Promise<MobilePrincipal> {
  const { payload } = await jwtVerify(token, secret, { audience: 'mobile' });
  if (!payload.sub || !payload.tenant_id) throw new Error('invalid mobile JWT shape');
  return {
    kind: 'employee',
    employeeId: payload.sub,
    tenantId: payload.tenant_id as string,
    subjectTenantId: payload.subject_tenant_id as string,
  };
}

export function requireMobileSession(req: FastifyRequest, reply: FastifyReply): Promise<void> { ... }
```

Tests cover: valid token → success, expired → 401, wrong audience → 403, malformed → 401.

Commit: `feat(api): mobile JWT verifier middleware (aud='mobile')`

---

### Tasks F6–F8: Magic-link API endpoints

**F6:** `POST /v1/employees` (consultant invites — creates row + sends magic-link email) and `POST /v1/employees/:id/invite` (resend)

**F7:** `POST /v1/auth/magic-link/redeem` — validates token, creates mobile_session, returns access_token + refresh_token + brand_config

**F8:** `POST /v1/auth/refresh` — rotates refresh token, returns new access + refresh

Each endpoint follows the P2 routes pattern (FastifyPluginAsync + ZodTypeProvider + zod schemas + tests). Schemas live in `packages/schemas/src/{employee,magic-link,mobile-session}.ts`.

Magic-link generation:
```ts
const rawToken = crypto.randomBytes(32).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
await sql`INSERT INTO magic_link_token (employee_id, token_hash, expires_at) VALUES (...)`;
// Send email with link: https://[brand-host]/m/auth?t=<rawToken>
```

JWT issuance on redemption:
```ts
const accessToken = await new SignJWT({ sub: employee.id, tenant_id: employee.tenant_id, subject_tenant_id: employee.subject_tenant_id })
  .setAudience('mobile').setExpirationTime('1h')
  .setProtectedHeader({ alg: 'HS256' }).sign(secret);
```

Each task: failing tests → implement → green → commit. Three commits.

---

### Task F9: Brand-config API endpoints

`GET /v1/brand-config/by-tenant/:id` (mobile pulls on launch — must be unauthed since pre-magic-link mobile needs the brand to render the login screen properly)
`PATCH /v1/brand-config` (consultant updates own firm's brand)
`POST /v1/brand-config/logo` (signed upload URL for logo)

Commit: `feat(api): brand-config endpoints (read-only public + authed update)`

---

### Tasks F10–F11: Expo project bootstrap + Expo Router

**F10:** Create `apps/mobile/` with Expo SDK 51:
- `npx create-expo-app@latest apps/mobile -t default --no-install` (then add to workspace)
- `package.json` with workspace deps `@cpa/schemas`
- `app.json` configured with bundle id `com.cpa.scribe` (parameterised per-tenant in EAS later)
- `eas.json` with internal distribution profile
- `babel.config.js`, `metro.config.js`, `tsconfig.json` extending root

**F11:** Expo Router setup with auth gate:
- `app/_layout.tsx` (root layout — react-query provider + theme provider)
- `app/(unauthed)/_layout.tsx` + `app/(unauthed)/login.tsx`
- `app/(authed)/_layout.tsx` (auth gate — redirects to login if no session)
- Shared API client in `apps/mobile/src/api-client/`

Commit per task. End: `pnpm --filter @cpa/mobile build` succeeds (or appropriate Expo equivalent).

---

### Tasks F12–F17: Mobile foundation

- **F12:** SQLite schema + migrations (`mobile_event_queue` + others)
- **F13:** Magic-link redemption screen + secure-store for refresh token
- **F14:** Background sync worker (expo-task-manager + expo-network)
- **F15:** Theme provider that pulls brand_config on launch + caches
- **F16:** Network-state UI (online/offline indicator + queue status)
- **F17:** Foundation Detox smoke test (launch → login → see home)

One commit per task.

---

## Swimlane A — Capture loop (A1–A15, sequential)

### Task A1: Voice recording UI

**Files:**
- Create: `apps/mobile/app/(authed)/capture/voice.tsx`
- Create: `apps/mobile/src/hooks/use-voice-recorder.ts`
- Create: `apps/mobile/src/api-client/events.ts`

**Approach:** Use `expo-av` (Audio.Recording). Big circular record button → 30 sec max → tap to stop → preview waveform → submit. On submit: enqueue to local SQLite (`kind='event'`, payload includes audio file URI + raw_text='' placeholder).

Tests: Detox test that taps record button, simulates 5s wait, taps stop, sees preview.

Commit: `feat(mobile): voice capture screen + recorder hook`

---

### Task A2: Deepgram client (`packages/integrations/deepgram`)

**Files:**
- Create: `packages/integrations/src/deepgram/client.ts`
- Test: `packages/integrations/src/deepgram/client.test.ts`

**Approach:**
```ts
export type DeepgramTranscript = {
  text: string;
  confidence: number;
  duration_seconds: number;
};

export async function transcribe(audioBytes: Buffer, opts: { mimeType: string }): Promise<DeepgramTranscript> {
  const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&language=en-AU&punctuate=true&smart_format=true', {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': opts.mimeType },
    body: audioBytes,
  });
  if (!res.ok) throw new Error(`deepgram: ${res.status}`);
  const j = await res.json();
  return {
    text: j.results.channels[0].alternatives[0].transcript,
    confidence: j.results.channels[0].alternatives[0].confidence,
    duration_seconds: j.metadata.duration,
  };
}
```

Tests with `nock` against api.deepgram.com — happy path, 401, 429 (rate limited), bad audio.

Commit: `feat(integrations): Deepgram Nova-3 client (AU region)`

---

### Task A3: Voice transcription pg-boss job

**Files:**
- Create: `apps/api/src/jobs/transcribe.ts`
- Create: `apps/api/src/jobs/index.ts` (registry)
- Test: `apps/api/src/jobs/transcribe.test.ts`

**Approach:** Job consumes `(audio_s3_key, event_id)`, downloads bytes, calls `transcribe(...)`, updates the event's payload with `raw_text + transcript_confidence + transcript_duration_seconds`, then triggers the existing P2 classifier flow on the now-transcribed text.

Commit: `feat(api): pg-boss transcribe job — Deepgram → event.payload.raw_text`

---

### Task A4: Voice → event flow end-to-end

**Files:**
- Create: `apps/api/src/routes/mobile-events.ts` (POST /v1/mobile/events)
- Modify: `apps/mobile/src/sync/sync-worker.ts` to drain voice events specifically

**Approach:** Mobile uploads audio bytes via pre-signed URL → POSTs metadata `{audio_s3_key, mime_type, duration_seconds, captured_at_local}` to `/v1/mobile/events` → API creates event with placeholder payload → enqueues transcribe job → eventual chain insertion.

Mobile shows "Transcribing..." chip on the event card until the event_id receives the classifier result (poll or websocket).

Commit: `feat(api,mobile): mobile voice event flow — pre-signed upload + transcribe + classify`

---

### Task A5: Camera + EXIF capture

Use `expo-camera` and `expo-media-library`. Strip EXIF GPS to a separate metadata blob (don't bake into uploaded image; store EXIF in the `media_artefact.exif` jsonb column, served only to authenticated consultants).

Commit: `feat(mobile): camera capture + EXIF metadata extraction`

---

### Task A6: Photo upload via pre-signed URL

API: `POST /v1/media/presigned-upload` returns `{ upload_url, s3_key, content_hash_required }`. Mobile uploads bytes to S3 directly. On 200, mobile POSTs `/v1/media/finalize` with `{s3_key, content_hash, mime_type, size_bytes, exif, event_id?}`.

Commit: `feat(api,mobile): media upload via pre-signed URL + finalize endpoint`

---

### Task A7: Document picker upload

`expo-document-picker` for PDF / DOCX / images. Reuses the pre-signed upload flow from A6.

Commit: `feat(mobile): document picker → vault upload`

---

### Task A8: media_artefact metadata API

Already partially in A6. Complete with: `GET /v1/media/by-claimant/:id`, `GET /v1/media/:id` (returns metadata + signed download URL), `DELETE /v1/media/:id` (soft delete).

Commit: `feat(api): media_artefact CRUD endpoints`

---

### Task A9: S3-event Lambda for OCR + virus scan

**Files:**
- Create: `infra/lambda/media-postprocess/index.ts` (or inline in app code if no separate infra repo)
- Create: `apps/api/src/jobs/ocr-scan.ts` (alt: pg-boss instead of Lambda — choose one approach)

**Approach:** S3 ObjectCreated event triggers Lambda → Lambda reads bytes → calls AWS Textract for OCR → calls ClamAV (or AWS GuardDuty Malware Protection) → writes back to `media_artefact.ocr_text + ocr_status + virus_scan_status` via API webhook (`POST /v1/media/:id/postprocess-result`).

Alternative: Use pg-boss in the API server with S3 event → SQS → pg-boss subscriber. Simpler if you don't want Lambda IAM headaches; ~equivalent latency.

Decide one approach; document in ADR-0005. For P3 v1, recommend pg-boss-via-SQS (one less deploy artefact).

Commit: `feat(api): async OCR + virus scan via pg-boss subscriber`

---

### Tasks A10–A11: Hypothesis prompts

**A10:** Mobile screen — prompt user with three fields: "What outcome do you predict?" + "What does success look like?" + "What are you uncertain about?". Triggered when starting a new experiment (separate from voice/photo flows). Fields persist as a single HYPOTHESIS event with structured payload.

**A11:** Backend — extend `event.payload` schema with `_v: 1, source: 'hypothesis_prompt', predicted_outcome, success_criteria, uncertainty`. Classifier still runs (for confidence + statutory anchor) but the kind is forced to HYPOTHESIS by the API endpoint (skip classifier kind result; keep confidence + anchor).

Commits:
- `feat(mobile): hypothesis prompt screen — pre-experiment capture (Body by Michael fix)`
- `feat(api): hypothesis_prompt event variant — kind forced to HYPOTHESIS`

---

### Tasks A12–A13: Push notifications

**A12:** pg-boss cron `daily-capture-push` runs at 17:30 in each employee's timezone (employee.timezone column added to F1 schema if missing — add via migration if so). Sends Expo Push to all devices with `last_seen_at` in the last 30 days that haven't captured an event today.

**A13:** Mobile registers push token on first auth via `expo-notifications`. Token stored in `mobile_session.push_token` (add column).

Commits:
- `feat(api): daily-capture push cron job`
- `feat(mobile): push token registration on session create`

---

### Task A14: Offline queue drain + retry

Already partially in F14. Complete with: exponential backoff (1s, 2s, 4s, 8s, 16s, max 5 retries), then surface to user with manual retry CTA. Conflict handling: if API returns 409 (chain race — should be ~impossible at scale, but defensive), client refetches latest server state and retries with new prev_hash context (server-authoritative; mobile doesn't compute).

Commit: `feat(mobile): offline queue retry policy + conflict resolution`

---

### Task A15: Detox e2e for capture flow

Detox test: launch → login via magic-link (test fixture) → record voice → submit → verify event appears in feed → take photo → submit → verify in vault → start hypothesis → fill three fields → verify HYPOTHESIS event in feed.

Commit: `test(mobile): Detox e2e — capture flow (voice + photo + hypothesis)`

---

## Swimlane B — Integrations (B1–B23, parallel-friendly)

### Task B1: `packages/integrations` bootstrap

Same shape as `packages/agents` from P2. package.json with `@cpa/db`, `@cpa/schemas` workspace deps + `nock` (test). tsconfig + eslint matching siblings.

Commit: `feat(integrations): bootstrap @cpa/integrations workspace package`

---

### Task B2: OAuth runtime helpers

**Files:**
- `packages/integrations/src/runtime/oauth.ts` — PKCE flow helpers, token storage, refresh-on-expiry
- `packages/integrations/src/runtime/webhook-verify.ts` — signature verification (HMAC-SHA256 generic, override per-provider)
- `packages/integrations/src/runtime/retry.ts` — exponential backoff with jitter
- `packages/integrations/src/runtime/rate-limit.ts` — token bucket per `(tenant, provider)`
- `packages/integrations/src/runtime/types.ts`
- Tests for each

Commit: `feat(integrations): runtime — OAuth, webhook verify, retry, rate limit`

---

### Task B3: integration_connection CRUD

API endpoints: `POST /v1/integrations/:provider/connect` (start OAuth — returns redirect URL), `GET /v1/integrations/:provider/callback` (handle code, exchange for tokens, encrypt + store), `DELETE /v1/integrations/:provider` (revoke + soft-delete row), `GET /v1/integrations` (list active connections).

Commit: `feat(api): integration_connection CRUD endpoints + OAuth callback handler`

---

### Tasks B4–B6: DocuSign

**B4:** `packages/integrations/src/docusign/client.ts` — envelope create, document download. JWT-grant auth (DocuSign supports OAuth + JWT; use JWT for server-to-server simplicity).

**B5:** `packages/integrations/src/docusign/webhook.ts` — verify HMAC, parse status update, write to `signing_request`, optionally append `SUPPORTING` event to chain.

**B6:** `apps/api/src/routes/signing.ts` — `POST /v1/signing/requests` (initiate envelope), `GET /v1/signing/:id` (status), DocuSign webhook endpoint `POST /v1/integrations/docusign/webhook`.

Each: failing tests → implement → green → commit. Three commits.

---

### Task B7: Mobile signing screen

`apps/mobile/app/(authed)/signing/[id].tsx` — opens DocuSign signing URL in `WebView` (or `expo-web-browser`) → on completion, mobile polls signing_request status → updates UI.

Commit: `feat(mobile): in-app signing browser`

---

### Tasks B8–B11: Employment Hero integration

**B8:** OAuth flow + client (`packages/integrations/src/payroll/employment-hero/{oauth,client}.ts`)
**B9:** Employee sync (`employee-sync.ts`) — list employees, upsert subject_tenant_employee matched by `payroll_external_id`
**B10:** Time-entry pull (`time-entry-pull.ts`) — list timesheets since `last_synced_at`, upsert `time_entry`
**B11:** Sync orchestrator + pg-boss cron (`apps/api/src/jobs/payroll-sync.ts`) — runs hourly per active connection

Tests with nock against Employment Hero sandbox API.

Commits: 4 commits, one per task.

---

### Tasks B12–B14: KeyPay

**Same shape as Employment Hero.** Three tasks (`oauth`+`client`, `employee-sync`+`time-entry-pull`, integration into orchestrator). Tests use KeyPay sandbox.

Commits: 3.

---

### Tasks B15–B17: Deputy

**Same shape.** Three tasks. Deputy uses OAuth 2.0; webhook on time-entry events makes the sync near-real-time vs hourly polling. Recommend keeping it on hourly cron for symmetry with the others; revisit in P9 if real-time becomes a customer ask.

Commits: 3.

---

### Tasks B18–B20: Xero Payroll

**Same shape.** Three tasks. Xero uses OAuth 2.0 with PKCE.

Commits: 3.

---

### Task B21: Time-entry conflict resolution

When manual time entries from mobile (`source='manual'`) overlap with payroll-synced entries (e.g., Jane manually entered 2 hours on Tuesday but payroll later imported her Tuesday timesheet showing 7.5 hours including the 2 hours), payroll wins — manual entries get `flagged_at = NOW()` and surface to consultant for review.

Files: extend payroll-sync job; add `flagged_at` column to `time_entry` via small migration.

Commit: `feat(api): time-entry conflict resolution — payroll wins, manual flagged`

---

### Task B22: Time tracking UI (mobile)

`apps/mobile/app/(authed)/time.tsx` — list view of recent entries (manual + synced), tap to add manual, see synced entries from connected payroll provider in read-only state.

Commit: `feat(mobile): time tracking screen — manual entry + payroll-synced view`

---

### Task B23: Apportionment workbench (consultant portal)

`apps/web/src/app/(authed)/admin/apportionment/page.tsx` — table of time_entries grouped by employee → R&D apportionment percentage per entry → bulk-apply by activity → bulk-apply by date range → audit log of changes.

Commit: `feat(web): apportionment workbench — bulk R&D % apply with audit log`

---

## Swimlane C — Brand + Status (C1–C15)

### Tasks C1–C4: Brand-config UI in consultant portal

**C1:** Page scaffold `apps/web/src/app/(authed)/admin/brand-config/page.tsx` — read brand_config, render edit form
**C2:** Logo upload (S3 pre-signed)
**C3:** Theme picker (color inputs with preview)
**C4:** ToS URL + support email + display name inputs

Each task: zod-validated form via react-hook-form, mutation invalidates `['brand-config', tenant_id]` query.

Commits: 4.

---

### Task C5: Custom subdomain wizard

UI in `/admin/brand-config/domain` lets consultant pick a subdomain (e.g., `acme`) → API validates format + uniqueness → updates `brand_config.custom_subdomain` → tells user to test at `https://acme.platform.com.au`.

Subdomain takes effect immediately because hostname routing is dynamic (no DNS provisioning needed for `*.platform.com.au` — that's our wildcard).

Commit: `feat(web,api): custom subdomain wizard with validation`

---

### Tasks C6–C9: Custom domain wizard + ACME state machine

**C6:** UI for entering custom_domain (e.g., `platform.acmeconsulting.com.au`)
**C7:** API endpoint sets `custom_domain` + `custom_domain_status='cname_pending'`, surfaces required CNAME record to consultant
**C8:** pg-boss cron polls DNS for CNAME validity (every 60s, 1hr timeout)
**C9:** Once CNAME validated → request ACM cert → poll ACM for issued cert → update CloudFront distribution alternative domains → set `custom_domain_status='active'`

Each task: ~1 commit. C8+C9 share state machine code.

Commits: 4.

---

### Tasks C10–C11: Email sender DKIM

**C10:** UI for entering email_sender_domain → display required DKIM TXT records
**C11:** pg-boss cron polls DNS for DKIM validation → updates `email_sender_dkim_status` → SES domain identity attached

Commits: 2.

---

### Task C12: PWA `/claimant/[id]/status` page

Server-component page using cookie-auth (claimant magic-link → session cookie). Renders: claim stage timeline · last 5 events · audit-readiness score (placeholder until D1–D4) · pending RFIs · next steps.

Commit: `feat(web): PWA /claimant/[id]/status — claim stage timeline + recent events`

---

### Task C13: Audit-readiness score viz

`apps/web/src/app/claimant/[id]/score/page.tsx` — gauge chart (0-100), per-rule breakdown, history sparkline (queries `audit_score_snapshot` history). Uses recharts or similar.

Commit: `feat(web): audit-readiness score visualization`

---

### Tasks C14–C15: Mobile branding pull on launch + per-tenant theme injection

**C14:** Mobile fetches brand_config on every cold start (cached via TanStack Query, 24-hour staleTime)
**C15:** Theme injection: primary_color + accent_color → react-native-paper or custom theme tokens; logo URL → splash + header

Commits: 2.

---

## Final phase — D1–D10

### Tasks D1–D4: Audit-readiness scoring engine

**D1:** `packages/audit-score` package bootstrap + 10 rules (per design doc §7.1)
**D2:** `audit_score_snapshot` table migration + schema
**D3:** Score recompute pg-boss job (every 6h per active subject_tenant)
**D4:** Score delta tracking (latest vs 7d-ago for "+10 since last week" UI)

Commits: 4.

---

### Tasks D5–D6: ADRs

**D5:** `docs/decisions/0004-claimant-identity-and-mobile.md` — Magic-link + 90d sessions + mobile JWT audience + offline-queue + server-authoritative chain
**D6:** `docs/decisions/0005-white-label-and-hostname-routing.md` — Hostname → tenant resolution + custom subdomain + custom domain + ACME state machine + DKIM verification

Commits: 2.

---

### Tasks D7–D8: READMEs

**D7:** `apps/mobile/README.md` — Expo setup, EAS build, device testing, debugging, branding
**D8:** `packages/integrations/README.md` — adding a new integration (recipe), webhook verification, OAuth flow, encryption, testing

Commits: 2.

---

### Tasks D9–D10: Final review + first-customer onboarding

**D9:** Final code review across entire P3 implementation (use `superpowers:code-reviewer`)
**D10:** Manual onboarding test with first customer (or simulated test using two devices + sandbox payroll account)

---

## Acceptance criteria (P3 gate)

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm format:check` all green locally
- [ ] CI green on `p3/mobile-scribe` (ci + e2e + Detox jobs)
- [ ] Cold-start: `docker compose down -v && docker compose up -d postgres && pnpm db:migrate && pnpm test` green
- [ ] Manual smoke: invite Jane → magic-link email → open Expo app → record voice → see classified event in portal → upload photo → see in vault with OCR text after async processing → start hypothesis → fill three fields → see HYPOTHESIS event → consultant sends DocuSign engagement letter → Jane signs in app → consultant sees signed PDF → consultant connects Employment Hero sandbox → Jane's timesheet syncs → audit-readiness score visible at 78/100 in PWA
- [ ] Custom domain wizard: configure `platform.acmeconsulting.com.au` → CNAME validated → ACM cert issued → CloudFront updated → live
- [ ] DKIM verification: configure `mail.acmeconsulting.com.au` → records validated → SES configured → test email delivers from custom domain
- [ ] Detox + Playwright e2e suites green
- [ ] Integration sandbox tests pass for DocuSign + EH + KeyPay + Deputy + Xero Payroll
- [ ] ADRs 0004 + 0005 committed
- [ ] All commits include co-author trailer
- [ ] Tag `p3-mobile-scribe` after merge

## Execution

Use `superpowers:subagent-driven-development` for execution. Given the 80-task scope, this is a multi-week execution. The three swimlanes are parallelisable — if multiple implementers are available, A/B/C can run concurrently after Foundation completes.
