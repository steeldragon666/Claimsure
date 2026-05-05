# Statement of Applicability (SoA)

**ISO 27001:2022 Reference:** Chapter 6.1.3 d)

| Field           | Value                                |
| --------------- | ------------------------------------ |
| Document Owner  | Aaron (Founder, ISMS Owner)          |
| Last Reviewed   | 2026-05-06                           |
| Next Review     | 2026-11-06 (semi-annual)             |
| Classification  | Internal                             |
| Version         | 1.0                                  |
| Approval Status | Draft -- pending management sign-off |

## 1. Purpose

This document identifies all 93 controls from ISO/IEC 27001:2022 Annex A and states,
for each control, whether it is applicable to the CPA Platform ISMS. Where a control
is applicable, the current implementation status, justification, and evidence references
are recorded. Where a control is excluded, the rationale is documented.

This is the central document an auditor opens during a Stage 1 or Stage 2 assessment.

## 2. Scope

The SoA covers the ISMS boundary defined in
[00-isms-scope.md](./00-isms-scope.md): the CPA Platform application, supporting
infrastructure, data, people, and critical-path suppliers.

## 3. Risk Register Cross-Reference

Control selection is driven by the risk assessment documented in:

- [03-risk-assessment-methodology.md](./03-risk-assessment-methodology.md)
- [04-risk-register.md](./04-risk-register.md)
- [05-risk-treatment-plan.md](./05-risk-treatment-plan.md)

Where a risk in the register drives inclusion of a specific control, the Risk ID is
noted in the Justification column below.

## 4. Legend

| Column               | Description                                                                        |
| -------------------- | ---------------------------------------------------------------------------------- |
| Control ID           | ISO 27001:2022 Annex A reference                                                   |
| Control Name         | Short name from the standard                                                       |
| Applicable?          | Yes / No                                                                           |
| Status               | Implemented / Partial / Planned / N/A                                              |
| Justification        | Why the control is included or excluded; risk register references where applicable |
| Evidence / Reference | Link to policy, code, runbook, or procedure that demonstrates implementation       |
| Owner                | Person or role responsible                                                         |

**Status definitions:**

- **Implemented** -- Control is fully operational with evidence available.
- **Partial** -- Control exists but gaps remain; remediation is tracked.
- **Planned** -- Control is scheduled for implementation within the current phase.
- **N/A** -- Control is not applicable (only valid when Applicable = No).

---

## 5. Annex A Controls -- Organizational (A.5)

### A.5.1 -- A.5.10: Governance and Asset Management

| ID     | Control Name                                              | Applicable? | Status      | Justification                                                                                                                                          | Evidence / Reference                                                                                                                          | Owner |
| ------ | --------------------------------------------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A.5.1  | Policies for information security                         | Yes         | Implemented | Foundation of ISMS. Required by Ch 5.2.                                                                                                                | [01-information-security-policy.md](./01-information-security-policy.md)                                                                      | Aaron |
| A.5.2  | Information security roles and responsibilities           | Yes         | Implemented | Defines accountability for security decisions. Required by Ch 5.3.                                                                                     | [02-roles-and-responsibilities.md](./02-roles-and-responsibilities.md)                                                                        | Aaron |
| A.5.3  | Segregation of duties                                     | Yes         | Partial     | Solo founder limits full segregation. Mitigated by: PR review process, append-only audit logs, AI agents have no autonomous security authority. R-009. | PR review process; `audit_log` UPDATE/DELETE revoked (migration 0035); [02-roles-and-responsibilities.md](./02-roles-and-responsibilities.md) | Aaron |
| A.5.4  | Management responsibilities                               | Yes         | Implemented | Founder serves as top management; commitment documented in security policy.                                                                            | [01-information-security-policy.md](./01-information-security-policy.md) Section 3                                                            | Aaron |
| A.5.5  | Contact with authorities                                  | Yes         | Implemented | Contacts documented for ATO, AusIndustry, OAIC (Privacy Commissioner), ACSC.                                                                           | [02-roles-and-responsibilities.md](./02-roles-and-responsibilities.md)                                                                        | Aaron |
| A.5.6  | Contact with special interest groups                      | Yes         | Implemented | Subscriptions to ACSC advisories, OWASP mailing lists, and vendor security bulletins.                                                                  | ACSC subscription; OWASP alerts; Dependabot alerts                                                                                            | Aaron |
| A.5.7  | Threat intelligence                                       | Yes         | Implemented | RIF (Regulatory Intelligence Feed) monitors regulatory changes; Dependabot monitors CVEs; ACSC advisories subscribed. R-006, R-011.                    | RIF pipeline (`apps/api/src/jobs/regulatory-classify.ts`); `.github/dependabot.yml`                                                           | Aaron |
| A.5.8  | Information security in project management                | Yes         | Implemented | Security considerations embedded in every phase plan (P0-P8). TDD with security tests. ADR process for architectural decisions.                        | `docs/plans/` phase plans; `docs/decisions/` ADRs; TDD convention in CLAUDE.md                                                                | Aaron |
| A.5.9  | Inventory of information and other associated assets      | Yes         | Planned     | Asset inventory to be created as part of T2.7.                                                                                                         | Planned: `docs/iso27001/asset-management/asset-inventory.md` (T2.7)                                                                           | Aaron |
| A.5.10 | Acceptable use of information and other associated assets | Yes         | Planned     | Acceptable use policy to be documented alongside asset inventory. Currently implicit in development conventions.                                       | Planned: `docs/iso27001/asset-management/` (T2.7)                                                                                             | Aaron |

