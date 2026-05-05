# A.8.24 — Secrets and Cryptographic Key Management

> ISO 27001:2022 Annex A Control A.8.24 — Use of cryptography

## 1. Purpose

Document the cryptographic key and secrets management lifecycle for the CPA
Platform production environment. This policy ensures that all secrets are
generated, distributed, stored, used, rotated, and retired in accordance with
ISO 27001 information security requirements and industry best practices.

## 2. Scope

All secrets used in the CPA Platform production environment, including:

- Symmetric signing and encryption keys
- OAuth and OIDC client secrets
- Database credentials
- Third-party API keys
- Webhook HMAC secrets
- Asymmetric keys (GitHub App RS256 PEM)
- Observability and monitoring credentials
- Error-tracking DSNs

This policy covers the full lifecycle from generation through destruction.

## 3. Secret Inventory

All production secrets are classified as **Restricted** under the CPA Platform
information classification scheme.

| Secret                          | Type                | Classification | Storage Location       | Rotation Cadence    |
| ------------------------------- | ------------------- | -------------- | ---------------------- | ------------------- |
| `SESSION_JWT_SECRET`            | HS256 signing key   | Restricted     | Secrets manager / env  | 90 days             |
| `TOKEN_ENCRYPTION_KEY`          | AES-256-GCM key     | Restricted     | Secrets manager / env  | 90 days             |
| `DATABASE_URL` (cpa role)       | Postgres password   | Restricted     | Secrets manager / env  | 12 months           |
| `DATABASE_URL_APP` (cpa_app)    | Postgres password   | Restricted     | Secrets manager / env  | 12 months           |
| `ANTHROPIC_API_KEY`             | API key             | Restricted     | Secrets manager / env  | 12 months           |
| `VOYAGE_API_KEY`                | API key             | Restricted     | Secrets manager / env  | 12 months           |
| `RESEND_API_KEY`                | API key             | Restricted     | Secrets manager / env  | 12 months           |
| `EVAL_ANTHROPIC_API_KEY`        | API key             | Restricted     | GitHub Actions secrets | 12 months           |
| `MICROSOFT_OIDC_CLIENT_SECRET`  | OIDC client secret  | Restricted     | Secrets manager / env  | 12 months           |
| `GOOGLE_OIDC_CLIENT_SECRET`     | OIDC client secret  | Restricted     | Secrets manager / env  | 12 months           |
| `XERO_ACCOUNTING_CLIENT_SECRET` | OAuth client secret | Restricted     | Secrets manager / env  | 12 months           |
| `DOCUSIGN_CLIENT_SECRET`        | OAuth client secret | Restricted     | Secrets manager / env  | 12 months           |
| `DOCUSIGN_WEBHOOK_HMAC_SECRET`  | HMAC-SHA256 secret  | Restricted     | Secrets manager / env  | 12 months           |
| `GITHUB_WEBHOOK_SECRET`         | HMAC-SHA256 secret  | Restricted     | Secrets manager / env  | 12 months           |
| `GITHUB_APP_PRIVATE_KEY`        | RS256 PEM key       | Restricted     | Secrets manager / env  | 12 months           |
| `GRAFANA_OTLP_PASSWORD`         | Basic auth password | Restricted     | Secrets manager / env  | 12 months           |
| `SENTRY_DSN_API`                | DSN (URL + key)     | Restricted     | Secrets manager / env  | On suspected misuse |
| `SENTRY_DSN_WEB`                | DSN (URL + key)     | Restricted     | Secrets manager / env  | On suspected misuse |

## 4. Key Management Lifecycle

### 4.1 Generation

All cryptographic material must be generated using approved methods:

| Method                    | Use Case                             | Minimum Entropy |
| ------------------------- | ------------------------------------ | --------------- |
| `openssl rand -hex 32`    | Symmetric keys, HMAC secrets         | 256 bits        |
| `openssl rand -base64 24` | Database passwords                   | 192 bits        |
| Provider-generated        | OAuth/OIDC secrets, API keys         | Provider policy |
| Hardware-backed (HSM/KMS) | Where available (future enhancement) | Provider policy |

**Prohibited generation methods:**

- Manual / human-chosen passwords for machine credentials
- Pseudo-random generators without cryptographic backing
- Reuse of secrets across environments (dev/staging/production)

### 4.2 Distribution

- Secrets are distributed exclusively through the secrets manager or
  encrypted CI/CD secret stores (GitHub Actions encrypted secrets).
