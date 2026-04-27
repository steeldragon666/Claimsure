# ADR-0004: Claimant Identity, Magic-Link Auth & Mobile Session

**Status:** Accepted
**Date:** 2026-04-27
**Authors:** Aaron Newson + AI pair (Claude Opus 4.7 1M)
**Builds on:** [ADR-0001](./0001-monorepo-and-stack.md), [ADR-0002](./0002-identity-and-tenancy.md), [ADR-0003](./0003-event-chain-and-classifier.md)
**Source brainstorm:** [P3 design](../plans/2026-04-27-p3-mobile-scribe-design.md)

## Context

P0–P2 modelled one identity population: consultant-firm staff signing in via
OIDC (Microsoft Entra ID + Google Workspace) and operating against the
consultant portal. P3 introduces a second, structurally distinct identity
population — **claimant employees**: the engineers, lab technicians, and other
R&D-active staff who work _at_ the claimant company, not at the consultancy.

These are the people the product spec calls "Jane the engineer" and "Bob the
lab tech". They are the natural source of contemporaneous evidence — Pillar 2
of the product spec is "augmentation: claimant captures evidence at source so
the consultant doesn't chase". Without them as first-class principals, every
piece of evidence has to flow through a consultant intermediary, which both
delays capture (defeating the contemporaneity test on §355-25 audits) and
inflates consultant labour cost (defeating the augmentation pillar).

Claimant employees are not in their firm's OIDC tenant. They are not in the
consultancy's OIDC tenant either. Their auth surface needs to be:

- **Mobile-friendly first** — the capture device is a phone in a lab, not a
  laptop at a desk.
- **Bootstrap-able with no admin involvement** beyond the consultant typing
  in an email address.
- **Long-lived** — once Jane is set up, she shouldn't have to re-authenticate
  every week.
- **Revocable** — when Jane leaves Acme Innovations, the consultant must be
  able to kill her access from the portal without contacting an IdP admin.

This ADR captures the identity-model and auth decisions that propagate into
every API surface the mobile app touches and every PWA claimant page
(`/claimant/[id]/...`). It is the third identity layer on top of ADR-0002:
consultants (firm-side) → claimants-as-firms (`subject_tenant`) → claimant
employees (`subject_tenant_employee`).

## Decision

### Separate `subject_tenant_employee` table (Q3a)

Claimant employees live in a new table, not in the existing `user` table.

- **`subject_tenant_employee`** carries `(id, subject_tenant_id, tenant_id,
email, name, job_title, payroll_external_id?, payroll_provider?,
invited_at, invited_by_user_id, first_seen_at?, last_seen_at?,
deactivated_at?)`.
- `tenant_id` is **denormalised** alongside `subject_tenant_id` for
  index-friendly RLS — the same defense-in-depth pattern P2's `event` table
  uses (ADR-0003 Q6). The RLS policy is a single column lookup
  (`tenant_id = current_setting(...)`), not a subquery through
  `subject_tenant`.
- The unique-email index is **partial** (`WHERE deactivated_at IS NULL`) so
  reactivation works: a deactivated row can sit alongside a new active row
  for the same email without violating uniqueness.
- `payroll_external_id` + `payroll_provider` form the matching key for the
  payroll-sync upsert path (P3 design §5.3 step 4) — both nullable since a
  firm may have no payroll integration yet, or an employee may be created
  manually before being linked.

### Magic-link email authentication (Q3b)

Claimant employees authenticate via a single-use, time-bounded **magic-link
token** delivered to their email. No password. No IdP federation in P3.

- **`magic_link_token`** carries `(id, employee_id, token_hash, expires_at,
consumed_at?, created_at)`. The raw 256-bit token is sent ONCE in the
  invite email; only its hex SHA-256 hash is stored.
- **15-minute expiry**. Single-use. `consumed_at` flips on first successful
  redeem; subsequent attempts fail.
