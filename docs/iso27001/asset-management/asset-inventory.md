# Asset Inventory (A.5.9)

**ISO 27001 Reference:** Annex A control A.5.9 (Inventory of information and other associated assets)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2026-11-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Maintain a complete inventory of information assets, software, services, and infrastructure within the CPA Platform ISMS boundary. Each asset is classified per the classification scheme (`classification-scheme.md`) and assigned an owner responsible for its protection.

## 2. Information Assets

| Asset ID | Name                          | Category    | Classification | Owner | Location                            | Retention        | Disposal Method       |
| -------- | ----------------------------- | ----------- | -------------- | ----- | ----------------------------------- | ---------------- | --------------------- |
| IA-001   | Customer claimant data        | Information | Restricted     | Aaron | PostgreSQL (subject_tenant tables)  | 7 years (ATO)    | Cryptographic erasure |
| IA-002   | Narrative drafts              | Information | Confidential   | Aaron | PostgreSQL (narrative_draft)        | 7 years (ATO)    | Cryptographic erasure |
| IA-003   | Audit chain records           | Information | Restricted     | Aaron | PostgreSQL (event, audit_log)       | 7 years (ATO)    | Cryptographic erasure |
| IA-004   | RIF events                    | Information | Internal       | Aaron | PostgreSQL (regulatory_event)       | 5 years          | Secure deletion       |
| IA-005   | Source code                   | Information | Internal       | Aaron | GitHub (private repository)         | Indefinite       | Repository deletion   |
| IA-006   | OAuth tokens                  | Information | Confidential   | Aaron | PostgreSQL (AES-256-GCM encrypted)  | Session lifetime | Cryptographic erasure |
| IA-007   | Expenditure data              | Information | Confidential   | Aaron | PostgreSQL (expenditure tables)     | 7 years (ATO)    | Cryptographic erasure |
| IA-008   | AI prompt templates           | Information | Confidential   | Aaron | Source code repository              | Indefinite       | Repository deletion   |
| IA-009   | Penetration test reports      | Information | Restricted     | Aaron | Secure document storage             | 3 years          | Secure deletion       |
| IA-010   | Mapping rules                 | Information | Confidential   | Aaron | PostgreSQL (mapping_rule)           | 7 years (ATO)    | Cryptographic erasure |
| IA-011   | User profile data             | Information | Confidential   | Aaron | PostgreSQL (user table)             | Account lifetime | Secure deletion       |
| IA-012   | Tenant configuration          | Information | Internal       | Aaron | PostgreSQL (tenant table)           | Indefinite       | Secure deletion       |
| IA-013   | Narrative draft versions      | Information | Confidential   | Aaron | PostgreSQL (narrative_draft_ver.)   | 7 years (ATO)    | Cryptographic erasure |
| IA-014   | Prompt suggestion reviews     | Information | Internal       | Aaron | PostgreSQL (prompt_suggestion_rev.) | 3 years          | Secure deletion       |
| IA-015   | Architecture Decision Records | Information | Internal       | Aaron | Source code repository (docs/)      | Indefinite       | Repository deletion   |

## 3. Software Assets

| Asset ID | Name               | Category | Classification | Owner | Location           | Retention   | Disposal Method    |
| -------- | ------------------ | -------- | -------------- | ----- | ------------------ | ----------- | ------------------ |
| SW-001   | Node.js runtime    | Software | Internal       | Aaron | Application server | Per-release | Standard uninstall |
| SW-002   | Fastify framework  | Software | Internal       | Aaron | npm dependency     | Per-release | Dependency removal |
| SW-003   | Next.js framework  | Software | Internal       | Aaron | npm dependency     | Per-release | Dependency removal |
| SW-004   | postgres-js driver | Software | Internal       | Aaron | npm dependency     | Per-release | Dependency removal |
| SW-005   | Anthropic SDK      | Software | Internal       | Aaron | npm dependency     | Per-release | Dependency removal |
| SW-006   | drizzle-orm        | Software | Internal       | Aaron | npm dependency     | Per-release | Dependency removal |
| SW-007   | pnpm dependencies  | Software | Internal       | Aaron | pnpm-lock.yaml     | Per-release | Lock file update   |
| SW-008   | TypeScript         | Software | Internal       | Aaron | npm devDependency  | Per-release | Dependency removal |
| SW-009   | ESLint + Prettier  | Software | Internal       | Aaron | npm devDependency  | Per-release | Dependency removal |
| SW-010   | Turbo (monorepo)   | Software | Internal       | Aaron | npm devDependency  | Per-release | Dependency removal |