- Secrets are **never** transmitted via email, chat, or unencrypted channels.
- Initial provisioning requires two-party authorization: one person generates,
  another verifies deployment.

### 4.3 Storage

- **Never in source code.** The `.env.example` file contains placeholder values
  only. The `.gitignore` excludes `.env` files.
- **Environment variables** injected at runtime via the deployment platform's
  secrets manager (AWS Secrets Manager, GCP Secret Manager, Fly.io secrets,
  Vercel encrypted env vars).
- **Encrypted at rest** by the secrets manager's envelope encryption
  (AES-256 or equivalent).
- **No local copies** on developer machines for production secrets. Development
  uses separate, non-production credentials.

### 4.4 Use

- Application code reads secrets from environment variables at startup.
- Secrets are never logged, included in error messages, or returned in API
  responses. The API framework strips sensitive headers and redacts credentials
  in structured logs.
- `TOKEN_ENCRYPTION_KEY` is used for AES-256-GCM encryption of OAuth tokens at
  rest in the `integration_connection` table.
- `SESSION_JWT_SECRET` signs HS256 JWTs for session management (24-hour TTL).

### 4.5 Rotation

Rotation procedures are documented in detail at:
[`tools/secrets/rotation-policy.md`](../../../tools/secrets/rotation-policy.md)

Summary of cadences:

- **90-day rotation**: Symmetric keys (`SESSION_JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`)
- **12-month rotation**: All other secrets
- **Immediate rotation**: On suspected compromise (see section 6)

Rolling rotation with dual-key acceptance is mandatory for symmetric keys to
avoid service disruption.

### 4.6 Retirement

When a secret is superseded:

1. The old secret remains valid only during the defined transition window
   (24 hours for JWT secrets; coordinated for webhook HMACs).
2. After the transition window, the old secret is removed from all
   environments.
3. The old value is not archived — it is permanently discarded.

### 4.7 Destruction

- Old secrets are deleted from the secrets manager with no recovery option
  (e.g., `--force-delete-without-recovery` for AWS Secrets Manager).
- If a secret was ever written to a file (e.g., PEM key download), the file is
  securely deleted from the local filesystem.
- Secrets manager audit logs retain a record that the secret existed and was
  deleted, but not the secret value itself.

## 5. Access Control

- **Least privilege**: Only the deployment pipeline service account and the
  production runtime environment have access to production secrets.
- **No developer access**: Individual developers do not have read access to
  production secret values. Emergency break-glass access requires two-party
  authorization and is logged.
- **Separate environments**: Development, CI, staging, and production each use
  independent secret values. Cross-environment secret reuse is prohibited.
- **GitHub Actions secrets**: CI-only keys (e.g., `EVAL_ANTHROPIC_API_KEY`) are
  stored as GitHub repository secrets, accessible only to workflow runs on
  protected branches.

## 6. Emergency Key Compromise Procedure

If a secret is suspected or confirmed to be compromised:

1. **Classify** the incident as Sev 2 minimum. Open an incident immediately.
2. **Rotate** the compromised secret using the emergency procedure in
   [`tools/secrets/rotation-policy.md` section 4](../../../tools/secrets/rotation-policy.md).
   Skip any transition/grace period — immediate hard cut-over.
3. **Revoke** the old secret at the provider immediately.
4. **Audit** access logs for unauthorized use during the exposure window:
   - Application `audit_log` table for anomalous operations
   - Provider dashboards for unexpected API consumption
   - Sentry and Grafana for unusual error patterns
5. **Notify** stakeholders per the incident response procedure.
6. **Post-mortem** within 5 business days. Document root cause, timeline,
   blast radius, and preventive controls.

## 7. Rotation Drill Log

Periodic rotation drills validate that procedures work and that the team
maintains operational readiness.

| Date | Secret Class | Method | Success | Notes |
| ---- | ------------ | ------ | ------- | ----- |
| —    | —            | —      | —       | —     |

Drills should be conducted at least once per quarter using a non-production
environment. Results are recorded here and reviewed during quarterly security
reviews.

## 8. Document Control

| Field          | Value                        |
| -------------- | ---------------------------- |
| Document ID    | ISO-A.8.24-001               |
| Version        | 1.0                          |
| Classification | Internal                     |
| Last reviewed  | 2026-05-06                   |
| Next review    | 2026-08-06 (quarterly)       |
| Owner          | Aaron                        |
| Approved by    | Aaron                        |
| Change log     | 1.0 — Initial version (T1.5) |