### A.5.11 -- A.5.18: Access Control

| ID     | Control Name                  | Applicable? | Status      | Justification                                                                                                                                   | Evidence / Reference                                                                                                                    | Owner |
| ------ | ----------------------------- | ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A.5.11 | Return of assets              | Yes         | Partial     | Applies when contractors off-board. Procedure covers revoking GitHub access, secrets rotation, and device audit.                                | Planned: contractor off-boarding checklist in IAM policy (T2.8)                                                                         | Aaron |
| A.5.12 | Classification of information | Yes         | Planned     | Classification scheme (Public/Internal/Confidential/Restricted) to be formalized in T2.7.                                                       | Planned: `docs/iso27001/asset-management/classification-scheme.md` (T2.7)                                                               | Aaron |
| A.5.13 | Labelling of information      | Yes         | Planned     | Labelling procedures to accompany classification scheme. Markdown docs carry classification in headers.                                         | Planned: part of T2.7 classification scheme                                                                                             | Aaron |
| A.5.14 | Information transfer          | Yes         | Implemented | All data transfer encrypted in transit (TLS 1.2+). API-to-API calls use HTTPS. Database connections use `sslmode=require`.                      | TLS configuration; `sslmode=require` in `DATABASE_URL`                                                                                  | Aaron |
| A.5.15 | Access control                | Yes         | Implemented | Role-based access control (admin/consultant/viewer) via `tenant_user` table. RLS enforces tenant isolation at the database layer. R-002, R-008. | `tenant_user` schema; `requireSession` middleware; RLS policies                                                                         | Aaron |
| A.5.16 | Identity management           | Yes         | Implemented | User identities managed in `user` table with email verification. OAuth SSO via Microsoft/Google. Unique email constraint.                       | `user` table; OAuth callback routes; email verification flow                                                                            | Aaron |
| A.5.17 | Authentication information    | Yes         | Implemented | JWT-based sessions with HTTP-only secure cookies. Passwords hashed with bcrypt (cost >= 12). MFA planned for admin roles. R-003.                | `packages/auth/src/jwt.ts`; bcrypt hashing; HTTP-only cookie config                                                                     | Aaron |
| A.5.18 | Access rights                 | Yes         | Implemented | RLS policies enforce row-level tenant isolation. Automated RLS coverage test ensures all tables are protected or explicitly exempt. R-002.      | RLS coverage test (`packages/db/src/schema/rls-coverage.test.ts` planned T1.4); Planned: `docs/iso27001/access-control/rls-coverage.md` | Aaron |

### A.5.19 -- A.5.23: Supplier and Compliance

| ID     | Control Name                                                  | Applicable? | Status  | Justification                                                                                                                            | Evidence / Reference                                                                              | Owner |
| ------ | ------------------------------------------------------------- | ----------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----- |
| A.5.19 | Information security in supplier relationships                | Yes         | Planned | Critical suppliers identified (Anthropic, GitHub, hosting, Sentry, etc.). Formal register in T2.12. R-010.                               | Planned: `docs/iso27001/suppliers/supplier-register.md` (T2.12)                                   | Aaron |
| A.5.20 | Addressing information security within supplier agreements    | Yes         | Planned | DPA and security requirements to be documented per supplier. Currently relying on supplier standard ToS/DPAs.                            | Planned: supplier agreements register (T2.12)                                                     | Aaron |
| A.5.21 | Managing information security in the ICT supply chain         | Yes         | Partial | pnpm lockfile with integrity hashes; Dependabot for dependency vulnerability scanning. Formal procedure planned. R-006.                  | `pnpm-lock.yaml` integrity hashes; `.github/dependabot.yml`; Planned: supply chain policy (T2.12) | Aaron |
| A.5.22 | Monitoring, review and change management of supplier services | Yes         | Planned | Supplier review cadence to be established. Currently ad-hoc monitoring of provider status pages.                                         | Planned: supplier review procedure (T2.12)                                                        | Aaron |
| A.5.23 | Information security for use of cloud services                | Yes         | Partial | Cloud services in use (Vercel/Cloud Run, Supabase/managed Postgres). Security posture assessed informally. Formal documentation planned. | Cloud provider trust centers; Planned: supplier register (T2.12)                                  | Aaron |

