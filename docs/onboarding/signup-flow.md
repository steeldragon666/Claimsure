# Onboarding Signup Flow

> **Last updated:** 2026-05-06
> **Owner:** Aaron
> **Phase:** P8 (T1.8)

## Overview

CPA Platform supports three authentication flows for onboarding, plus a
post-authentication tenant provisioning pipeline. The primary flow for
firm administrators is Microsoft Entra ID SSO; Google OAuth is a
secondary option; and magic links serve the claimant portal.

---

## 1. Microsoft Entra ID SSO (Primary)

The primary authentication flow for accounting firms. Most CPA firms
already use Microsoft 365; Entra ID (formerly Azure AD) provides
seamless SSO.

```
Firm admin clicks "Continue with Microsoft"
       |
       v
GET /v1/auth/microsoft/login
  -> Redirects to Microsoft authorize endpoint
  -> Scopes: openid, profile, email
       |
       v
Microsoft authenticates user
  -> User consents (first time only)
  -> Redirects to /v1/auth/microsoft/callback
       |
       v
POST /v1/auth/microsoft/callback
  -> Exchanges code for tokens
  -> Extracts email, name, oid from id_token
  -> Looks up user by email in `user` table
       |
       +-- User exists with tenant membership?
       |     -> Issue session JWT (cpa_session cookie)
       |     -> Redirect to dashboard
       |
       +-- User exists but no tenant membership?
       |     -> Show "no firm membership" page
       |     -> Firm admin must add them first
       |
       +-- User does not exist + onboarding enabled?
             -> Create user record
             -> Check for pending invite token
             -> If invite: auto-join tenant with invited role
             -> If no invite: show "contact your firm admin" page
```

### Configuration

| Env Var                        | Description                                      |
| ------------------------------ | ------------------------------------------------ |
| `MICROSOFT_OIDC_CLIENT_ID`     | App registration client ID                       |
| `MICROSOFT_OIDC_CLIENT_SECRET` | App registration client secret                   |
| `MICROSOFT_OIDC_TENANT`        | `common` for multi-tenant, or specific tenant ID |
| `MICROSOFT_OIDC_REDIRECT_URI`  | Callback URL                                     |

### Security Considerations

- PKCE is enforced (code_challenge_method=S256)
- State parameter prevents CSRF on the callback
- Nonce in id_token prevents replay
- Session JWT has 24h TTL (configurable via `SESSION_TTL_SECONDS`)

---

## 2. Google OAuth (Secondary)

For firms that use Google Workspace instead of Microsoft 365.

```
User clicks "Continue with Google"
       |
       v
GET /v1/auth/google/login
  -> Redirects to Google authorize endpoint
  -> Scopes: openid, profile, email
       |
       v
Google authenticates user
  -> Redirects to /v1/auth/google/callback
       |
       v
POST /v1/auth/google/callback
  -> Same lookup + session flow as Microsoft
```

### Configuration

| Env Var                     | Description         |
| --------------------------- | ------------------- |
| `GOOGLE_OIDC_CLIENT_ID`     | OAuth client ID     |
| `GOOGLE_OIDC_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_OIDC_REDIRECT_URI`  | Callback URL        |

---

## 3. Magic Link (Claimant Portal)

Passwordless authentication for claimants accessing the PWA portal.
Claimants typically do not have firm SSO accounts.

```
Claimant receives magic-link email (from firm consultant)
       |
       v
Clicks link: /v1/claimant-magic-link/redeem?token=<one-time-token>
       |
       v
API verifies token:
  - Token exists in DB
  - Not expired (15-minute TTL)
  - Not already redeemed
       |
       v
On success:
  - Mark token as redeemed
  - Issue cpa_claimant_session cookie (JWT, 24h TTL)
  - Redirect to claimant status page
       |
       v
Claimant views: claim status, recent events, pending RFIs
```

### Security Considerations

- Tokens are single-use (redeemed flag)
- 15-minute expiry prevents link sharing
- Separate cookie namespace (cpa_claimant_session) from consultant sessions
- Claimant sessions cannot access consultant-side routes (different JWT audience)

---

## 4. Post-Authentication Tenant Provisioning

When a new firm is onboarded (white-glove for first customers, self-service later):

### Step 1: Create Tenant

```sql
INSERT INTO tenant (id, name, slug, created_at)
VALUES (gen_random_uuid(), 'Acme CPA', 'acme-cpa', now());
```

### Step 2: Create Admin User Membership

```sql
INSERT INTO tenant_user (tenant_id, user_id, role, is_default)
VALUES (<tenant_id>, <user_id>, 'admin', true);
```

### Step 3: Initialize Brand Config (Optional)

```sql
INSERT INTO brand_config (tenant_id, display_name, primary_color, accent_color)
VALUES (<tenant_id>, 'Acme CPA', '#0066cc', '#00a86b');
```

### Step 4: Send Welcome Email

Trigger point: immediately after tenant + admin user creation completes.

```ts
import { welcomeEmail } from '@cpa/email';

const { subject, html, text } = welcomeEmail({
  name: user.name,
  firmName: tenant.name,
  dashboardUrl: `${BASE_URL}/`,
});

await emailSender.send({ to: user.email, subject, html, text });
```

### Step 5: Mark Onboarding Status

```
POST /v1/onboarding/complete
```

Sets the `onboarding_completed_at` timestamp on the tenant record.

---

## 5. Welcome Email Trigger Points

| Event                         | Email Template | Recipient                                       |
| ----------------------------- | -------------- | ----------------------------------------------- |
| Firm account created          | `welcome`      | Firm admin                                      |
| Team member invited           | `invite`       | Invited person                                  |
| Claimant magic link generated | `magic-link`   | Claimant employee                               |
| Claim stage transition        | `claim-status` | Assigned consultants + claimant (on milestones) |

---

## 6. Onboarding Checklist (First-Customer Flow)

The onboarding page (`/onboarding`) shows a guided checklist:

1. **Account created** -- Automatic on signup
2. **Email verified** -- Confirmed via SSO (implicit) or verification link
3. **First team member invited** -- At least one consultant added
4. **First claimant added** -- A subject_tenant of kind 'claimant' exists
5. **Brand configured** -- Optional: custom colors/logo uploaded
6. **First activity captured** -- At least one event recorded

The API endpoint `GET /v1/onboarding/status` returns the completion state
of each step, computed from existing database state (no separate checklist
table needed).

---

## Future Enhancements (P9+)

- Self-service signup form with slug selection + Stripe billing integration
- Multi-IDP support per tenant (Microsoft + Google simultaneously)
- SAML 2.0 for enterprise SSO requirements
- Automated claimant onboarding via bulk CSV import
- Onboarding wizard with step-by-step guided setup
