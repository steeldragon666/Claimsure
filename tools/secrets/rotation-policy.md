# Secrets Rotation Policy

> CPA Platform — Production secret lifecycle management

## 1. Secret Classification and Rotation Cadence

| Secret Class              | Examples                                                    | Rotation Cadence                    | Procedure                                                                        |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| Symmetric keys (JWT, enc) | `SESSION_JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`                | 90 days                             | Rolling rotation: emit both keys, accept old, sign with new for 24 h, retire old |
| OAuth client secrets      | `XERO_ACCOUNTING_CLIENT_SECRET`, `DOCUSIGN_CLIENT_SECRET`   | 12 months OR on suspected leak      | Provider-specific re-issue + redeploy                                            |
| OIDC client secrets       | `MICROSOFT_OIDC_CLIENT_SECRET`, `GOOGLE_OIDC_CLIENT_SECRET` | 12 months OR on suspected leak      | Re-issue from identity provider admin console; redeploy                          |
| Database passwords        | `DATABASE_URL` credentials, `DATABASE_URL_APP` credentials  | 12 months                           | Rolling password update via `ALTER ROLE`                                         |
| API keys                  | `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `RESEND_API_KEY`     | 12 months OR on suspected leak      | Re-issue from provider dashboard; deploy                                         |
| Webhook HMACs             | `DOCUSIGN_WEBHOOK_HMAC_SECRET`, `GITHUB_WEBHOOK_SECRET`     | 12 months                           | Coordinate with provider; dual-validate during transition                        |
| GitHub App private key    | `GITHUB_APP_PRIVATE_KEY` (PEM)                              | 12 months                           | Generate new key in GitHub App settings, deploy, retire old                      |
| Observability credentials | `GRAFANA_OTLP_PASSWORD`                                     | 12 months                           | Re-issue from Grafana Cloud; deploy                                              |
| Sentry DSNs               | `SENTRY_DSN_API`, `SENTRY_DSN_WEB`                          | Lower sensitivity; rotate on misuse | Re-issue from Sentry dashboard                                                   |
| Eval-only keys            | `EVAL_ANTHROPIC_API_KEY`                                    | 12 months OR on suspected leak      | Re-issue from Anthropic console; update GitHub Actions secret                    |

## 2. Full Production Secret Inventory

| Secret                          | Class              | Storage Location       | Rotation Cadence    |
| ------------------------------- | ------------------ | ---------------------- | ------------------- |
| `SESSION_JWT_SECRET`            | Symmetric key      | Secrets manager / env  | 90 days             |
| `TOKEN_ENCRYPTION_KEY`          | Symmetric key      | Secrets manager / env  | 90 days             |
| `DATABASE_URL` (cpa role)       | Database password  | Secrets manager / env  | 12 months           |
| `DATABASE_URL_APP` (cpa_app)    | Database password  | Secrets manager / env  | 12 months           |
| `ANTHROPIC_API_KEY`             | API key            | Secrets manager / env  | 12 months           |
| `VOYAGE_API_KEY`                | API key            | Secrets manager / env  | 12 months           |
| `RESEND_API_KEY`                | API key            | Secrets manager / env  | 12 months           |
| `EVAL_ANTHROPIC_API_KEY`        | API key            | GitHub Actions secrets | 12 months           |
| `MICROSOFT_OIDC_CLIENT_SECRET`  | OIDC secret        | Secrets manager / env  | 12 months           |
| `GOOGLE_OIDC_CLIENT_SECRET`     | OIDC secret        | Secrets manager / env  | 12 months           |
| `XERO_ACCOUNTING_CLIENT_SECRET` | OAuth secret       | Secrets manager / env  | 12 months           |
| `DOCUSIGN_CLIENT_SECRET`        | OAuth secret       | Secrets manager / env  | 12 months           |
| `DOCUSIGN_WEBHOOK_HMAC_SECRET`  | Webhook HMAC       | Secrets manager / env  | 12 months           |
| `GITHUB_WEBHOOK_SECRET`         | Webhook HMAC       | Secrets manager / env  | 12 months           |
| `GITHUB_APP_PRIVATE_KEY`        | Asymmetric key     | Secrets manager / env  | 12 months           |
| `GRAFANA_OTLP_PASSWORD`         | Observability cred | Secrets manager / env  | 12 months           |
| `SENTRY_DSN_API`                | DSN                | Secrets manager / env  | On suspected misuse |
| `SENTRY_DSN_WEB`                | DSN                | Secrets manager / env  | On suspected misuse |

## 3. Standard Rotation Procedures

### 3.1 Symmetric Keys (SESSION_JWT_SECRET, TOKEN_ENCRYPTION_KEY)

Rolling rotation prevents session/token invalidation during the transition:

1. **Generate** a new secret: `openssl rand -hex 32`
2. **Deploy** with both old and new keys:
   - Set the new value as the primary (`SESSION_JWT_SECRET`)
   - Move the old value to `SESSION_JWT_SECRET_PREVIOUS`
3. **Sign** all new JWTs/tokens with the new key
4. **Verify** incoming JWTs/tokens against both keys (new first, then previous)
5. **Wait** 24 hours (one full session TTL cycle)
6. **Retire** the old key by removing `SESSION_JWT_SECRET_PREVIOUS`
7. **Verify** no 401 errors in monitoring for 1 hour post-retirement

For `TOKEN_ENCRYPTION_KEY`, the same pattern applies but the transition window
should cover the longest OAuth refresh-token lifetime (typically 60 days for
Xero). Re-encrypt stored tokens with the new key during the migration window.

Automated script: [`tools/secrets/rotate-jwt-secret.sh`](./rotate-jwt-secret.sh)

### 3.2 OAuth / OIDC Client Secrets

1. **Log in** to the provider admin console (Xero, DocuSign, Microsoft Entra, Google Cloud Console)
2. **Generate** a new client secret (do not revoke the old one yet)
3. **Update** the secret in the deployment secrets manager
4. **Deploy** the application with the new secret
5. **Verify** OAuth flows (login, token refresh) work end-to-end
6. **Revoke** the old client secret in the provider console
7. **Log** the rotation in the tracking table below

### 3.3 Database Passwords

1. **Generate** a new password: `openssl rand -base64 24`
2. **Connect** to Postgres as a superuser
3. **Execute**: `ALTER ROLE cpa_app WITH PASSWORD 'new-password';`
4. **Update** `DATABASE_URL_APP` in the secrets manager
5. **Deploy** the application — new connections use the new password
6. **Verify** database connectivity in application health checks
7. Repeat for the `cpa` (migration) role if rotating `DATABASE_URL`

### 3.4 API Keys (Anthropic, Voyage, Resend)

1. **Log in** to the provider console
2. **Create** a new API key
3. **Update** the secret in the deployment secrets manager
4. **Deploy** the application
5. **Verify** API calls succeed (classifier, embeddings, email)
6. **Revoke** the old API key in the provider console

### 3.5 Webhook HMAC Secrets

Webhook HMACs require coordination because the provider signs payloads with the secret:

1. **Generate** a new HMAC secret: `openssl rand -hex 32`
2. **Deploy** the application to accept both old and new HMAC signatures
3. **Update** the HMAC secret in the provider's webhook settings (DocuSign Connect, GitHub App)
4. **Verify** that incoming webhooks validate correctly
5. **Remove** dual-validation logic — accept only the new secret
6. **Deploy** the final single-secret configuration

### 3.6 GitHub App Private Key

1. **Navigate** to GitHub App settings > Private keys
2. **Generate** a new private key (downloads a PEM file)
3. **Update** `GITHUB_APP_PRIVATE_KEY` in the secrets manager with the new PEM contents
4. **Deploy** the application
5. **Verify** GitHub App JWT authentication works (installation token fetch, PR creation)
6. **Revoke** the old private key in GitHub App settings

## 4. Emergency Rotation Procedure (Suspected Leak)

If a secret is suspected to be compromised:

1. **Classify** as Sev 2 incident minimum — open an incident in the team channel
2. **Identify** the compromised secret(s) and their blast radius
3. **Rotate immediately** using the relevant procedure above — skip any transition window
4. **Revoke** the old secret at the provider immediately (no grace period)
5. **Deploy** with the new secret
6. **Audit**:
   - Check access logs for unauthorized use of the compromised credential
   - Review `audit_log` for anomalous API calls during the exposure window
   - Check Sentry and Grafana for unusual error patterns
7. **Notify** stakeholders per the incident response procedure
8. **Post-mortem** — document how the leak occurred and what controls prevent recurrence

## 5. Rotation Tracking Log

| Secret                          | Last Rotated | Next Due | Rotated By | Notes          |
| ------------------------------- | ------------ | -------- | ---------- | -------------- |
| `SESSION_JWT_SECRET`            | —            | —        | —          | Initial deploy |
| `TOKEN_ENCRYPTION_KEY`          | —            | —        | —          | Initial deploy |
| `DATABASE_URL`                  | —            | —        | —          | Initial deploy |
| `DATABASE_URL_APP`              | —            | —        | —          | Initial deploy |
| `ANTHROPIC_API_KEY`             | —            | —        | —          | Initial deploy |
| `VOYAGE_API_KEY`                | —            | —        | —          | Initial deploy |
| `RESEND_API_KEY`                | —            | —        | —          | Initial deploy |
| `EVAL_ANTHROPIC_API_KEY`        | —            | —        | —          | Initial deploy |
| `MICROSOFT_OIDC_CLIENT_SECRET`  | —            | —        | —          | Initial deploy |
| `GOOGLE_OIDC_CLIENT_SECRET`     | —            | —        | —          | Initial deploy |
| `XERO_ACCOUNTING_CLIENT_SECRET` | —            | —        | —          | Initial deploy |
| `DOCUSIGN_CLIENT_SECRET`        | —            | —        | —          | Initial deploy |
| `DOCUSIGN_WEBHOOK_HMAC_SECRET`  | —            | —        | —          | Initial deploy |
| `GITHUB_WEBHOOK_SECRET`         | —            | —        | —          | Initial deploy |
| `GITHUB_APP_PRIVATE_KEY`        | —            | —        | —          | Initial deploy |
| `GRAFANA_OTLP_PASSWORD`         | —            | —        | —          | Initial deploy |
| `SENTRY_DSN_API`                | —            | —        | —          | Initial deploy |
| `SENTRY_DSN_WEB`                | —            | —        | —          | Initial deploy |

---

**Document control**

- Last reviewed: 2026-05-06
- Next review: 2026-08-06 (quarterly)
- Owner: Aaron