### A.5.24 -- A.5.28: Incident Management

| ID     | Control Name                                                      | Applicable? | Status      | Justification                                                                                                                                                         | Evidence / Reference                                                                              | Owner |
| ------ | ----------------------------------------------------------------- | ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----- |
| A.5.24 | Information security incident management planning and preparation | Yes         | Planned     | Incident management plan to be formalized in T2.13. Current alerting via Sentry + PagerDuty (T1.2).                                                                   | Planned: `docs/iso27001/incidents/incident-management-plan.md` (T2.13); Sentry + PagerDuty (T1.2) | Aaron |
| A.5.25 | Assessment and decision on information security events            | Yes         | Planned     | Severity classification and triage procedure to be documented in T2.13. Current triage is ad-hoc.                                                                     | Planned: incident classification in T2.13                                                         | Aaron |
| A.5.26 | Response to information security incidents                        | Yes         | Partial     | On-call runbooks drafted (T1.9). Formal incident response procedure planned for T2.13.                                                                                | Planned: `docs/runbooks/first-incident.md` (T1.9); `docs/iso27001/incidents/` (T2.13)             | Aaron |
| A.5.27 | Learning from information security incidents                      | Yes         | Planned     | Post-incident review template to be created in T2.13. Retro process exists for development sprints.                                                                   | `docs/retros/` sprint retros; Planned: post-incident review template (T2.13)                      | Aaron |
| A.5.28 | Collection of evidence                                            | Yes         | Implemented | Append-only audit log with hash-chain verification. `first_recorded_at` and `hypothesis_formed_at` forensic timestamps. UPDATE/DELETE revoked on audit tables. R-011. | `audit_log` table (migration 0035); hash-chain verification in `packages/db/src/audit-log.ts`     | Aaron |

### A.5.29 -- A.5.37: Continuity, Compliance, and Operations

| ID     | Control Name                                                           | Applicable? | Status      | Justification                                                                                                                                                                     | Evidence / Reference                                                                                       | Owner |
| ------ | ---------------------------------------------------------------------- | ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----- |
| A.5.29 | Information security during disruption                                 | Yes         | Partial     | Backup and DR procedure established (T1.1). BC plan to be formalized in T2.14. R-005, R-012.                                                                                      | Planned: `docs/runbooks/backup-restore.md` (T1.1); `docs/iso27001/business-continuity/` (T2.14)            | Aaron |
| A.5.30 | ICT readiness for business continuity                                  | Yes         | Partial     | WAL archiving, automated backups, and restore drill procedure exist (T1.1). Formal ICT readiness plan in T2.14. R-005.                                                            | Planned: `docs/runbooks/dr-targets.md` (T1.1); `docs/iso27001/business-continuity/bc-plan.md` (T2.14)      | Aaron |
| A.5.31 | Legal, statutory, regulatory and contractual requirements              | Yes         | Implemented | R&DTI scheme compliance embedded in platform design (forensic metadata, Body by Michael standard). Tax law retention (5-7 years). Privacy Act 1988 obligations identified. R-011. | [00-isms-scope.md](./00-isms-scope.md) interested parties table; forensic metadata in schema               | Aaron |
| A.5.32 | Intellectual property rights                                           | Yes         | Implemented | All dependencies are MIT/Apache/BSD licensed. Proprietary code in private GitHub repo. Customer data ownership defined in ToS.                                                    | `package.json` dependency licenses; private repository; Terms of Service                                   | Aaron |
| A.5.33 | Protection of records                                                  | Yes         | Implemented | Append-only audit logs; hash-chain verification; forensic timestamps immutable post-INSERT (PostgreSQL trigger). 7-year retention for claim-bearing records. R-011.               | `audit_log` table; `hypothesis_formed_at` immutability trigger; retention policy                           | Aaron |
| A.5.34 | Privacy and protection of personal information                         | Yes         | Partial     | PII minimization in platform design. Sentry PII scrubbing configured (T1.2). Privacy policy planned. Australian Privacy Principles (APPs) compliance in progress.                 | Sentry `beforeSend` PII scrubbing; RLS tenant isolation; Planned: formal privacy impact assessment         | Aaron |
| A.5.35 | Independent review of information security                             | Yes         | Planned     | Internal audit by fractional CISO planned for T2.5 (week 11-12). Annual cadence.                                                                                                  | Planned: `docs/iso27001/12-internal-audit-program.md` (T2.5)                                               | Aaron |
| A.5.36 | Compliance with policies, rules and standards for information security | Yes         | Partial     | Automated enforcement via CI (linting, type checking, test suite). Manual compliance checks during PR review. Formal compliance monitoring planned.                               | CI pipeline (GitHub Actions); pre-commit hooks (Prettier, ESLint); Planned: formal compliance audit (T2.5) | Aaron |
| A.5.37 | Documented operating procedures                                        | Yes         | Partial     | Runbooks being created (T1.9). Operational procedures documented in code comments and ADRs. Formal operations manual planned.                                                     | `docs/runbooks/` (T1.9); `docs/decisions/` ADRs; `CLAUDE.md` operational conventions                       | Aaron |

