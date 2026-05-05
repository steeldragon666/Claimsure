# Logging and Monitoring Policy (A.8.15-A.8.16)

**ISO 27001 Reference:** Annex A controls A.8.15 (Logging), A.8.16 (Monitoring activities)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Define what events are logged, how logs are stored and protected, retention periods, and access controls for log data within the CPA Platform.

## 2. What Is Logged

### 2.1 Authentication Events

| Event                        | Source          | Destination      |
| ---------------------------- | --------------- | ---------------- |
| Successful login             | Fastify auth    | Application logs |
| Failed login attempt         | Fastify auth    | Application logs |
| Session creation/expiry      | Session plugin  | Application logs |
| OAuth token refresh          | Auth middleware | Application logs |
| MFA challenge (at IDP level) | IDP provider    | IDP audit logs   |

### 2.2 Application Events

| Event                         | Source          | Destination       |
| ----------------------------- | --------------- | ----------------- |
| API request/response (errors) | Fastify         | Sentry + app logs |
| API request (4xx/5xx)         | Fastify         | Sentry            |
| Unhandled exceptions          | Node.js process | Sentry            |
| Agent execution (AI)          | @cpa/agents     | Application logs  |

### 2.3 Audit Events (Database)

| Event                     | Source      | Destination                              |
| ------------------------- | ----------- | ---------------------------------------- |
| Mapping rule lifecycle    | Application | `audit_log` table (append-only)          |
| Tenant user changes       | Application | `audit_log` table (append-only)          |
| Narrative draft versions  | Application | `narrative_draft_version` (append-only)  |
| Prompt suggestion reviews | Application | `prompt_suggestion_review` (append-only) |
| Event chain entries       | Application | `event` table (append-only chain)        |

### 2.4 Access Control Events

| Event                        | Source       | Destination        |
| ---------------------------- | ------------ | ------------------ |
| RLS policy violation attempt | PostgreSQL   | Database logs      |
| Unauthorised API access      | Fastify auth | Application logs   |
| Role escalation attempt      | Application  | audit_log + Sentry |

### 2.5 Infrastructure Events

| Event                      | Source         | Destination         |
| -------------------------- | -------------- | ------------------- |
| Deployment                 | GitHub Actions | GitHub Actions logs |
| Container start/stop       | Cloud platform | Provider logs       |
| Database connection events | PostgreSQL     | Database logs       |
| Certificate renewal        | Let's Encrypt  | Provider logs       |

## 3. Retention Periods

| Log Category              | Hot Storage                | Cold Storage | Total Retention  | Tamper Protection                                   |
| ------------------------- | -------------------------- | ------------ | ---------------- | --------------------------------------------------- |
| `audit_log` table         | Indefinite                 | N/A          | 7 years          | Append-only (UPDATE/DELETE revoked, migration 0035) |
| `event` chain             | Indefinite                 | N/A          | 7 years          | Content hash chain integrity                        |
| `narrative_draft_version` | Indefinite                 | N/A          | 7 years          | Append-only (UPDATE/DELETE revoked)                 |
| Application logs          | 90 days                    | 1 year       | ~15 months       | Provider-managed immutability                       |
| Sentry error events       | Provider default (90 days) | N/A          | Provider default | Sentry-managed                                      |
| GitHub Actions logs       | 90 days                    | N/A          | 90 days          | GitHub-managed                                      |
| Database server logs      | 30 days                    | 90 days      | ~4 months        | Provider-managed                                    |

## 4. Tamper Resistance

### 4.1 Append-Only Tables

The following database tables have UPDATE and DELETE privileges revoked from the `cpa_app` role:

- `audit_log` (migration 0035)
- `narrative_draft_version` (migration 0030)
- `prompt_suggestion_review`

This structural enforcement means the application cannot modify or delete historical records, even if compromised.

### 4.2 Content Hash Chain

The `event` table maintains a cryptographic hash chain:

- Each event includes a `content_hash` computed from the event payload
- The chain provides tamper-evident integrity: modification of any event would break the hash chain
- Chain verification can be performed independently of the application

### 4.3 External Log Integrity

Application logs shipped to Sentry and provider logging services benefit from the providers' own integrity controls. These are outside the CPA Platform's direct control but are covered by the providers' SOC 2 certifications.

## 5. Access to Logs

| Log Source            | Access                                                        |
| --------------------- | ------------------------------------------------------------- |
| `audit_log` table     | RLS-enforced; tenant admin within their firm; founder for all |
| Application logs      | Founder + ops team only                                       |
| Sentry dashboard      | Founder + ops team only                                       |
| Database server logs  | DBA only (founder)                                            |
| GitHub Actions logs   | Repository collaborators                                      |
| Provider console logs | Cloud account admins (founder)                                |

Log access follows the principle of least privilege. No developer has standing access to production application logs without explicit authorisation.

## 6. Log Review

- **Automated:** Sentry alerts on error rate thresholds; PagerDuty for critical incidents
- **Manual:** Weekly review of Sentry error dashboard by the development team
- **Quarterly:** Review of `audit_log` patterns during access review cycle
- **On-demand:** During incident response, logs are reviewed by the incident commander

## 7. Log Protection

- Logs containing Confidential or Restricted data are treated at the same classification level
- Log data is encrypted in transit (TLS) and at rest (provider-managed encryption)
- Log access is audited by the provider's access logging
- No log data is exposed in API responses or error messages returned to clients

## 8. References

- ISO/IEC 27001:2022 Annex A controls A.8.15, A.8.16
- Migration 0022 — audit_log table creation
- Migration 0035 — audit_log append-only enforcement
- Sentry documentation for retention policies
