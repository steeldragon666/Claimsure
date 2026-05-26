# 06 — Web Email-Link Fallback Sign Page

**Depends on:** 02 (API endpoints)

## Goal

A public token-gated web page at `/engagement/[token]/sign` that lets a claimant sign the engagement letter from a browser if they didn't install the mobile app. The email reminder from task 04 contains the link.

## Files to add

- `apps/web/src/app/engagement/[token]/sign/page.tsx` — the sign page (server component for token validation, client component for the sign form)
- `apps/web/src/app/engagement/[token]/sign/sign-form.tsx` — the interactive form (client component)
- `apps/web/src/app/engagement/[token]/sign/declined/page.tsx` — terminal state if claimant declines
- `apps/web/src/app/engagement/[token]/sign/signed/page.tsx` — success state with download link

## Implementation

### `page.tsx` (server component)
1. Fetch `GET /v1/engagement/[token]` server-side using `fetch()` against the API base URL.
2. If response is 404 → render "This link has expired or is invalid" terminal page.
3. If already-signed/declined/expired → redirect to the appropriate terminal page.
4. Otherwise → render the letter content + the `<SignForm>` client component.

### `sign-form.tsx` (client component)
- Same UX as mobile: type name + checkbox + Sign / Decline buttons.
- On Sign success → router.push(`/engagement/[token]/sign/signed`).
- On Decline success → router.push(`/engagement/[token]/sign/declined`).

## Architecture rules

- Route is PUBLIC — no session required.
- Token comes from URL param.
- Letter content is fetched server-side (avoids exposing internal API endpoint shape to the client).
- POST requests go to the API directly with the token in the URL.
- Mirror the design language of the rest of the consultant workspace (tokens.ts, MonoLabel, Diamond, etc.) — claimants benefit from feeling the same brand they're being engaged with.

## Acceptance

- [ ] Visiting a valid token URL shows the letter and sign form.
- [ ] Visiting an expired token shows the expiry message.
- [ ] Sign flow works end-to-end and lands on the success page.
- [ ] Decline flow works and lands on the declined page.
- [ ] No PII leaks in the URL (token is opaque; signer name only in POST body).

## Deliverable

PR titled `feat(web): public engagement-letter sign page (web fallback for mobile)`.