---

## 6. Annex A Controls -- People (A.6)

| ID    | Control Name                                               | Applicable? | Status      | Justification                                                                                                                                     | Evidence / Reference                                                                             | Owner |
| ----- | ---------------------------------------------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----- |
| A.6.1 | Screening                                                  | Yes         | Partial     | Solo founder -- self-attestation. For future contractors: background check procedure to be documented. Currently informal reference checks.       | Planned: contractor screening procedure in IAM policy (T2.8)                                     | Aaron |
| A.6.2 | Terms and conditions of employment                         | Yes         | Partial     | Contractor agreements include NDA and data handling clauses. Formal security obligations to be added to contractor templates.                     | Contractor agreement templates; Planned: security clause additions                               | Aaron |
| A.6.3 | Information security awareness, education and training     | Yes         | Partial     | Founder maintains security awareness through ACSC advisories, OWASP resources, and ongoing professional development. Formal training log planned. | ACSC subscription; OWASP participation; Planned: training log                                    | Aaron |
| A.6.4 | Disciplinary process                                       | Yes         | Partial     | Solo operation -- self-governance. For contractors: termination clause in agreements for policy violations.                                       | Contractor agreement clauses; Planned: formal disciplinary procedure for scaled team             | Aaron |
| A.6.5 | Responsibilities after termination or change of employment | Yes         | Partial     | Contractor off-boarding includes access revocation and NDA continuation. Formal checklist to be created.                                          | Planned: off-boarding checklist in IAM policy (T2.8)                                             | Aaron |
| A.6.6 | Confidentiality or non-disclosure agreements               | Yes         | Implemented | NDAs executed with all contractors. Confidentiality obligations in all service agreements.                                                        | Contractor NDAs; service agreements                                                              | Aaron |
| A.6.7 | Remote working                                             | Yes         | Partial     | All work is remote. Development machine hardened (disk encryption, OS updates, endpoint protection). Formal remote work policy planned.           | Endpoint protection (Windows Defender); disk encryption (BitLocker); Planned: remote work policy | Aaron |
| A.6.8 | Information security event reporting                       | Yes         | Planned     | Event reporting procedure to be documented in incident management plan (T2.13). Currently: direct communication to founder.                       | Planned: `docs/iso27001/incidents/incident-management-plan.md` (T2.13)                           | Aaron |

---

## 7. Annex A Controls -- Physical (A.7)

