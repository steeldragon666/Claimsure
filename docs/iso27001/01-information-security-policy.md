# Information Security Policy (ISO 27001:2022 Chapter 5.2)

**Document owner:** Aaron (Founder, Top Management)
**Approved by:** Aaron
**Last reviewed:** 2026-05-06
**Next review:** 2026-05-06 (annual minimum; sooner if material changes)
**Version:** 1.0

## 1. Purpose

This policy establishes the commitment of CPA Platform's management to information security and sets the strategic direction for the ISMS.

## 2. Scope

Applies to all information assets, systems, processes, and people within the ISMS scope defined in `00-isms-scope.md`.

## 3. Management commitment

As founder and top management of CPA Platform, I commit to:

- Maintaining the confidentiality, integrity, and availability of customer data entrusted to the platform
- Complying with applicable legal, regulatory, and contractual requirements (including ATO data handling obligations under the R&DTI scheme)
- Providing adequate resources for ISMS implementation and continual improvement
- Establishing measurable information security objectives and reviewing them regularly
- Ensuring all personnel (including AI agents operating under instruction) operate within defined security policies
- Fostering a culture where security incidents are reported promptly and treated as learning opportunities

**Signed:** Aaron, Founder -- 2026-05-06

## 4. Information security objectives

| Objective                              | Metric                              | Target               | Review cadence |
| -------------------------------------- | ----------------------------------- | -------------------- | -------------- |
| Maintain platform availability         | Uptime (Grafana synthetics)         | >= 99.5% monthly     | Monthly        |
| Protect customer data confidentiality  | RLS coverage audit (automated test) | 100% coverage        | Every CI run   |
| Ensure audit trail integrity           | Hash-chain verification test        | 100% pass            | Every CI run   |
| Respond to security incidents promptly | Time to acknowledge (Sev 1)         | <= 15 minutes        | Per incident   |
| Maintain up-to-date dependencies       | Critical CVE patch time             | <= 72 hours          | Per CVE        |
| Validate backup recoverability         | Restore drill success               | Pass within RTO (1h) | Monthly        |

## 5. Policy framework

This top-level policy is supported by subsidiary policies and procedures:

| Policy/Procedure           | Location                                          | ISO reference      |
| -------------------------- | ------------------------------------------------- | ------------------ |
| Access control (IAM + RLS) | `docs/iso27001/access-control/`                   | A.5.15-18, A.8.2-3 |
| Cryptography               | `docs/iso27001/cryptography/`                     | A.8.24             |
| Operations security        | `docs/iso27001/operations/`                       | A.8.6-16           |
| Secure development         | `docs/iso27001/sdlc/`                             | A.8.25-32          |
| Supplier management        | `docs/iso27001/suppliers/`                        | A.5.19-22          |
| Incident management        | `docs/iso27001/incidents/`                        | A.5.24-27          |
| Business continuity        | `docs/iso27001/business-continuity/`              | A.5.29-30          |
| Asset management           | `docs/iso27001/asset-management/`                 | A.5.9-10           |
| Risk management            | `docs/iso27001/03-risk-assessment-methodology.md` | Ch 6.1             |

## 6. Responsibilities

Defined in `02-roles-and-responsibilities.md`.

## 7. Policy violations

Any suspected or confirmed violation of this policy must be reported immediately to the ISMS owner (Aaron). Violations are investigated per the incident management plan.

## 8. Review

This policy is reviewed annually at minimum, or sooner if triggered by:

- A security incident
- Significant organizational change
- Audit findings (internal or external)
- Changes in legal/regulatory requirements

## 9. Document control

| Version | Date       | Author | Change         |
| ------- | ---------- | ------ | -------------- |
| 1.0     | 2026-05-06 | Aaron  | Initial policy |
