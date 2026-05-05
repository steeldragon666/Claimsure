# ISMS Scope Statement (ISO 27001:2022 Chapter 4)

**Document owner:** Aaron (Founder)
**Last reviewed:** 2026-05-06
**Next review:** 2026-08-06 (quarterly)
**Version:** 1.0

## 1. Purpose

Defines the boundaries and applicability of the Information Security Management System (ISMS) for CPA Platform.

## 2. Scope statement

The ISMS covers the CPA Platform application and its supporting infrastructure, including:

- **Web application** (Next.js frontend at apps/web)
- **API server** (Fastify backend at apps/api)
- **Database** (PostgreSQL with pgvector, RLS-enforced multi-tenant schema)
- **AI agent pipeline** (Anthropic Claude SDK, narrative generation, audit scoring)
- **Observability stack** (OTLP, Grafana, Sentry)
- **Regulatory Intelligence Feed** (RIF -- daily scraping, classification, alerting)
- **Integration layer** (GitHub App, DocuSign webhooks, Xero accounting sync)

Data processed:

- Customer tenant data (firm info, user accounts, roles)
- R&D Tax Incentive claimant records (subject tenants, projects, claims, activities)
- Narrative drafts, audit chains (append-only event log with hash-chain verification)
- Expenditure records and classifications
- Regulatory intelligence events

## 3. Boundaries

**In-scope:**

- CPA Platform application (web, API, database, agents, integrations)
- Supporting infrastructure (hosting, CI/CD, monitoring)
- Data: all customer claimant data, narrative drafts, audit chains, RIF events
- People: founder (Aaron), contractors, AI agents operating under instruction
- Suppliers in critical path: Anthropic, GitHub, hosting provider, email provider, monitoring providers

**Out-of-scope (justified):**

- Personal/marketing websites not touching customer data
- Customers' own infrastructure and security posture
- Third-party partner platforms beyond integration endpoints
- Internal-only development tooling not processing customer data

## 4. Interested parties (Ch 4.2)

| Party                                  | Relevant requirements/expectations                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Customers (CFO firms, R&DTI claimants) | Confidentiality of claim data; availability for audit deadlines; integrity of forensic records           |
| Regulators (AusIndustry, ATO)          | Compliance with R&DTI scheme requirements; data retention per tax law (5-7 years); audit trail integrity |
| Investors/partners                     | Assurance of security posture; ISO 27001 certification as trust signal                                   |
| Suppliers (Anthropic, GitHub, etc.)    | Compliance with their ToS; responsible API usage; data handling per DPAs                                 |
| Founder/team                           | Sustainable security practices; clear incident response; manageable compliance burden                    |

## 5. Exclusions with justification

| Exclusion                                     | Justification                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Physical security controls (A.7.3-7.4)        | No owned facilities; all infrastructure is cloud-hosted. Physical security delegated to cloud providers (covered via supplier due diligence in T2.12). |
| Teleworking physical controls (A.7.9 partial) | Solo founder; development machine hardened per endpoint policy. No shared office.                                                                      |
| Media handling (A.7.10 partial)               | No removable media in production workflows. All data transfer is encrypted in transit.                                                                 |

## 6. Document control

| Version | Date       | Author | Change                  |
| ------- | ---------- | ------ | ----------------------- |
| 1.0     | 2026-05-06 | Aaron  | Initial scope statement |