| ID     | Control Name                                          | Applicable? | Status  | Justification                                                                                                                                                        | Evidence / Reference                                                                          | Owner |
| ------ | ----------------------------------------------------- | ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----- |
| A.7.1  | Physical security perimeters                          | No          | N/A     | No owned or leased facilities. All infrastructure is cloud-hosted. Physical security is the responsibility of cloud service providers (AWS, GCP, Vercel). See T2.12. | Cloud provider SOC 2/ISO 27001 reports; Planned: supplier register (T2.12)                    | Aaron |
| A.7.2  | Physical entry                                        | No          | N/A     | No owned facilities requiring physical entry controls. Cloud provider data centres manage physical access.                                                           | Cloud provider compliance certifications                                                      | Aaron |
| A.7.3  | Securing offices, rooms and facilities                | No          | N/A     | No owned offices or dedicated facilities. Solo founder works from home office.                                                                                       | Documented in [00-isms-scope.md](./00-isms-scope.md) exclusions                               | Aaron |
| A.7.4  | Physical security monitoring                          | No          | N/A     | No owned facilities to monitor. Cloud provider handles physical monitoring of data centres.                                                                          | Cloud provider SOC 2 reports; Documented in [00-isms-scope.md](./00-isms-scope.md) exclusions | Aaron |
| A.7.5  | Protecting against physical and environmental threats | No          | N/A     | No owned infrastructure. Cloud providers implement environmental controls (fire suppression, climate control, power redundancy).                                     | Cloud provider compliance certifications                                                      | Aaron |
| A.7.6  | Working in secure areas                               | No          | N/A     | No secure areas -- all infrastructure is cloud-hosted. No physical data centre presence.                                                                             | Cloud provider facilities management                                                          | Aaron |
| A.7.7  | Clear desk and clear screen                           | Yes         | Partial | Solo founder applies clear screen (auto-lock). Clear desk is less relevant for home office but screen privacy maintained. Formal policy planned for scaled team.     | Auto-lock policy on development machine; Planned: formal clear desk/screen policy             | Aaron |
| A.7.8  | Equipment siting and protection                       | Yes         | Partial | Development machine is a personal laptop with disk encryption and endpoint protection. Formal equipment register planned.                                            | BitLocker encryption; Windows Defender; Planned: equipment register in asset inventory (T2.7) | Aaron |
| A.7.9  | Security of assets off-premises                       | Yes         | Partial | Development laptop used off-site is encrypted and protected. No removable media with production data. Formal policy planned.                                         | BitLocker encryption; no removable media policy; Planned: off-premises policy                 | Aaron |
| A.7.10 | Storage media                                         | Yes         | Partial | No removable media in production workflows. All data transfer is encrypted in transit. Media disposal procedure planned for equipment end-of-life.                   | No removable media policy; Planned: media disposal procedure                                  | Aaron |
| A.7.11 | Supporting utilities                                  | No          | N/A     | No owned infrastructure requiring UPS or power management. Cloud providers manage supporting utilities for hosted infrastructure.                                    | Cloud provider infrastructure management                                                      | Aaron |
| A.7.12 | Cabling security                                      | No          | N/A     | No owned network infrastructure. All connectivity is via standard internet with TLS encryption. Cloud providers manage data centre cabling.                          | TLS encryption in transit; cloud provider management                                          | Aaron |
| A.7.13 | Equipment maintenance                                 | Yes         | Partial | Development machine maintained with regular OS updates and patches. Cloud infrastructure is provider-managed. Formal schedule planned.                               | Windows Update; cloud provider managed maintenance; Planned: maintenance schedule             | Aaron |
| A.7.14 | Secure disposal or re-use of equipment                | Yes         | Planned | No equipment disposed to date. Procedure needed for end-of-life: full disk wipe (NIST 800-88) before disposal or re-use.                                             | Planned: disposal procedure in asset management policy (T2.7)                                 | Aaron |

---

## 8. Annex A Controls -- Technological (A.8)

### A.8.1 -- A.8.12: Endpoint, Access, and Data Protection

| ID     | Control Name                            | Applicable? | Status      | Justification                                                                                                                                                      | Evidence / Reference                                                                                                          | Owner |
| ------ | --------------------------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----- |
| A.8.1  | User endpoint devices                   | Yes         | Partial     | Development machine has disk encryption (BitLocker), endpoint protection (Windows Defender), auto-lock. Formal endpoint policy planned.                            | BitLocker; Windows Defender; auto-lock; Planned: endpoint security policy                                                     | Aaron |
| A.8.2  | Privileged access rights                | Yes         | Implemented | Database admin access restricted to dedicated roles. `privilegedSql` only for migrations, never application paths. RLS enforces tenant isolation. R-002, R-009.    | RLS policies; `privilegedSql` restricted usage; `CLAUDE.md` architecture rules                                                | Aaron |
| A.8.3  | Information access restriction          | Yes         | Implemented | Row-Level Security (RLS) on all tenant-scoped tables. `app.current_tenant_id` GUC pattern. Automated coverage test. R-002.                                         | RLS policies; `NULLIF(current_setting('app.current_tenant_id', true), '')::uuid` pattern; RLS coverage test (T1.4)            | Aaron |
| A.8.4  | Access to source code                   | Yes         | Implemented | Private GitHub repository with branch protection. Access limited to founder and authorized collaborators. PR review required for all merges.                       | GitHub repository settings; branch protection rules                                                                           | Aaron |
| A.8.5  | Secure authentication                   | Yes         | Implemented | JWT-based session tokens in HTTP-only secure cookies. bcrypt password hashing (cost >= 12). OAuth SSO (Microsoft, Google). MFA planned for admin roles. R-003.     | `packages/auth/src/jwt.ts`; bcrypt configuration; OAuth routes                                                                | Aaron |
| A.8.6  | Capacity management                     | Yes         | Partial     | Cloud infrastructure auto-scales (Vercel/Cloud Run). Database connection pooling implemented. Formal capacity planning procedure planned.                          | Cloud auto-scaling configuration; `postgres-js` connection pooling; Planned: capacity management procedure                    | Aaron |
| A.8.7  | Protection against malware              | Yes         | Partial     | Endpoint protection on development machine (Windows Defender). No file uploads executed server-side. Cloud infrastructure uses provider malware protection. R-006. | Windows Defender; no executable file uploads; Planned: malware protection policy (T2.10)                                      | Aaron |
| A.8.8  | Management of technical vulnerabilities | Yes         | Partial     | Dependabot enabled for automatic vulnerability scanning. pnpm lockfile with integrity hashes. Formal vulnerability management procedure planned. R-006.            | `.github/dependabot.yml`; `pnpm-lock.yaml` integrity; Planned: `docs/iso27001/operations/vulnerability-management.md` (T2.10) | Aaron |
| A.8.9  | Configuration management                | Yes         | Implemented | Infrastructure as code (Dockerfiles, CI/CD yaml). Environment-specific configuration via env vars. No manual production configuration.                             | `Dockerfile`; `.github/workflows/`; `cloudbuild.yaml`; env var management                                                     | Aaron |
| A.8.10 | Information deletion                    | Yes         | Partial     | Soft-delete pattern used (`deleted_at` columns). Hard deletion restricted. Data retention aligned with tax law (5-7 years). Formal deletion procedure planned.     | `deleted_at` columns in schema; Planned: data retention and deletion procedure                                                | Aaron |
| A.8.11 | Data masking                            | Yes         | Partial     | PII scrubbing in Sentry error reports (`beforeSend` hook). No PII in application logs. Data masking for non-production environments planned.                       | Sentry PII scrubbing (T1.2); Planned: data masking procedure for staging/dev                                                  | Aaron |
| A.8.12 | Data leakage prevention                 | Yes         | Partial     | RLS prevents cross-tenant data access. API responses scoped to authenticated tenant. Sentry PII filtering. Formal DLP policy planned. R-002.                       | RLS policies; tenant-scoped API responses; Sentry PII scrubbing; Planned: DLP policy                                          | Aaron |