## 4. Service Assets

| Asset ID | Name                 | Category | Classification | Owner | Location          | Retention   | Disposal Method          |
| -------- | -------------------- | -------- | -------------- | ----- | ----------------- | ----------- | ------------------------ |
| SV-001   | GitHub               | Service  | Internal       | Aaron | github.com        | Indefinite  | Account decommission     |
| SV-002   | Anthropic (AI)       | Service  | Confidential   | Aaron | api.anthropic.com | Per-request | API key rotation + close |
| SV-003   | Hosting provider     | Service  | Restricted     | Aaron | Cloud platform    | Indefinite  | Account decommission     |
| SV-004   | Sentry (monitoring)  | Service  | Internal       | Aaron | sentry.io         | Per-plan    | Account decommission     |
| SV-005   | PagerDuty (alerting) | Service  | Internal       | Aaron | pagerduty.com     | Per-plan    | Account decommission     |
| SV-006   | Resend (email)       | Service  | Confidential   | Aaron | resend.com        | Per-plan    | API key rotation + close |
| SV-007   | DocuSign (webhooks)  | Service  | Internal       | Aaron | docusign.com      | Per-plan    | Webhook deregistration   |
| SV-008   | Let's Encrypt (TLS)  | Service  | Internal       | Aaron | letsencrypt.org   | 90 days     | Certificate revocation   |

## 5. Infrastructure Assets

| Asset ID | Name                | Category       | Classification | Owner | Location           | Retention  | Disposal Method                      |
| -------- | ------------------- | -------------- | -------------- | ----- | ------------------ | ---------- | ------------------------------------ |
| IN-001   | Production database | Infrastructure | Restricted     | Aaron | Cloud (PostgreSQL) | Indefinite | Cryptographic erasure + decommission |
| IN-002   | Application servers | Infrastructure | Confidential   | Aaron | Cloud platform     | Per-deploy | Instance termination                 |
| IN-003   | CDN                 | Infrastructure | Internal       | Aaron | Cloud CDN          | Per-config | Configuration removal                |
| IN-004   | CI/CD pipeline      | Infrastructure | Internal       | Aaron | GitHub Actions     | Per-run    | Workflow deletion                    |
| IN-005   | Container registry  | Infrastructure | Internal       | Aaron | Artifact Registry  | Per-image  | Image deletion                       |
| IN-006   | DNS                 | Infrastructure | Internal       | Aaron | Cloud DNS          | Indefinite | Zone deletion                        |
| IN-007   | Backup storage      | Infrastructure | Restricted     | Aaron | Cloud storage      | Per-policy | Cryptographic erasure                |

## 6. Review Process

This inventory is reviewed:

- **Semi-annually:** Full inventory reconciliation (next: 2026-11-06)
- **On change:** When new assets are introduced (new service integration, new data category, infrastructure change)
- **Post-incident:** After any security incident that reveals undocumented assets

Changes to this inventory are tracked via Git commit history and require review before merge.

## 7. References

- Classification scheme (`docs/iso27001/asset-management/classification-scheme.md`)
- Risk assessment methodology (`docs/iso27001/03-risk-assessment-methodology.md`)
- Supplier register (`docs/iso27001/suppliers/supplier-register.md`)
