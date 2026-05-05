# Risk Register

**ISO 27001 Reference:** Chapter 6.1.2 — Information security risk assessment

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## Scoring Guide

- **Likelihood:** 1 = Rare, 2 = Unlikely, 3 = Possible, 4 = Likely, 5 = Almost Certain
- **Impact:** 1 = Negligible, 2 = Minor, 3 = Moderate, 4 = Major, 5 = Catastrophic
- **Risk Rating:** Likelihood x Impact
- **Risk Level:** Low (1–4), Medium (5–9), High (10–16), Critical (17–25)

See [03-risk-assessment-methodology.md](./03-risk-assessment-methodology.md) for the full methodology.

## Register

| Risk ID | Asset                        | Threat                                              | Vulnerability                                   | Existing Controls                                                                                                                      | L   | I   | Rating | Level  | Owner | Treatment                                                                                                                               |
| ------- | ---------------------------- | --------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | ------ | ------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| R-001   | Customer PII (PostgreSQL)    | Data breach via SQL injection                       | Unparameterized queries                         | Parameterized queries (postgres-js template tags); RLS tenant isolation; input validation via Zod schemas                              | 2   | 5   | 10     | High   | Aaron | Mitigate — periodic SAST scanning; scheduled penetration testing (T2.5)                                                                 |
| R-002   | Multi-tenant claim data      | Unauthorized cross-tenant data access               | RLS misconfiguration or bypass                  | RLS policies on all tenant-scoped tables; `tenant_user` ACL table; automated RLS coverage test in `migrations.test.ts`                 | 2   | 5   | 10     | High   | Aaron | Mitigate — expand automated RLS test coverage; add integration test for cross-tenant query rejection                                    |
| R-003   | User sessions                | Session hijack / token theft                        | Token exposure via XSS or insecure transport    | HTTP-only secure cookies; JWT short expiry; signed sessions; HTTPS-only transport; CSP headers                                         | 2   | 4   | 8      | Medium | Aaron | Mitigate — implement session rotation on privilege escalation; add idle-timeout                                                         |
| R-004   | Source code repository       | Credential leak in source code                      | Secrets hard-coded or committed accidentally    | `.gitignore` rules; no secrets in code; env vars for all credentials; PR review process                                                | 2   | 4   | 8      | Medium | Aaron | Mitigate — add pre-commit secret scanning hook (e.g. gitleaks); periodic repo scan                                                      |
| R-005   | PostgreSQL database          | Database loss or corruption                         | Lack of verified backups; storage failure       | WAL archiving; regular automated backups (T1.1); point-in-time recovery capability                                                     | 2   | 5   | 10     | High   | Aaron | Mitigate — validate backup restoration quarterly; document and test DR procedure (T2.4)                                                 |
| R-006   | npm dependencies             | Supply chain compromise (malicious package)         | Unvetted transitive dependency                  | pnpm lockfile with integrity hashes; Dependabot alerts; PR code review for dependency changes                                          | 3   | 4   | 12     | High   | Aaron | Mitigate — enable `pnpm audit` in CI; pin critical dependency versions; review Dependabot PRs within 48 hours                           |
| R-007   | AI agent subsystem           | Prompt injection / model manipulation               | Unstructured or unvalidated model output        | Structured output schemas (Zod); citation-only agent design; no free-text prior-year content; model output validation                  | 2   | 3   | 6      | Medium | Aaron | Mitigate — add output-schema conformance tests; log all agent interactions for audit; implement human-in-the-loop for high-risk outputs |
| R-008   | Fastify API endpoints        | Unauthorized API access                             | Missing or bypassed authentication              | `requireSession` middleware on all protected routes; role-based authorization checks; JWT validation                                   | 2   | 4   | 8      | Medium | Aaron | Mitigate — add automated test ensuring all non-public routes require auth; implement rate limiting per-endpoint                         |
| R-009   | All platform assets          | Insider threat (contractor / AI agent)              | Excessive permissions; lack of audit trail      | PR review process (no self-merge); append-only audit logs (`audit_log` table with UPDATE/DELETE revoked); least-privilege DB roles     | 2   | 4   | 8      | Medium | Aaron | Mitigate — enforce branch protection rules; periodic access review; ensure AI agents cannot modify audit logs                           |
| R-010   | AI agent subsystem; CI/CD    | Service provider outage (Anthropic, GitHub, Vercel) | Single-provider dependency                      | Graceful degradation patterns; error handling with user-facing messages; no hard dependency on AI for core CRUD                        | 3   | 3   | 9      | Medium | Aaron | Accept — document SLA expectations; implement circuit-breaker pattern for AI calls; maintain offline-capable core workflow              |
| R-011   | R&D claim data               | Regulatory non-compliance (ATO / AusIndustry)       | Insufficient evidence trail; missing timestamps | Forensic metadata (`first_recorded_at`, `hypothesis_formed_at`); immutable timestamps (PostgreSQL trigger); append-only draft versions | 2   | 5   | 10     | High   | Aaron | Mitigate — automated compliance checks in CI; periodic review against ATO guidance; maintain Body by Michael evidentiary standard       |
| R-012   | Production environment       | Ransomware on production infrastructure             | Unpatched systems; compromised credentials      | Immutable backups (T1.1); DR procedure (T2.4); managed cloud infrastructure with automatic patching                                    | 1   | 5   | 5      | Medium | Aaron | Mitigate — ensure backups are stored in separate cloud account; test DR restoration procedure; enforce MFA on all cloud accounts        |
| R-013   | Fastify API; web frontend    | Denial of service (DDoS)                            | Publicly exposed endpoints                      | Rate limiting middleware; cloud provider DDoS protection (Vercel/Cloud Run built-in); CDN caching for static assets                    | 2   | 3   | 6      | Medium | Aaron | Mitigate — configure explicit rate limits per API endpoint; set up alerting for unusual traffic patterns                                |
| R-014   | Email system (transactional) | Email spoofing / phishing                           | Lack of email authentication records            | DKIM/SPF/DMARC configured; transactional-only email (no marketing); sender verification                                                | 1   | 3   | 3      | Low    | Aaron | Accept — monitor DMARC reports quarterly; maintain transactional-only email policy                                                      |
| R-015   | Encryption keys; API secrets | Loss of encryption keys or API credentials          | No key rotation; single point of failure        | Secrets rotation procedure (T1.5); environment-variable-based secret management; key escrow for critical credentials                   | 2   | 4   | 8      | Medium | Aaron | Mitigate — implement automated secret rotation schedule; document key recovery procedure; test recovery annually                        |

## Risk Level Summary

| Level    | Count | Risk IDs                                                      |
| -------- | ----- | ------------------------------------------------------------- |
| Critical | 0     | —                                                             |
| High     | 5     | R-001, R-002, R-005, R-006, R-011                             |
| Medium   | 9     | R-003, R-004, R-007, R-008, R-009, R-010, R-012, R-013, R-015 |
| Low      | 1     | R-014                                                         |

## Change Log

| Date       | Change                          | Author |
| ---------- | ------------------------------- | ------ |
| 2026-05-06 | Initial register created (v1.0) | Aaron  |