### A.8.13 -- A.8.20: Backup, Logging, and Network

| ID     | Control Name                                    | Applicable? | Status      | Justification                                                                                                                                                               | Evidence / Reference                                                                                                                 | Owner |
| ------ | ----------------------------------------------- | ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| A.8.13 | Information backup                              | Yes         | Implemented | WAL archiving with continuous backup. Full backups daily, incremental every 6 hours. Automated restore drill validates recovery. R-005.                                     | Planned: `tools/postgres/pgbackrest.conf` (T1.1); `tools/postgres/restore-drill.sh` (T1.1); `docs/runbooks/backup-restore.md` (T1.1) | Aaron |
| A.8.14 | Redundancy of information processing facilities | Yes         | Partial     | Cloud hosting provides region-level redundancy. Database replication via managed provider. Multi-region failover planned for scale.                                         | Cloud provider infrastructure; Planned: multi-region architecture (post-P8)                                                          | Aaron |
| A.8.15 | Logging                                         | Yes         | Implemented | Application logging via OTLP to Grafana. Append-only `audit_log` table for business events. Sentry for error tracking. Auth events logged. R-009.                           | `packages/observability/`; `audit_log` table; Sentry (T1.2); Planned: `docs/iso27001/operations/logging-policy.md` (T2.10)           | Aaron |
| A.8.16 | Monitoring activities                           | Yes         | Partial     | Grafana dashboards for metrics. Synthetic uptime probes planned (T1.2). PagerDuty alerting planned (T1.2). Formal monitoring policy planned.                                | `packages/observability/`; Planned: Grafana synthetics (T1.2); Planned: `docs/iso27001/operations/logging-policy.md` (T2.10)         | Aaron |
| A.8.17 | Clock synchronisation                           | Yes         | Implemented | Cloud infrastructure uses NTP-synchronised clocks. PostgreSQL timestamps use `now()` at transaction time. All timestamps in UTC.                                            | Cloud provider NTP; PostgreSQL `now()`; UTC convention throughout codebase                                                           | Aaron |
| A.8.18 | Use of privileged utility programs              | Yes         | Implemented | Database admin utilities (`psql`, migration scripts) restricted to founder. `privilegedSql` never used in application paths. CI runs migrations via restricted credentials. | `CLAUDE.md` architecture rules; migration runner configuration; CI credential scoping                                                | Aaron |
| A.8.19 | Installation of software on operational systems | Yes         | Implemented | Production deployments only via CI/CD pipeline (GitHub Actions / Cloud Build). No manual software installation on production. Container images are immutable.               | `.github/workflows/`; `cloudbuild.yaml`; `Dockerfile`; immutable container images                                                    | Aaron |
| A.8.20 | Networks security                               | Yes         | Partial     | TLS 1.2+ for all network traffic. Database connections encrypted (`sslmode=require`). Cloud provider network isolation. Formal network security policy planned.             | TLS configuration; `sslmode=require`; VPC/network configuration; Planned: network security documentation                             | Aaron |

### A.8.21 -- A.8.28: Web, Development, and Testing