- **No RLS scoping** on `magic_link_token`. Redemption happens before any
  tenant context is available — the token IS the auth signal. Lookup is by
  `token_hash` (the secret itself); cross-tenant data leak is impossible
  because the only field accessible without the hash is the row that proves
  you already have it.
- **Two redemption surfaces share the table**:
  - Mobile redemption (`POST /v1/auth/magic-link/redeem`) returns an
    access/refresh-token pair (see below).
  - PWA claimant redemption (`POST /v1/claimant/auth/magic-link/redeem`)
    sets a session cookie.
  - The token row is consumed by whichever surface gets there first; the
    employee can open the link on phone OR laptop, not both. This is
    intentional — the magic link is the universal bootstrap signal.

### 90-day device-bound `mobile_session` (Q3c)

Mobile auth is a two-token model: short-lived access token + long-lived
device-bound refresh token.

- **`mobile_session`** carries `(id, employee_id, device_fingerprint,
refresh_token_hash, expires_at, last_refreshed_at, revoked_at?,
created_at, push_token?)`.
- **90-day sliding window** on the refresh token. Each successful refresh
  rotates the token (issues a new one, supersedes the old hash) and bumps
  `expires_at` 90 days from now and `last_refreshed_at` to now.
- **Device-bound**: `device_fingerprint` is captured at first redeem and
  verified on each refresh. Mismatched fingerprint → revoke. Stops a
  stolen refresh-token from working on a different device.
- **Refresh-token rotation** is a state machine: at any moment exactly one
  hash is "current" for a given session row; the old hash is replaced
  atomically inside the refresh transaction. A replay of the old token
  fails the lookup. A "race" where two requests refresh concurrently
  resolves to one winner (whichever commits first); the loser's refresh
  fails and the user is forced to sign in again — acceptable because the
  alternative (accepting both rotations) would let an attacker race against
  the legitimate user with a leaked old token.
- **Revocation centralised on the consultant portal**. A consultant can
  revoke any employee's session (`UPDATE mobile_session SET revoked_at =
