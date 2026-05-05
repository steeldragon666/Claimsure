# Risk Treatment Plan

**ISO 27001 Reference:** Chapter 6.1.3 — Information security risk treatment

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## Purpose

This document records the treatment decisions for all risks in the [Risk Register](./04-risk-register.md) that are rated Medium or above. Low-rated risks are accepted and monitored at the next scheduled review.

## Treatment Plan

### R-001 — Customer Data Breach via SQL Injection

| Field             | Value                                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| Risk Level        | High (10)                                                                      |
| Treatment Option  | Mitigate                                                                       |
| Actions           | 1. Integrate SAST tool (e.g. Semgrep) into CI pipeline to detect raw SQL usage |
|                   | 2. Schedule annual penetration test with focus on injection vectors (T2.5)     |
|                   | 3. Maintain 100% parameterized query coverage via postgres-js template tags    |
| Responsible Party | Aaron                                                                          |
| Target Completion | T2.5 (penetration testing task); SAST integration by P8 completion             |
| Status            | In Progress — parameterized queries and RLS are implemented; SAST pending      |

### R-002 — Unauthorized Cross-Tenant Data Access

| Field             | Value                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Risk Level        | High (10)                                                                                 |
| Treatment Option  | Mitigate                                                                                  |
| Actions           | 1. Expand automated RLS coverage tests to cover all tenant-scoped tables                  |
|                   | 2. Add integration test that explicitly attempts cross-tenant query and asserts rejection |
|                   | 3. Periodic manual review of RLS policies after schema changes                            |
| Responsible Party | Aaron                                                                                     |
| Target Completion | RLS test expansion by P8 completion; ongoing with each migration                          |
| Status            | In Progress — RLS policies and coverage test exist; expansion planned                     |

### R-003 — Session Hijack / Token Theft

| Field             | Value                                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| Risk Level        | Medium (8)                                                                     |
| Treatment Option  | Mitigate                                                                       |
| Actions           | 1. Implement session rotation on privilege escalation (e.g. role change)       |
|                   | 2. Add configurable idle-timeout for sessions                                  |
|                   | 3. Review and harden CSP headers                                               |
| Responsible Party | Aaron                                                                          |
| Target Completion | P9 (hardening phase)                                                           |
| Status            | Planned — core session security (HTTP-only cookies, JWT expiry) is implemented |

### R-004 — Credential Leak in Source Code

| Field             | Value                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| Risk Level        | Medium (8)                                                                 |
| Treatment Option  | Mitigate                                                                   |
| Actions           | 1. Add pre-commit secret scanning hook (gitleaks or similar)               |
|                   | 2. Run periodic full-repo secret scan and remediate any findings           |
|                   | 3. Document secret management procedures in ops runbook                    |
| Responsible Party | Aaron                                                                      |
| Target Completion | Pre-commit hook by P8 completion; periodic scan ongoing                    |
| Status            | Planned — .gitignore and env var discipline are in place; scanning pending |

### R-005 — Database Loss or Corruption

| Field             | Value                                                                           |
| ----------------- | ------------------------------------------------------------------------------- |
| Risk Level        | High (10)                                                                       |
| Treatment Option  | Mitigate                                                                        |
| Actions           | 1. Validate backup restoration quarterly (restore to staging and verify)        |
|                   | 2. Document and test full DR procedure (T2.4)                                   |
|                   | 3. Ensure backup storage is in a separate cloud region/account                  |
| Responsible Party | Aaron                                                                           |
| Target Completion | T2.4 (DR procedure); quarterly validation ongoing                               |
| Status            | In Progress — WAL archiving and automated backups exist (T1.1); DR docs pending |

### R-006 — Supply Chain Compromise (npm Dependency)

| Field             | Value                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| Risk Level        | High (12)                                                                         |
| Treatment Option  | Mitigate                                                                          |
| Actions           | 1. Enable `pnpm audit` as a CI step (fail on high/critical vulnerabilities)       |
|                   | 2. Pin critical dependency versions explicitly in package.json                    |
|                   | 3. Review and merge Dependabot PRs within 48 hours of creation                    |
|                   | 4. Evaluate adopting Socket.dev or similar supply-chain security tool             |
| Responsible Party | Aaron                                                                             |
| Target Completion | CI audit step by P8 completion; ongoing dependency hygiene                        |
| Status            | In Progress — Dependabot and lockfile integrity are active; CI audit step pending |

### R-007 — AI Model Prompt Injection

| Field             | Value                                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| Risk Level        | Medium (6)                                                                     |
| Treatment Option  | Mitigate                                                                       |
| Actions           | 1. Add output-schema conformance tests for all agent pipelines                 |
|                   | 2. Log all agent interactions to append-only audit table                       |
|                   | 3. Implement human-in-the-loop review for high-risk agent outputs (narratives) |
| Responsible Party | Aaron                                                                          |
| Target Completion | P9 (agent hardening); logging is partially implemented                         |
| Status            | In Progress — structured output schemas and citation-only design are active    |

### R-008 — Unauthorized API Access

