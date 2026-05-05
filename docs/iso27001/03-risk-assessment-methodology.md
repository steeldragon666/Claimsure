# Risk Assessment Methodology

**ISO 27001 Reference:** Chapter 6.1 — Actions to address risks and opportunities

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

This document defines the methodology used by the CPA Platform team to identify, analyse, evaluate, and treat information security risks. It ensures a consistent, repeatable approach aligned with ISO/IEC 27001:2022 clause 6.1.2.

## 2. Scope

The methodology applies to all information assets within the CPA Platform ISMS boundary, including:

- The web application (Next.js frontend, Fastify API, PostgreSQL database)
- AI agent subsystem (Anthropic Claude models, structured-output pipelines)
- Supporting infrastructure (GitHub, Vercel/Cloud Run, Supabase, third-party SaaS)
- People and processes (development, operations, client-facing consulting workflows)

## 3. Risk Assessment Process

The assessment follows five sequential phases:

### 3.1 Asset Identification

Catalogue every information asset within scope. For each asset record:

- Asset name and description
- Asset owner
- Classification (Public / Internal / Confidential / Restricted)
- Location (cloud region, repository, service)

### 3.2 Threat and Vulnerability Identification

For each asset, identify:

- **Threats** — potential events that could harm the asset (e.g. SQL injection, insider threat, service outage)
- **Vulnerabilities** — weaknesses that a threat could exploit (e.g. missing input validation, excessive permissions)

Sources include OWASP Top 10, ACSC advisories, vendor security bulletins, internal incident history, and penetration test findings.

### 3.3 Likelihood Assessment

Rate the probability that a threat will exploit a vulnerability, using the qualitative scale below.

| Score | Label          | Description                                               |
| ----- | -------------- | --------------------------------------------------------- |
| 1     | Rare           | May occur only in exceptional circumstances (< 5% / year) |
| 2     | Unlikely       | Could occur but not expected (5–20% / year)               |
| 3     | Possible       | Might occur at some time (20–50% / year)                  |
| 4     | Likely         | Will probably occur in most circumstances (50–80% / year) |
| 5     | Almost Certain | Expected to occur frequently (> 80% / year)               |

### 3.4 Impact Assessment

Rate the consequence if the risk materialises, using the qualitative scale below.

| Score | Label        | Description                                                              |
| ----- | ------------ | ------------------------------------------------------------------------ |
| 1     | Negligible   | No measurable effect on operations or data                               |
| 2     | Minor        | Minor inconvenience; no data loss; resolved within hours                 |
| 3     | Moderate     | Partial service disruption or limited data exposure; resolved in < 1 day |
| 4     | Major        | Significant data breach, extended outage, or regulatory notice           |
| 5     | Catastrophic | Complete data loss, systemic compromise, or regulatory penalty           |

### 3.5 Risk Rating Calculation

Risk Rating = Likelihood (L) x Impact (I)

## 4. Risk Matrix (5 x 5)

|                    | Negligible (1) | Minor (2)   | Moderate (3) | Major (4)     | Catastrophic (5) |
| ------------------ | -------------- | ----------- | ------------ | ------------- | ---------------- |
| Almost Certain (5) | Medium (5)     | Medium (10) | High (15)    | Critical (20) | Critical (25)    |
| Likely (4)         | Low (4)        | Medium (8)  | High (12)    | High (16)     | Critical (20)    |
| Possible (3)       | Low (3)        | Medium (6)  | Medium (9)   | High (12)     | High (15)        |
| Unlikely (2)       | Low (2)        | Low (4)     | Medium (6)   | Medium (8)    | Medium (10)      |
| Rare (1)           | Low (1)        | Low (2)     | Low (3)      | Low (4)       | Medium (5)       |

## 5. Risk Levels and Acceptance Thresholds

| Risk Level | Score Range | Treatment Requirement                                                     |
| ---------- | ----------- | ------------------------------------------------------------------------- |
| Low        | 1 – 4       | **Accepted.** Monitor during next scheduled review.                       |
| Medium     | 5 – 9       | **Treatment required.** Implement controls within 90 days.                |
| High       | 10 – 16     | **Treatment required.** Implement controls within 30 days.                |
| Critical   | 17 – 25     | **Immediate treatment.** Escalate to management; remediate within 7 days. |

Residual risks that remain at Medium or above after treatment must be formally accepted by the risk owner with documented justification.

## 6. Treatment Options

For each risk above the acceptance threshold, one or more of the following strategies is selected:

| Option       | Description                                                   |
| ------------ | ------------------------------------------------------------- |
| **Mitigate** | Implement additional controls to reduce likelihood or impact  |
| **Transfer** | Shift risk to a third party (e.g. insurance, managed service) |
| **Avoid**    | Eliminate the risk by removing the activity or asset          |
| **Accept**   | Formally accept the residual risk with management approval    |

## 7. Review Cadence

- **Full assessment:** Annually (next scheduled: 2027-05-06)
- **Triggered review:** Within 14 days of any of the following:
  - A security incident or near-miss
  - A significant architecture change (new service, new data flow, new third-party integration)
  - A change in regulatory requirements (ATO, AusIndustry, Privacy Act)
  - Completion of a penetration test or external audit
- **Continuous monitoring:** The risk register (document 04) is a living document updated as new risks are identified during sprint retrospectives and PR reviews.

## 8. Roles and Responsibilities

| Role               | Responsibility                                                             |
| ------------------ | -------------------------------------------------------------------------- |
| Risk Owner (Aaron) | Maintain the register; approve treatment plans                             |
| Developers         | Report new risks; implement technical controls                             |
| AI Agents          | Operate within structured-output guardrails; no autonomous risk acceptance |

## 9. References

- ISO/IEC 27001:2022 clause 6.1.2 — Information security risk assessment
- ISO/IEC 27005:2022 — Information security risk management
- OWASP Top 10 (2021)
- ACSC Essential Eight Maturity Model
- CPA Platform architecture docs (`docs/plans/`)