NOW()`) from the admin UI. The next access-token verify for that
  employee's session fails the `revoked_at IS NULL` check and they are
  forced to re-redeem.
- **Not directly RLS-scoped**. Sessions are always accessed via
  `employee_id`, and `subject_tenant_employee` IS RLS-scoped, so the join
  enforces tenant isolation transitively. Direct lookups by
  `refresh_token_hash` happen during refresh BEFORE any tenant context is
  set (the hash is the secret), so RLS would hide the row a legitimate
  refresh needs.
- **`push_token`** column carries the Expo Push token registered by the
  device. Updated whenever the device reports a new token via
  `/v1/push-token`. Used by the daily-capture push job (P3 §A12-A13).

### Audience-separated JWTs

The same `SESSION_JWT_SECRET` (HS256) signs all three session shapes, but
the JWT `aud` claim partitions them so a token from one surface cannot be
replayed at another:

| Surface                        | Audience       | Carrier                   | Lifetime                |
| ------------------------------ | -------------- | ------------------------- | ----------------------- |
| Consultant portal (web)        | `cpa-api`      | httpOnly cookie           | per ADR-0002 session    |
| Claimant PWA (`/claimant/...`) | `pwa-claimant` | httpOnly cookie           | 90 days                 |
| Mobile native app              | `mobile`       | `Authorization: Bearer …` | 1h access + 90d refresh |

API middleware verifies audience on every request:

- `requireSession` (consultant) accepts only `aud === 'cpa-api'`.
- `requireMobileSession` accepts only `aud === 'mobile'`.
- The PWA-claimant route handler accepts only `aud === 'pwa-claimant'`.

Audience separation has two concrete payoffs:

1. **A leaked consultant cookie cannot be replayed at the mobile API.**
   The mobile API's RLS context is set from `subject_tenant_id` in the JWT,
   not the consultant's `availableTenants[]`; without `aud='mobile'` the
   request 401s.
2. **A stolen mobile bearer token cannot be replayed at the consultant
   portal.** Mobile JWTs have neither the consultant's role grants nor the
   `availableTenants[]` claim the portal expects.

The audience tag is the single line of defense that keeps these surfaces
separate without forking the JWT key material — three keys would triple
the rotation cost without strengthening the boundary, since a key
compromise is already game-over for everything signed with it.

### Mobile carries `Bearer …`, web carries cookies

Mobile cannot use cross-site cookies on a fresh native-app load — there is
no in-process browser to set the cookie, and the universal-link redemption
is parsed by the OS, not by Safari/Chrome. Cookies on `Set-Cookie` would
land in some webview's storage, not the React Native runtime.

The mobile redemption response therefore includes the access + refresh
tokens in JSON. The app stores `refresh_token` in `expo-secure-store`
(Keychain on iOS, Keystore-backed EncryptedSharedPreferences on Android)
and keeps `access_token` in memory only.

The PWA on `/claimant/...` is browser-resident and uses the standard
httpOnly + sameSite=Lax + secure-in-prod cookie pattern. Same redemption
flow, different transport.

## Consequences

**Positive**

- Clean separation of consultant + claimant identity spaces. The
  consultant-side `user`/`tenant_user` join graph stays exactly as ADR-0002
  defined it; claimant employees are a parallel population that never
  appears in admin-portal user lists or audit-log "who could have edited
  this" queries against consultant tables.
- Mobile JWT cannot be reused for portal access (audience mismatch).
  Defense-in-depth against the most realistic theft scenario: a leaked
  device token.
- 90-day refresh window matches the "your firm's branded app" UX
  expectation. Asking Jane to sign in once a quarter is acceptable; asking
  her every week would mean she never opens the app.
- Revocation centralised on the consultant portal — when an employee
  leaves, the consultant clicks "revoke device" and the session dies on
  next refresh. No IdP-admin email round-trip; no need for the claimant's
  own IT team to be in the loop.
- Magic link is genuinely passwordless from the employee's perspective:
  email → tap → in. No app store sign-up, no password reset flow.

**Negative**

- More schema. Three new tables (`subject_tenant_employee`,
  `magic_link_token`, `mobile_session`) plus the `push_token` column on
  the session. Each adds RLS surface area and migration weight.
- Refresh-token rotation requires a careful state machine. The race
  condition (two concurrent refreshes by the same legitimate device — e.g.
  app backgrounded mid-refresh) resolves to "one wins, one fails", which
  forces a re-redeem. We've accepted this; a more permissive design would
  weaken the leaked-token-replay defense.
- Magic-link emails are a third auth surface to maintain alongside OIDC
  and (later) SSO. Each surface has its own bootstrap UX, its own bounce
  handling, and its own rate-limit rules.
- DKIM-verified per-firm sender adds operational complexity (see
  ADR-0005). A dev-mode console-stub email sender is the v1 fallback,
  but production needs SES wiring (P9-ish).
- The `refresh_token` round-trip is over HTTPS and stored in
  Keychain/Keystore — secure, but a rooted/jailbroken device defeats the
  storage layer. This is the standard mobile-auth threat model; we are
  not in a position to defend against it without hardware attestation,
  which is an enterprise-grade feature deferred indefinitely.

**Reviewable in P3.5 / P4+**

- **Per-claimant ACL on read**. Currently any consultant in the firm can
  see any claimant's events via the existing `subject_tenant_user` join.
  When multi-consultant access becomes a real ask (e.g. junior consultant
  scoped to one claimant; senior to all), revisit `subject_tenant_user`
  and add a per-employee read-grant primitive. The schema is already
  shaped for it (ADR-0002 defines `subject_tenant_user`); this is purely
  a policy decision deferred until product demand surfaces.
- **Push-token rotation hygiene**. Today `push_token` is overwritten on
  re-register; we don't keep history. If we ever need to send a "device
  changed" notice to the previous token, the column needs to grow into a
  small table. Likely never needed, flagging anyway.
- **Background-refresh scheduling** in the mobile app. v1 refreshes
  on-access (when an API call returns 401). A background refresh task
  via `expo-background-fetch` would prevent a cold-start latency spike
  on the morning's first capture; deferred until UX feedback confirms
  it's a real friction.

## Alternatives considered

- **Reuse the `user` table with a `user_type` column**. Rejected. The
  consultant admin portal lists users in tables, search bars, and access
  audits — every place that touches the user table would need a
  `WHERE user_type = 'consultant'` filter, and any forgotten filter would
  leak claimant employees into consultant-facing UI. The two populations
  also diverge structurally: claimants have `payroll_external_id` and
  `subject_tenant_id`; consultants have `tenant_user.role` and
  `availableTenants[]`. Forcing them into one shape would mean nullable
  columns on both sides and lots of "this column only applies to this
  type" implicit invariants.
- **Polymorphic FK on event (`event.captured_by_user_id` OR
  `event.captured_by_employee_id`, with a `kind` discriminator)**.
  Rejected. Every read path that resolves "who captured this" would need
  a CASE branch or a UNION across two joins, both of which fight the
  query optimiser and obscure EXPLAIN plans on the hot feed query.
  Better: keep the event row's `captured_by_*` columns aligned to the
  capture surface (consultant paste → `captured_by_user_id`; mobile sync
  → `captured_by_employee_id`), and present the unified "captured by"
  in the read DTO.
- **SMS OTP instead of email magic link**. Deferred to P3.5 for the
  no-email cohort. SMS opens a third bootstrap surface that needs its
  own provider (Twilio + Australian carrier toll), its own rate-limit
  shape, and its own fraud surface (SIM swap). Email is universal
  enough for the early-adopter consultant firms and lets us validate
  the magic-link flow once before adding SMS.
- **QR-code bulk onboarding** (consultant generates one QR; multiple
  employees scan to bootstrap). Deferred to P3.5. Bulk onboarding
  requires a different invariance (the QR is reusable until revoked,
  not single-use) and raises a phishing concern (any QR captured in
  passing redeems). Worth the complexity once a single firm needs to
  onboard 50+ employees in a session — not worth it for the first
  consultancies (typical onboarding flow: one engineer at a time).
- **No refresh tokens (long-lived access token only)**. Rejected. A 90-day
  bearer token in a network log is a much bigger problem than a
  short-lived access token + a Keychain-stored refresh token. Standard
  industry practice; we follow it.
- **OIDC federation for claimants** (e.g. Microsoft Entra B2C). Rejected
  for P3. The claimant firms are mostly SMEs with no existing identity
  surface a consultant can federate against; building a claimant-side
  IdP is a P9+ enterprise-feature.

## References

- [P3 design §3 (auth flows) + §4 (mobile architecture)](../plans/2026-04-27-p3-mobile-scribe-design.md)
- [P3 design Q3 brainstorm — identity model decision](../plans/2026-04-27-p3-mobile-scribe-design.md)
- [ADR-0002 — Identity and tenancy](./0002-identity-and-tenancy.md) (consultant-side primitives this ADR builds on)
- [ADR-0003 — Event chain and classifier](./0003-event-chain-and-classifier.md) (the `tenant_id`-denormalised RLS pattern this ADR reuses)
- Migration `0008_funny_kid_colt.sql` — `subject_tenant_employee`, `magic_link_token`, `mobile_session`, `push_token` column on session, RLS policies
- `apps/api/src/middleware/mobile-jwt-verifier.ts` — audience verification (`MOBILE_AUDIENCE = 'mobile'`)
- `apps/api/src/routes/magic-link.ts` — F7 mobile redemption (issues `aud='mobile'` access + 90-day refresh)
- `apps/api/src/routes/claimant-magic-link.ts` — C11 PWA redemption (issues `aud='pwa-claimant'` cookie session)
- `apps/api/src/routes/mobile-session.ts` — F8 refresh-rotation state machine
- RFC 6749 §6 — OAuth 2.0 refresh-token rotation
- Income Tax Assessment Act 1997, Division 355 — statutory anchors for "contemporaneous evidence"