| Field             | Value                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| Risk Level        | Medium (8)                                                                        |
| Treatment Option  | Mitigate                                                                          |
| Actions           | 1. Add automated test ensuring all non-public API routes require `requireSession` |
|                   | 2. Implement per-endpoint rate limiting                                           |
|                   | 3. Add API access logging for security monitoring                                 |
| Responsible Party | Aaron                                                                             |
| Target Completion | Auth coverage test by P8 completion; rate limiting by P9                          |
| Status            | In Progress — requireSession middleware and role checks are implemented           |

### R-009 — Insider Threat (Contractor / AI Agent)

| Field             | Value                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| Risk Level        | Medium (8)                                                            |
| Treatment Option  | Mitigate                                                              |
| Actions           | 1. Enforce branch protection rules (no self-merge, require PR review) |
|                   | 2. Conduct periodic access review (quarterly)                         |
|                   | 3. Verify AI agents cannot modify or delete audit log entries         |
|                   | 4. Implement privileged-action alerting                               |
| Responsible Party | Aaron                                                                 |
| Target Completion | Branch protection by P8; access review process ongoing                |
| Status            | In Progress — append-only audit logs and PR review process are active |

### R-010 — Service Provider Outage (Anthropic, GitHub, Vercel)

| Field             | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Risk Level        | Medium (9)                                                             |
| Treatment Option  | Accept (with monitoring)                                               |
| Actions           | 1. Document SLA expectations for each critical provider                |
|                   | 2. Implement circuit-breaker pattern for AI API calls                  |
|                   | 3. Ensure core CRUD workflows function without AI subsystem            |
|                   | 4. Set up status-page monitoring and alerting for critical providers   |
| Responsible Party | Aaron                                                                  |
| Target Completion | Circuit-breaker by P9; documentation ongoing                           |
| Status            | In Progress — graceful degradation patterns exist; formal docs pending |

### R-011 — Regulatory Non-Compliance (ATO / AusIndustry)

| Field             | Value                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Risk Level        | High (10)                                                                                |
| Treatment Option  | Mitigate                                                                                 |
| Actions           | 1. Maintain automated compliance checks for forensic metadata in CI                      |
|                   | 2. Conduct periodic review against current ATO R&DTI guidance                            |
|                   | 3. Preserve Body by Michael evidentiary standard across all claim-bearing tables         |
|                   | 4. Ensure `hypothesis_formed_at` immutability trigger is tested in migration tests       |
| Responsible Party | Aaron                                                                                    |
| Target Completion | Ongoing — compliance checks active; periodic ATO guidance review quarterly               |
| Status            | Implemented — forensic metadata, immutable timestamps, and append-only logs are in place |

### R-012 — Ransomware on Production

| Field             | Value                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| Risk Level        | Medium (5)                                                                   |
| Treatment Option  | Mitigate                                                                     |
| Actions           | 1. Store backups in a separate cloud account with independent credentials    |
|                   | 2. Test DR restoration procedure (T2.4)                                      |
|                   | 3. Enforce MFA on all cloud provider accounts                                |
|                   | 4. Ensure production infrastructure uses managed services with auto-patching |
| Responsible Party | Aaron                                                                        |
| Target Completion | T2.4 (DR procedure); MFA enforcement immediate                               |
| Status            | In Progress — immutable backups exist; DR procedure documentation pending    |

### R-013 — Denial of Service

| Field             | Value                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| Risk Level        | Medium (6)                                                                       |
| Treatment Option  | Mitigate                                                                         |
| Actions           | 1. Configure explicit rate limits per API endpoint                               |
|                   | 2. Set up traffic anomaly alerting                                               |
|                   | 3. Verify cloud provider DDoS protection is enabled and configured               |
| Responsible Party | Aaron                                                                            |
| Target Completion | Rate limiting by P9; alerting by P9                                              |
| Status            | Planned — cloud provider DDoS protection is active; explicit rate limits pending |

### R-015 — Loss of Encryption Keys

| Field             | Value                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| Risk Level        | Medium (8)                                                                           |
| Treatment Option  | Mitigate                                                                             |
| Actions           | 1. Implement automated secret rotation schedule (T1.5)                               |
|                   | 2. Document key recovery procedure with step-by-step runbook                         |
|                   | 3. Test key recovery procedure annually                                              |
|                   | 4. Ensure key escrow credentials are stored in a separate secure vault               |
| Responsible Party | Aaron                                                                                |
| Target Completion | T1.5 (secrets rotation); recovery documentation by P8 completion                     |
| Status            | In Progress — secrets rotation procedure exists (T1.5); formal recovery docs pending |

## Excluded Risks (Accepted — Low)

| Risk ID | Risk Level | Justification                                                                    |
| ------- | ---------- | -------------------------------------------------------------------------------- |
| R-014   | Low (3)    | Email is transactional-only with DKIM/SPF/DMARC configured. Monitored quarterly. |

## Treatment Summary

| Status      | Count | Risk IDs                                                             |
| ----------- | ----- | -------------------------------------------------------------------- |
| Implemented | 1     | R-011                                                                |
| In Progress | 10    | R-001, R-002, R-005, R-006, R-007, R-008, R-009, R-010, R-012, R-015 |
| Planned     | 3     | R-003, R-004, R-013                                                  |

## Change Log

| Date       | Change                                | Author |
| ---------- | ------------------------------------- | ------ |
| 2026-05-06 | Initial treatment plan created (v1.0) | Aaron  |
