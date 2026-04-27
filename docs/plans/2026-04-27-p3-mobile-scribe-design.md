# P3 — Mobile Scribe + Full Module 3 — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to produce the implementation plan from this design.

**Date:** 2026-04-27
**Status:** Approved (decisions Q1–Q7 confirmed live with user; sections 3–7 condensed autonomously per user "you can start" signal)
**Author:** Aaron Newson + AI pair (Claude Opus 4.7 1M)
**Builds on:** [P2 Event Capture Vertical Slice](./2026-04-27-p2-event-capture-design.md) (branch `p2/event-capture`, 36 commits ahead of main)
**Source spec:** [Architecture design §6 P3 row](./2026-04-25-rdti-grants-platform-design.md) + [Omniscient Feature Spec — Module 3 + Pillars](../product/2026-04-27-omniscient-feature-spec.md)
**Modules covered:** Module 3 (Client Mobile App) in full + Module 6 brand-config UI (white-label per Q7d=C) + parts of Module 4 (status dashboard) + parts of Module 5 (DocuSign + 4 payroll integrations)
**Pillars advanced:** All 5 — Pillar 1 (compliance via hypothesis pre-dating fix), Pillar 2 (augmentation — claimant captures evidence at source so consultant doesn't chase), Pillar 3 (AU-native — Deepgram AU region, AU payroll providers), Pillar 4 (closed-system — Deepgram private endpoint, no transcript training), Pillar 5 (white-label — full Q7d=C custom-domain per-firm branding from day one)

---

## 0. Decision summary

| # | Question | Locked decision |
|---|---|---|
| Q1 | Platform | **C** — Hybrid: Expo SDK 51 (capture) + PWA dashboard (`/claimant/...` in existing Next.js) |
| Q2 | Scope | **C** — Full Module 3, all 8 capabilities |
| Q3a | Identity model | **A** — New `subject_tenant_employee` table |
| Q3b | Auth | **A** — Magic-link email |
| Q3c | Session lifetime | **A** — 90 days, device-bound |
| Q4 | Voice transcription | **B** — Deepgram Nova-3 (AU region) |
| Q5 | Media upload | **B** — Pre-signed S3 URL + S3-event-triggered async OCR/scan |
| Q6a | Push provider | **A** — Expo Push |
| Q6b | Repo structure | **A** — `apps/mobile/` in monorepo |
| Q6c | Distribution | **A** — EAS internal (TestFlight + Play Internal) for P3 |
| Q7a | Payroll integrations | **C** — Employment Hero + KeyPay + Deputy + Xero Payroll (all four) |
| Q7b | Doc signing | **A** — DocuSign |
| Q7c | Audit-readiness scoring | **A** — Static rule-set (~10 thresholds) |
| Q7d | White-label scope | **C** — Full: logo + theme + email sender + ToS + custom subdomain + custom domain + per-firm landing pages + ACME cert lifecycle |

**Realistic budget:** ~12-14 weeks (full Module 3 + four payroll integrations + full white-label).

---

## 1. Scope contract

### 1.1 In scope (the demo)

> Consultant invites Jane (engineer at Acme Innovations) via magic-link → Jane opens branded "Acme R&D Logger" Expo app → end-of-day push prompts "30 seconds, what R&D today?" → records voice → Deepgram transcribes → event posts to per-claimant chain → Jane snaps a photo of a reactor schematic, uploads to vault, content-hashed + GPS-tagged → starts a new experiment, hypothesis prompt fires ("predicted outcome / success criteria / uncertainty") → captures pre-experiment state → time-tracking auto-syncs from Employment Hero → consultant sees everything in real-time on portal feed → DocuSign engagement letter goes to Acme's CFO → Acme's CFO logs in to PWA `/claimant/[id]/status` (under firm's white-label brand at `acmeconsulting.platform.com.au`) to see "where is my claim" + audit-readiness score (78/100, +10 since last week).

### 1.2 In scope — what ships

| Layer | Deliverables |
|---|---|
| Schema | 7 new tables: `subject_tenant_employee`, `magic_link_token`, `mobile_session`, `media_artefact`, `time_entry`, `signing_request`, `brand_config` |
| Mobile (`apps/mobile/`) | Daily voice capture (Deepgram) · Evidence vault (camera + doc picker) · Hypothesis prompts · Time tracking · Doc signing UI (DocuSign in-app browser) · Offline queue (SQLite) · White-label theming via brand_config |
| PWA (`/claimant/[id]/...`) | Status dashboard · Audit-readiness score viz · Status timeline · Claimant-side magic-link auth |
| Brand-config UI (consultant portal) | `/admin/brand-config` page · Logo upload · Theme picker · Custom domain wizard with CNAME validation + ACME cert lifecycle |
| API | `/v1/employees/*` (CRUD + invite) · `/v1/auth/magic-link/*` · `/v1/auth/refresh` · `/v1/media/*` · `/v1/time-entries/*` · `/v1/signing/*` · `/v1/audit-score/:claimant_id` · `/v1/brand-config/*` · `/v1/integrations/*/connect` (OAuth start) + `/v1/integrations/*/callback` |
| Integrations (`packages/integrations/`) | Deepgram client · DocuSign client + webhook · Employment Hero + KeyPay + Deputy + Xero Payroll (each: OAuth flow, employee sync, time-entry pull) |
| Async jobs (pg-boss) | Voice transcription · S3-event OCR/scan + virus scan · Audit-score recompute · Magic-link expiry · Payroll sync (hourly) · Daily capture push at 17:30 local · ACME cert provisioning state machine |
| Hostname routing | Edge middleware: hostname → tenant resolution → set tenant context for both Next.js + API |
| Tests | Per-package unit · API integration · Native E2E (Detox) · PWA e2e (Playwright) · Integration tests against sandbox accounts (DocuSign + each payroll provider) |

### 1.3 Out of scope

| Item | Phase |
|---|---|
| Configurable audit-readiness rule editor | P9 |
| Mobile narrative drafter (drafter agent in mobile) | P5 |
| Federation / financier surfaces | P8 |
| Public App Store + Google Play distribution | P4 |
| Per-firm AI fine-tune | P10+ |
| Bulk QR-code claimant onboarding | P3.5 |
| SMS OTP authentication for no-email cohort | P3.5 |
| Self-hosted Whisper on DGX (sovereign inference) | P9 |

### 1.4 Package additions

```
apps/mobile/                                    # NEW Expo SDK 51 project
  app.json, eas.json, babel.config.js, metro.config.js
  src/screens/{capture,vault,hypothesis,time,signing,status,settings}.tsx
  src/components/, src/hooks/
  src/db/                                        # local SQLite via expo-sqlite
    schema.ts (mobile_event_queue, media_blob_cache, etc.)
    migrations.ts
  src/sync/                                      # offline queue worker
    queue.ts, sync-worker.ts, conflict-handler.ts
  src/auth/                                      # magic-link redemption + refresh
  src/branding/                                  # theme injection from brand_config API
  src/api-client/                                # typed fetch helpers
  app/(unauthed)/login.tsx, app/(authed)/[...].tsx (Expo Router)

apps/web/src/app/claimant/[claimant_id]/        # NEW PWA routes
  layout.tsx (claimant-auth gate via cookie)
  status/page.tsx
  score/page.tsx
  rfi/[rfi_id]/page.tsx (sign + respond)

apps/web/src/app/(authed)/admin/brand-config/   # NEW consultant-portal route
  page.tsx (logo + theme + ToS)
  domain/page.tsx (custom subdomain + custom domain wizard)
  email-sender/page.tsx (DKIM verification flow)

apps/api/src/routes/                            # NEW route plugins
  employees.ts, magic-link.ts, mobile-session.ts,
  media.ts, time-entries.ts, signing.ts,
  audit-score.ts, brand-config.ts, integrations.ts
apps/api/src/middleware/                        # NEW
  hostname-tenant-resolver.ts                    # firm.platform.com.au → tenant_id
  mobile-jwt-verifier.ts                         # claimant-side JWT (different audience)
apps/api/src/jobs/                              # NEW pg-boss handlers
  transcribe.ts, ocr-scan.ts, payroll-sync.ts,
  audit-score-recompute.ts, daily-capture-push.ts,
  acme-cert-state-machine.ts, magic-link-expiry.ts

packages/integrations/                          # NEW package
  src/runtime/{oauth,webhook-verify,retry,rate-limit}.ts
  src/deepgram/client.ts
  src/docusign/{client,webhook}.ts
  src/payroll/{employment-hero,keypay,deputy,xero-payroll}/
    {client,oauth,employee-sync,time-entry-pull}.ts

packages/db/migrations/0008-0014_*.sql          # 7 migrations
packages/schemas/src/{employee,media,time-entry,signing,audit-score,brand-config,magic-link}.ts

docs/decisions/0004-claimant-identity-and-mobile.md  # NEW ADR
docs/decisions/0005-white-label-and-hostname-routing.md  # NEW ADR
```

---

## 2. Data model

### 2.1 Tables (full schemas in writing-plans output)

**`subject_tenant_employee`** — claimant-side humans
- `(id, subject_tenant_id, tenant_id, email, name, job_title, payroll_external_id?, payroll_provider?, invited_at, invited_by_user_id, first_seen_at?, last_seen_at?, deactivated_at?)`
- `tenant_id` denormalised for index-friendly RLS (same pattern as P2 `event`)
- Unique `(subject_tenant_id, email) WHERE deactivated_at IS NULL`

**`magic_link_token`** — single-use, 15-min auth bootstrap
- `(id, employee_id, token_hash [SHA-256], expires_at, consumed_at?, created_at)`
- Raw token never stored

**`mobile_session`** — long-lived refresh-token state
- `(id, employee_id, device_fingerprint, refresh_token_hash, expires_at [90d], last_refreshed_at, revoked_at?, created_at)`
- Refresh-on-use extends 90-day window; consultant can revoke from portal

**`media_artefact`** — vault uploads
- `(id, tenant_id, subject_tenant_id, event_id?, uploaded_by_employee_id, s3_key, content_hash, mime_type, size_bytes, exif, ocr_text?, ocr_status, virus_scan_status, uploaded_at)`
- Unique `(tenant_id, subject_tenant_id, content_hash)` — same content uploaded twice = single row
- RLS on `tenant_id`

**`time_entry`** — payroll-synced or manual
- `(id, tenant_id, subject_tenant_id, employee_id, source ['manual'|'employment_hero'|'keypay'|'deputy'|'xero_payroll'], external_id?, started_at, ended_at, duration_minutes, is_rd, apportionment_pct?, apportioned_by_user_id?, apportioned_at?, notes?, created_at)`
- Unique `(source, external_id) WHERE external_id IS NOT NULL` for payroll-row dedupe

**`signing_request`** — DocuSign integration
- `(id, tenant_id, subject_tenant_id, initiated_by_user_id, recipient_employee_id?, recipient_email, document_kind ['engagement_letter'|'representation_letter'|'rfi_response'|'custom'], document_template_id?, docusign_envelope_id [unique], status ['sent'|'delivered'|'completed'|'declined'|'voided'|'expired'], signed_at?, signed_pdf_s3_key?, signed_pdf_content_hash?, created_at, updated_at)`

**`brand_config`** — white-label per firm (Q7d=C: full)
- `(tenant_id [PK], display_name, logo_s3_key?, primary_color, accent_color, email_sender_domain?, email_sender_dkim_status, support_email?, terms_of_service_url?, custom_subdomain? [unique], custom_domain? [unique], custom_domain_acm_arn?, custom_domain_status ['unconfigured'|'cname_pending'|'cert_pending'|'active'|'failed'], landing_page_config jsonb, created_at, updated_at)`
- Custom-domain lifecycle is a state machine handled by pg-boss jobs

### 2.2 RLS

- All P3 tables with `tenant_id` carry the same FORCE RLS policy as P2:
  ```sql
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  ```
- `magic_link_token` is NOT RLS-scoped (token_hash is the secret; lookup is by hash, no tenant context yet at redemption time)
- `mobile_session` is NOT directly RLS-scoped — accessed via employee_id which IS RLS-scoped
- `brand_config` IS RLS-scoped on `tenant_id` (PK)

### 2.3 Mobile-side SQLite (NOT Postgres)

**`mobile_event_queue`** — offline capture queue
```ts
type MobileQueueRow = {
  local_id: string;                  // uuid generated client-side
  kind: 'event' | 'media_artefact' | 'time_entry' | 'signing_response';
  payload: string;                   // JSON
  created_at: number;                // ms epoch on device
  status: 'queued' | 'syncing' | 'synced' | 'failed';
  remote_id?: string;
  retry_count: number;
  last_error?: string;
};
```

Server-authoritative chain: mobile never knows prev_hash; server appends in `received_at` order at sync time per architecture §7 risk #3.

---

## 3. Authentication + session flows

### 3.1 Magic-link bootstrap

```
[Consultant portal: invites Jane via /v1/employees/:id/invite]
   ↓ generates 256-bit random token, stores hash, sends email
   ↓ email link: https://[firm-brand]/m/auth?t=<raw-token>
[Jane taps link on phone]
   ↓ universal/app link → Expo app opens at /auth/redeem?t=<raw-token>
   ↓ POST /v1/auth/magic-link/redeem { token, device_fingerprint }
   ↓ server: lookup token_hash, check not expired/consumed, mark consumed
   ↓ create mobile_session row with refresh_token_hash + 90-day expiry
   ↓ return { access_token (1hr JWT), refresh_token, employee_profile, brand_config }
[Mobile stores refresh_token in expo-secure-store; access_token in memory]
```

### 3.2 Refresh

```
[Access token expires]
   ↓ POST /v1/auth/refresh { refresh_token, device_fingerprint }
   ↓ server: lookup refresh_token_hash, verify device match, not revoked
   ↓ rotate refresh_token (issue new, mark old hash superseded)
   ↓ return new { access_token, refresh_token }
```

### 3.3 PWA claimant auth

PWA `/claimant/[id]/...` uses the same magic-link mechanism but issues a session cookie (httpOnly, sameSite=Lax, 90-day). PWA + mobile share `magic_link_token` table.

### 3.4 Mobile JWT shape

```ts
{
  sub: employee_id,
  aud: 'mobile',                    // distinct from consultant 'web' audience
  tenant_id, subject_tenant_id,
  iat, exp (1hr)
}
```

API middleware `mobile-jwt-verifier.ts` rejects tokens with `aud !== 'mobile'` and sets `req.user = { kind: 'employee', employeeId, tenantId, subjectTenantId }`.

---

## 4. Mobile app architecture (Expo SDK 51)

### 4.1 Core dependencies

- `expo` (SDK 51), `expo-router`, `expo-sqlite`, `expo-secure-store`, `expo-notifications`, `expo-camera`, `expo-document-picker`, `expo-file-system`, `expo-av` (audio recording), `expo-network`, `expo-application`
- `@tanstack/react-query` (server state), `zustand` (local state), `react-hook-form` + `zod` (forms)
- `@cpa/schemas` (workspace), `react-native-reanimated` (animations)

### 4.2 Screen tree (Expo Router)

```
app/(unauthed)/login.tsx                # magic-link landing + redeem
app/(authed)/_layout.tsx                # auth gate + brand theme provider
app/(authed)/index.tsx                  # daily prompt (capture CTA + recent events)
app/(authed)/capture/voice.tsx          # voice recording
app/(authed)/capture/photo.tsx          # camera + EXIF capture
app/(authed)/capture/document.tsx       # doc picker
app/(authed)/hypothesis.tsx             # pre-experiment hypothesis prompt
app/(authed)/time.tsx                   # time tracking entries (manual + payroll-synced view)
app/(authed)/signing/[id].tsx           # in-app DocuSign browser
app/(authed)/status.tsx                 # claim status (mirrors PWA)
app/(authed)/settings.tsx               # profile, push toggle, sign out
```

### 4.3 Offline queue + sync

- All capture writes hit local SQLite first (`mobile_event_queue`)
- Background `sync-worker.ts` (uses `expo-task-manager` for iOS background fetch + `expo-network` for online detection) drains queue when online
- Each sync call uses `local_id` as idempotency key on the API (same pattern as P2 events)
- Failed syncs retry with exponential backoff up to 5 attempts, then surface to user with manual-retry CTA

### 4.4 Brand theming

On every app launch (and login), mobile fetches `GET /v1/brand-config/by-tenant/:id` and caches in SQLite. Theme provider applies `primary_color`, `accent_color`, displays `logo_s3_key` (downloaded + cached). App icon + splash screen are baked at EAS build time per-tenant — for v1, we ship a single neutral icon and let the white-label happen in-app; per-tenant icons land in P3.5.

---

## 5. Integrations architecture

### 5.1 `packages/integrations/` shape

```
packages/integrations/
  src/runtime/
    oauth.ts                              # PKCE flow, token storage in agent_call_cache-like table
    webhook-verify.ts                     # signature verification per provider
    retry.ts                              # exponential backoff with jitter
    rate-limit.ts                         # token-bucket per integration per tenant
    types.ts
  src/deepgram/client.ts                  # POST /v1/listen with audio bytes
  src/docusign/
    client.ts                             # envelope create, document download
    webhook.ts                            # signed webhook handler
  src/payroll/employment-hero/
    oauth.ts, client.ts, employee-sync.ts, time-entry-pull.ts
  src/payroll/keypay/...                  # same shape
  src/payroll/deputy/...
  src/payroll/xero-payroll/...
```

### 5.2 OAuth state storage

New table `integration_connection`:
```ts
(tenant_id, provider, access_token_encrypted, refresh_token_encrypted,
 expires_at, scopes [text[]], external_account_id, last_synced_at,
 sync_state ['idle'|'syncing'|'failed'], last_error?, created_at)
```

Tokens encrypted-at-rest (Postgres `pgcrypto`, KMS key in production).

### 5.3 Payroll sync

pg-boss cron job `payroll-sync` runs hourly per `(tenant_id, provider)`:
1. Refresh OAuth token if needed
2. List employees changed since `last_synced_at`
3. List time entries changed since `last_synced_at`
4. Upsert `subject_tenant_employee` (matched by `payroll_external_id` + `payroll_provider`)
5. Upsert `time_entry` (matched by `(source, external_id)`)
6. Update `last_synced_at`

Conflict resolution: payroll wins (source-of-truth for hours worked); manual time entries are flagged and reviewed by consultant.

### 5.4 DocuSign webhook

POST `/v1/integrations/docusign/webhook` with HMAC verification per DocuSign spec → updates `signing_request.status` + downloads completed PDF to S3 → optionally appends a `SUPPORTING` event to the per-claimant chain referencing the signed artefact.

---

## 6. Hostname-based tenant resolution + custom-domain lifecycle

### 6.1 Edge middleware

Both Next.js (apps/web) and Fastify (apps/api) run a request-level middleware:

```
1. Read Host header
2. If host matches /(.*)\.platform\.com\.au/ → look up brand_config WHERE custom_subdomain = $1
3. If host doesn't match default suffix → look up brand_config WHERE custom_domain = $1
4. Set req.brand = { tenant_id, ... } and req.activeTenantId for downstream handlers
5. If no match → return 404 "unknown brand" (mostly defensive; DNS shouldn't route to us if we don't know the host)
```

### 6.2 Custom-domain lifecycle (state machine)

```
unconfigured
  ↓ consultant enters custom_domain in /admin/brand-config/domain
cname_pending
  ↓ pg-boss job polls DNS every 60s for the expected CNAME (CNAME → platform-cnames.platform.com.au)
  ↓ once CNAME validated:
cert_pending
  ↓ ACM cert request submitted; pg-boss polls ACM every 5min for validation status
  ↓ ACM validates via DNS-01 (the CNAME record we already validated has the validation token in a TXT record)
  ↓ once issued:
active
  ↓ CloudFront distribution updated to include the new alternative domain
  ↓ brand_config.custom_domain_acm_arn populated
  ↓ requests on custom_domain start working

failed (terminal) at any step → consultant sees error in admin UI with remediation hint
```

### 6.3 Email sender DKIM verification (Q7d=C)

Similar state machine for `email_sender_domain`:
- `unconfigured` → consultant enters domain → DKIM TXT records published to consultant's DNS
- `pending` → pg-boss polls DNS for DKIM TXT
- `verified` → SES (or equivalent) configured to use the domain as sender
- `failed` → error surface

---

## 7. Audit-readiness scoring engine

### 7.1 Static rules (Q7c=A)

`packages/audit-score/src/rules.ts`:

```ts
export const SCORING_RULES: Rule[] = [
  { id: 'has_recent_capture',         max_pts: 10, fn: (st, evs) => recentEventInLast7Days(evs) ? 10 : 0 },
  { id: 'hypothesis_per_core',        max_pts: 15, fn: ... },     // per spec — Body by Michael fix
  { id: 'no_30day_gap',               max_pts: 10, fn: ... },
  { id: 'every_event_has_artefact',   max_pts: 15, fn: ... },     // contemporaneous evidence
  { id: 'time_tracking_active',       max_pts: 10, fn: ... },     // payroll integration active OR ≥1 time_entry/wk
  { id: 'apportionment_complete',     max_pts: 10, fn: ... },
  { id: 'engagement_letter_signed',   max_pts: 10, fn: ... },
  { id: 'classifier_avg_confidence',  max_pts: 10, fn: ... },     // mean confidence across last 30d
  { id: 'override_rate_low',          max_pts: 5,  fn: ... },     // <30% override rate is healthy
  { id: 'evidence_kinds_diverse',     max_pts: 5,  fn: ... },     // ≥4 distinct kinds in last 30d
];
// Total max 100
```

### 7.2 Score recompute job

pg-boss cron job `audit-score-recompute` runs every 6hr per active subject_tenant:
1. Pull last 90 days of events + time_entries + signing_requests for the claimant
2. Run each rule, accumulate points
3. Write to a new `audit_score_snapshot` table: `(subject_tenant_id, computed_at, total_pts, rule_breakdown jsonb)`
4. Mobile + PWA query latest snapshot

Snapshot history powers the "+10 since last week" delta in the PWA dashboard.

---

## 8. Telemetry, testing, sequencing, operational concerns

### 8.1 Sequencing inside P3 (~12-14 weeks)

Three parallelisable swimlanes after a 2-week foundation:

**Foundation (W14-W15, sequential)** — schema + migrations + auth (magic-link + JWT + sessions) + hostname routing + Expo project bootstrap

**Swimlane A — Capture loop (W16-W19, sequential, single-implementer)**
- Voice capture + Deepgram + classifier (extends P2 flow)
- Evidence vault + S3 pre-signed + OCR async
- Hypothesis prompts
- Daily push
- Offline queue + sync worker

**Swimlane B — Integrations (W16-W22, parallel-friendly, can split across implementers)**
- DocuSign client + webhook + signing UI
- Employment Hero (4-5d)
- KeyPay (4-5d)
- Deputy (4-5d)
- Xero Payroll (4-5d)

**Swimlane C — Brand + Status surfaces (W18-W23, parallel-friendly)**
- Brand-config UI in consultant portal
- Custom subdomain wizard
- Custom domain wizard (CNAME + ACME state machine)
- Email sender DKIM verification flow
- PWA `/claimant/[id]/status` + audit-readiness viz
- Mobile branding pull on launch

**Final (W23-W26)** — audit-readiness rules + recompute job + e2e + Detox + integration tests + ADRs + READMEs + first-customer onboarding

### 8.2 OTel attributes (extends P2 conventions)

New `cpa.*` span attributes:
- `cpa.employee_id`, `cpa.session_id`, `cpa.device_fingerprint`
- `cpa.upload.content_hash`, `cpa.upload.size_bytes`, `cpa.upload.mime_type`
- `cpa.payroll.provider`, `cpa.payroll.sync_state`, `cpa.payroll.entries_synced`
- `cpa.docusign.envelope_status`
- `cpa.audit_score.total`, `cpa.audit_score.rule_id`, `cpa.audit_score.delta`
- `cpa.brand.custom_domain_status`

### 8.3 Testing strategy

- **Unit**: per package (db, agents, integrations, audit-score)
- **API integration**: per route file with Postgres + nock for upstream
- **Detox** (mobile e2e): voice capture flow, vault upload flow, hypothesis flow, offline queue sync, magic-link redemption
- **Playwright** (PWA e2e): claimant magic-link login, status dashboard render, audit-score visible
- **Integration tests against sandbox accounts** for DocuSign + each payroll provider (run nightly, not on every commit)

### 8.4 Operational concerns

- **PII**: voice recordings + transcripts are PII. Encrypt at rest in S3 (SSE-KMS); 90-day TTL on audio bytes (transcript persists); document in privacy policy
- **Rate limits**: Deepgram has per-minute concurrency; token-bucket per tenant
- **Cost**: Deepgram ~$0.0043/min; at 5 voice notes/employee/day × 60 sec each × 20 employees per claimant × 250 working days = ~$3.20/claimant/year. Trivial compared to A$300-600/claimant ARR.
- **Push notification opt-out**: respect platform settings; surface toggle in mobile settings
- **Custom domain SSL renewals**: ACM auto-renews; pg-boss cron monitors expiry and re-validates if needed

### 8.5 Documentation

- ADR-0004 — Claimant identity model + magic-link auth + mobile JWT audience separation
- ADR-0005 — White-label hostname routing + ACME cert lifecycle
- `apps/mobile/README.md` — Expo setup, EAS build, device-testing
- `packages/integrations/README.md` — adding a new payroll/signing provider (recipe)

---

## 9. Risks & watch-outs (P3-specific)

1. **Apple TestFlight build approval gates** — even internal distribution requires basic App Store review. Budget 1-2 day round-trips per binary submission. *Mitigation*: ship feature-complete to TestFlight in W23; rough binary in W18 to surface issues early.
2. **Deepgram AU region availability disruption** — single-region AU dependency. *Mitigation*: graceful degradation — failed transcription queues for manual transcript entry by employee; consultant can also paste manually (P2 path still works).
3. **Custom-domain DNS misconfiguration** — consultant points DNS wrong, customers see broken brand. *Mitigation*: state machine enters `failed` with clear remediation hint; "use the platform.com.au subdomain in the meantime" fallback always works.
4. **Magic-link token leak** — single-use + 15-min expiry mitigates most cases; revocation on consultant side from portal as belt-and-braces.
5. **Payroll provider API breaking changes** — each integration has its own update cadence. *Mitigation*: `last_synced_at` + Sentry-style alerting on sync failures; integration tests against sandbox accounts run nightly.
6. **Mobile app size bloat** — Expo + native modules can balloon. *Mitigation*: monitor bundle size in CI; lazy-load heavy modules (camera, signing browser) on first use.

---

## 10. Next step

Invoke `superpowers:writing-plans` skill to produce a task-by-task implementation plan for the foundation phase + three swimlanes. Then `superpowers:subagent-driven-development` for execution.
