# Supplier Risk Register (A.5.19-A.5.22)

**ISO 27001 Reference:** Annex A controls A.5.19 (Information security in supplier relationships), A.5.20 (Addressing information security within supplier agreements), A.5.21 (Managing information security in the ICT supply chain), A.5.22 (Monitoring, review and change management of supplier services)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2026-11-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Maintain a register of all third-party suppliers that process, store, or have access to CPA Platform data. Each supplier is assessed for risk based on the sensitivity of data shared, their security certifications, and the criticality of their service.

## 2. Supplier Register

| Supplier         | Service                           | Data Shared                                | Sensitivity  | Certifications     | DPA Status       | Last Reviewed | Risk Rating |
| ---------------- | --------------------------------- | ------------------------------------------ | ------------ | ------------------ | ---------------- | ------------- | ----------- |
| Anthropic        | AI inference (Claude)             | Narrative content, expenditure summaries   | Confidential | SOC 2 Type II      | Terms of service | 2026-05-06    | Medium      |
| GitHub           | Source code hosting + CI/CD       | Source code, CI logs, PR metadata          | Internal     | SOC 2 + ISO 27001  | DPA signed       | 2026-05-06    | Low         |
| Hosting provider | Infrastructure (compute, DB, CDN) | All platform data (Restricted)             | Restricted   | Varies by provider | DPA required     | 2026-05-06    | High        |
| Sentry           | Error tracking + monitoring       | Error payloads, stack traces               | Internal     | SOC 2 Type II      | DPA signed       | 2026-05-06    | Low         |
| PagerDuty        | Incident alerting                 | Alert metadata (no customer data)          | Internal     | SOC 2 + ISO 27001  | DPA signed       | 2026-05-06    | Low         |
| Resend           | Transactional email               | Recipient email addresses, email content   | Confidential | SOC 2 Type II      | DPA signed       | 2026-05-06    | Medium      |
| DocuSign         | Webhook integration               | Webhook payload metadata                   | Internal     | SOC 2 + ISO 27001  | Terms of service | 2026-05-06    | Low         |
| Cobalt.io        | Penetration testing               | Application access, vulnerability findings | Confidential | SOC 2 Type II      | NDA + DPA signed | 2026-05-06    | Medium      |

## 3. Risk Rating Criteria

Risk ratings are assigned based on:

| Factor                 | Low                              | Medium                       | High                               |
| ---------------------- | -------------------------------- | ---------------------------- | ---------------------------------- |
| Data sensitivity       | Public / Internal                | Confidential                 | Restricted                         |
| Service criticality    | Non-critical; alternatives exist | Important; failover possible | Critical; no immediate alternative |
| Certification coverage | SOC 2 + ISO 27001                | SOC 2 only                   | No independent certification       |
| Data residency         | Australia / OECD                 | OECD with adequate DPA       | Non-OECD without DPA               |
| Incident history       | No known incidents               | Minor incidents, resolved    | Major incidents or breaches        |

## 4. Supplier Risk Details

### 4.1 Anthropic (Medium Risk)

- **Service:** AI model inference (Claude Sonnet 4.5, Claude Haiku 4.5)
- **Data shared:** Narrative content, expenditure summaries, activity descriptions — Confidential tier
- **Concern:** Client IP is transmitted to Anthropic's API for AI processing
- **Mitigations:**
  - Anthropic's data retention policy: prompts and outputs not used for training
  - Structured-output schemas constrain what the model can return
  - No Restricted-tier data (PII, raw claimant records) sent to the API
- **DPA status:** Covered by Anthropic's terms of service; formal DPA to be pursued
- **Action items:** Request formal DPA; verify data processing addendum covers Australian Privacy Act requirements

### 4.2 Hosting Provider (High Risk)

- **Service:** Compute, managed PostgreSQL, CDN, secrets management
- **Data shared:** All platform data including Restricted-tier (production database)
- **Concern:** Single point of failure for data sovereignty and availability
- **Mitigations:**
  - Provider-managed encryption at rest and in transit
  - RLS enforced at database level regardless of infrastructure access
  - Regular backups with tested restore procedures
  - Provider's certifications verified annually
- **DPA status:** Required; must cover Australian data residency requirements
- **Action items:** Verify data residency guarantees; confirm backup encryption; annual certification review

### 4.3 Resend (Medium Risk)

- **Service:** Transactional email delivery
- **Data shared:** Recipient email addresses, email subject lines, email body content
- **Concern:** Email content may contain Confidential information (invitation details, notification summaries)
- **Mitigations:**
  - Minimise data in email bodies; link to platform for detail views
  - Resend's SOC 2 certification covers data handling
- **DPA status:** DPA signed
- **Action items:** Review email templates quarterly to ensure minimal data exposure

### 4.4 Cobalt.io (Medium Risk)

- **Service:** Annual penetration testing
- **Data shared:** Application access credentials, vulnerability findings, remediation details
- **Concern:** Pen test findings are Confidential; access during testing is broad
- **Mitigations:**
  - NDA and DPA signed before engagement
  - Testing conducted against staging environment (not production)
  - Temporary credentials issued and revoked after testing
  - Findings report stored as Restricted and access-controlled
- **Action items:** Rotate all temporary credentials post-engagement; verify report secure storage

## 5. Annual Review Schedule

| Supplier         | Next Review | Reviewer |
| ---------------- | ----------- | -------- |
| Anthropic        | 2026-11-06  | Aaron    |
| GitHub           | 2026-11-06  | Aaron    |
| Hosting provider | 2026-11-06  | Aaron    |
| Sentry           | 2026-11-06  | Aaron    |
| PagerDuty        | 2026-11-06  | Aaron    |
| Resend           | 2026-11-06  | Aaron    |
| DocuSign         | 2026-11-06  | Aaron    |
| Cobalt.io        | 2026-11-06  | Aaron    |

## 6. Triggered Reviews

A supplier review is triggered outside the normal schedule when:

- The supplier suffers a publicly disclosed security incident
- The supplier changes their terms of service or data processing practices
- The CPA Platform changes the type or volume of data shared with the supplier
- The supplier's certification status changes (e.g., SOC 2 lapses)
- A new supplier is onboarded (see `onboarding-procedure.md`)

## 7. References

- ISO/IEC 27001:2022 Annex A controls A.5.19-A.5.22
- Supplier onboarding procedure (`docs/iso27001/suppliers/onboarding-procedure.md`)
- Classification scheme (`docs/iso27001/asset-management/classification-scheme.md`)
- Risk assessment methodology (`docs/iso27001/03-risk-assessment-methodology.md`)