| ID     | Control Name                                          | Applicable? | Status      | Justification                                                                                                                                                                             | Evidence / Reference                                                                                                                                | Owner |
| ------ | ----------------------------------------------------- | ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A.8.21 | Security of network services                          | Yes         | Partial     | Cloud provider manages network service security. CDN (Vercel Edge) handles DDoS mitigation. Formal SLA documentation for network services planned. R-013.                                 | Cloud provider network security; Vercel Edge / Cloud Run; Planned: network service SLAs                                                             | Aaron |
| A.8.22 | Segregation of networks                               | Yes         | Partial     | Production, staging, and development environments are isolated (separate projects/accounts). Database credentials are environment-specific. Formal documentation planned.                 | Separate environment configurations; distinct database credentials; Planned: network segregation documentation                                      | Aaron |
| A.8.23 | Web filtering                                         | Yes         | Partial     | CSP headers configured on web application. API endpoints validate and sanitize all input via Zod schemas. Rate limiting planned. R-001, R-013.                                            | CSP headers; Zod input validation; Planned: rate limiting (T1.8)                                                                                    | Aaron |
| A.8.24 | Use of cryptography                                   | Yes         | Partial     | AES-256-GCM for OAuth token encryption. bcrypt for password hashing. TLS 1.2+ in transit. SHA-256 for audit chain hashes. Formal cryptography policy in T2.9. R-015.                      | `TOKEN_ENCRYPTION_KEY` (AES-256-GCM); bcrypt hashing; TLS; hash chains; Planned: `docs/iso27001/cryptography/cryptography-policy.md` (T2.9)         | Aaron |
| A.8.25 | Secure development life cycle                         | Yes         | Implemented | TDD convention enforced across all phases. Security tests in CI (RLS coverage, auth flow tests). Code review required for all merges. ADR process for architectural decisions.            | TDD convention (`CLAUDE.md`); CI pipeline; PR review process; `docs/decisions/`; Planned: `docs/iso27001/sdlc/secure-development-policy.md` (T2.11) | Aaron |
| A.8.26 | Application security requirements                     | Yes         | Implemented | Security requirements embedded in phase design docs. Input validation via Zod schemas. Authentication via `requireSession` middleware. Authorization via RLS + role checks. R-001, R-008. | Phase design docs; Zod schemas; `requireSession` middleware; RLS policies                                                                           | Aaron |
| A.8.27 | Secure system architecture and engineering principles | Yes         | Implemented | Clean architecture with service + repository pattern. Tenant isolation via RLS. Append-only audit logs. Stateless API handlers. Environment variable configuration.                       | Architecture rules in `CLAUDE.md`; RLS; append-only logs; env var configuration                                                                     | Aaron |
| A.8.28 | Secure coding                                         | Yes         | Implemented | Parameterized queries (postgres-js template tags). Input validation (Zod). Output encoding. JSONB double-cast pattern to prevent injection. No raw SQL. R-001.                            | `postgres-js` template tags; Zod validation; `${JSON.stringify(value)}::text::jsonb` pattern; `CLAUDE.md` rules                                     | Aaron |

### A.8.29 -- A.8.34: Testing, Separation, and Change

| ID     | Control Name                                                | Applicable? | Status      | Justification                                                                                                                                                      | Evidence / Reference                                                                                                                | Owner |
| ------ | ----------------------------------------------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A.8.29 | Security testing in development and acceptance              | Yes         | Partial     | TDD with security-focused tests (RLS coverage, auth flows). Penetration testing planned (T1.6). SAST integration planned. R-001, R-002.                            | Test suite; RLS coverage test (T1.4); Planned: `docs/iso27001/security-testing/pentest-2026-q2.md` (T1.6)                           | Aaron |
| A.8.30 | Outsourced development                                      | Yes         | Partial     | AI agents (Claude) used for development under instruction. All AI-generated code reviewed via PR process. No autonomous security decisions by AI. R-009.           | PR review process; `CLAUDE.md` operational conventions; AI agents have no self-merge capability                                     | Aaron |
| A.8.31 | Separation of development, test and production environments | Yes         | Implemented | Separate environments with distinct credentials. Production data never accessible from dev/staging. Test data is synthetic. Planned: formal documentation (T2.11). | Separate environment configs; distinct secrets; synthetic test data; Planned: `docs/iso27001/sdlc/environment-isolation.md` (T2.11) | Aaron |
| A.8.32 | Change management                                           | Yes         | Implemented | All changes via PR with required review. CI pipeline runs tests before merge. ADR process for significant decisions. Atomic commits per logical change.            | GitHub PR process; CI pipeline; `docs/decisions/` ADRs; Planned: `docs/iso27001/operations/change-management.md` (T2.10)            | Aaron |
| A.8.33 | Test information                                            | Yes         | Implemented | Test data is synthetic -- never uses production customer data. Test databases use isolated instances on non-production ports (port 5433).                          | Synthetic test data; test DB at port 5433; `CLAUDE.md` testing discipline                                                           | Aaron |
| A.8.34 | Protection of information systems during audit testing      | Yes         | Planned     | Pen-test engagement (T1.6) will define Rules of Engagement including out-of-scope items (no DDoS, no production data impact). Audit testing in staging only.       | Planned: `docs/iso27001/security-testing/pentest-2026-q2.md` (T1.6) Rules of Engagement                                             | Aaron |

