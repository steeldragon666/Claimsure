# 02 — Engagement Letter API

**Depends on:** 01 (migration)

## Goal

Six endpoints under `/v1/engagement/**` that drive the engagement lifecycle. All RLS-scoped except the token-gated public sign endpoint.

## Files to add

- `apps/api/src/routes/engagement/index.ts` — export `registerEngagementRoutes(app)`
- `apps/api/src/routes/engagement/send.ts` — `POST /v1/claims/:id/engagement/send`
- `apps/api/src/routes/engagement/sign.ts` — `POST /v1/engagement/[token]/sign` (public, token-gated)
- `apps/api/src/routes/engagement/countersign.ts` — `POST /v1/engagement/:id/countersign`
- `apps/api/src/routes/engagement/decline.ts` — `POST /v1/engagement/[token]/decline` (public)
- `apps/api/src/routes/engagement/get.ts` — `GET /v1/engagement/:id` (admin view)
- `apps/api/src/routes/engagement/get-by-token.ts` — `GET /v1/engagement/[token]` (public, for mobile + web fallback to render the letter)
- `apps/api/src/lib/render-template.ts` — pure function: `renderTemplate(md: string, vars: Record<string,string>): string` — `{{var}}` substitution
- `apps/api/src/lib/token.ts` (if not present) — `generateOpaqueToken(bytes = 32): string`
- Register in `apps/api/src/app.ts`
- One test file per endpoint under `apps/api/src/routes/engagement/*.test.ts`

## Endpoint specs

### `POST /v1/claims/:id/engagement/send` (session-required)
- Reads claim + tenant.
- Renders template via `renderTemplate(tenant.engagement_letter_template_md, { claimant_name, financial_year, fee_pct, engagement_date, consultant_name })`.
- Generates `send_token` (32 bytes of entropy, base64url) with 30-day expiry.
- INSERT into `engagement_letter` (or UPDATE if one already exists for this claim).
- Updates `claim.engagement_status = 'sent'`, `engagement_letter.sent_to_claimant_at = now()`.
- Returns `{ engagementId, sendToken, expiresAt }`.

### `GET /v1/engagement/[token]` (PUBLIC, token-gated)
- Look up by `send_token`. 404 if not found OR expired OR already signed/declined/expired.
- Return `{ renderedMarkdown, consultantName, firmName, status }`.
- Constant-time token compare via `crypto.timingSafeEqual`.

### `POST /v1/engagement/[token]/sign` (PUBLIC, token-gated)
- Body: `{ typedName: string }`.
- Look up by `send_token` (same constant-time compare).
- Update `signed_by_claimant_at = now()`, `signed_by_claimant_name = typedName`, `signed_by_claimant_ip = req.ip`, `signed_by_claimant_ua = req.headers['user-agent']`.
- `claim.engagement_status = 'signed'`.
- Enqueue pg-boss job `engagement-letter-render-pdf` (task 03).
- Returns `{ engagementId, signedAt }`.

### `POST /v1/engagement/:id/countersign` (session-required)
- Caller must be admin or consultant role in the tenant.
- Update `countersigned_by_user_id = req.user.id`, `countersigned_at = now()`.
- Returns `{ countersignedAt }`.

### `POST /v1/engagement/[token]/decline` (PUBLIC, token-gated)
- Body: `{ reason?: string }`.
- Update `declined_at = now()`, `declined_reason = reason`. `claim.engagement_status = 'declined'`.
- Returns `{ declinedAt }`.

### `GET /v1/engagement/:id` (session-required)
- RLS-scoped read for the consultant view.
- Returns the full row + computed `current_step` (`pending_send | sent | signed | countersigned | declined | expired`).

## Architecture rules

- Session-scoped endpoints use `requireSession` + regular `sql` (RLS via GUC).
- Token-gated endpoints use `privilegedSql` (no session yet → no GUC → can't use RLS).
- Token comparison MUST be constant-time via `crypto.timingSafeEqual` (mirror `dev-login.ts` pattern).
- All writes inside `sql.begin(...)` transactions.

## Acceptance

- [ ] All 6 endpoints implemented.
- [ ] Each has a test covering happy path + auth failure + cross-tenant isolation (for session-scoped) OR invalid-token (for public).
- [ ] `typecheck` + `lint` pass.
- [ ] Send endpoint actually inserts a row; sign endpoint actually flips status; countersign records the user.

## Deliverable

PR titled `feat(api): engagement letter endpoints (send/sign/countersign/decline/get)`.