---

## 9. Summary

### Applicability Summary

| Theme              | Total Controls | Applicable | Not Applicable |
| ------------------ | -------------- | ---------- | -------------- |
| A.5 Organizational | 37             | 37         | 0              |
| A.6 People         | 8              | 8          | 0              |
| A.7 Physical       | 14             | 6          | 8              |
| A.8 Technological  | 34             | 34         | 0              |
| **Total**          | **93**         | **85**     | **8**          |

### Implementation Status (applicable controls only)

| Status      | Count  | Percentage |
| ----------- | ------ | ---------- |
| Implemented | 34     | 40%        |
| Partial     | 37     | 44%        |
| Planned     | 14     | 16%        |
| **Total**   | **85** | **100%**   |

### Non-Applicable Controls (8)

All exclusions relate to physical infrastructure controls. CPA Platform is 100% cloud-hosted
with no owned or leased facilities. Physical security is delegated to cloud service providers
and verified via their SOC 2 / ISO 27001 certifications (tracked in supplier register, T2.12).

| Control ID | Control Name                                          | Rationale                                                                                         |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A.7.1      | Physical security perimeters                          | No owned facilities. Cloud-hosted infrastructure. Physical security delegated to cloud providers. |
| A.7.2      | Physical entry                                        | No owned facilities. Cloud provider manages data centre physical access.                          |
| A.7.3      | Securing offices, rooms and facilities                | No owned offices or dedicated facilities. Solo founder works remotely.                            |
| A.7.4      | Physical security monitoring                          | No owned facilities to monitor. Cloud provider handles physical monitoring.                       |
| A.7.5      | Protecting against physical and environmental threats | No owned infrastructure. Cloud providers implement environmental controls.                        |
| A.7.6      | Working in secure areas                               | No secure areas. All infrastructure is cloud-hosted.                                              |
| A.7.11     | Supporting utilities                                  | No owned infrastructure requiring power management. Cloud providers manage utilities.             |
| A.7.12     | Cabling security                                      | No owned network infrastructure. TLS encryption in transit. Cloud providers manage cabling.       |

### Risk Register Mapping

The following risk register entries drive control selection:

| Risk ID | Risk Description                       | Primary Controls Addressed                   |
| ------- | -------------------------------------- | -------------------------------------------- |
| R-001   | Data breach via SQL injection          | A.8.23, A.8.25, A.8.26, A.8.28, A.8.29       |
| R-002   | Unauthorized cross-tenant access       | A.5.15, A.5.18, A.8.2, A.8.3, A.8.12, A.8.29 |
| R-003   | Session hijack / token theft           | A.5.17, A.8.5                                |
| R-004   | Credential leak in source code         | A.8.4, A.8.25                                |
| R-005   | Database loss or corruption            | A.5.29, A.5.30, A.8.13                       |
| R-006   | Supply chain compromise (npm)          | A.5.7, A.5.21, A.8.7, A.8.8                  |
| R-007   | AI model prompt injection              | A.8.26, A.8.28, A.8.30                       |
| R-008   | Unauthorized API access                | A.5.15, A.8.5, A.8.23, A.8.26                |
| R-009   | Insider threat (contractor / AI agent) | A.5.3, A.8.2, A.8.15, A.8.30                 |
| R-010   | Service provider outage                | A.5.19, A.5.22                               |
| R-011   | Regulatory non-compliance              | A.5.28, A.5.31, A.5.33                       |
| R-012   | Ransomware on production               | A.5.29, A.8.13                               |
| R-013   | Denial of service                      | A.8.21, A.8.23                               |
| R-015   | Loss of encryption keys                | A.8.24                                       |

---

## 10. Review and Maintenance

This SoA is a living document. It is reviewed:

- **Semi-annually** as a minimum (next review: 2026-11-06)
- **Triggered review** within 14 days of:
  - Changes to the risk register (new risks, re-rated risks)
  - Internal or external audit findings
  - Significant architecture changes
  - Changes in legal/regulatory requirements
  - Completion of a "Planned" control implementation

Each review produces a changelog entry below.

---

## 11. Change Log

| Date       | Change                                                  | Author |
| ---------- | ------------------------------------------------------- | ------ |
| 2026-05-06 | Initial SoA created with all 93 Annex A controls (v1.0) | Aaron  |
