# Management Review Template

**ISO 27001:2022 Reference:** Clause 9.3 -- Management review
**Document ID:** ISMS-08
**Version:** 1.0
**Owner:** Aaron (Founder / Top Management)
**Last reviewed:** 2026-05-06
**Next review:** 2026-08-06 (quarterly)
**Approval:** Aaron, Top Management

---

## 1. Purpose

This document defines the management review process for the CPA Platform ISMS. It provides a standardised agenda template, specifies the required inputs per ISO 27001:2022 Clause 9.3, establishes the format for recording decisions and action items, and includes a KPI dashboard template for tracking ISMS performance.

Management reviews ensure that top management evaluates the ISMS at planned intervals to confirm its continuing suitability, adequacy, effectiveness, and alignment with the organisation's strategic direction.

## 2. Review Cadence

| Frequency | Timing                          | Type                                                                       |
| --------- | ------------------------------- | -------------------------------------------------------------------------- |
| Quarterly | Last week of Mar, Jun, Sep, Dec | Standard management review                                                 |
| Ad-hoc    | As needed                       | Triggered by major incident, significant scope change, or major NC overdue |

For a solo-founder organisation, the quarterly management review is a structured self-assessment documented with the same rigour as a multi-attendee board meeting. When a fractional CISO is engaged, they attend as an advisor.

---

## 3. Agenda Template for Quarterly Management Review

Use this agenda for every quarterly management review meeting. Each section maps to ISO 27001:2022 Clause 9.3 requirements.

```
============================================================
CPA PLATFORM -- ISMS MANAGEMENT REVIEW
============================================================
Review ID    : MR-YYYY-QN (e.g., MR-2026-Q3)
Date         : YYYY-MM-DD
Time         : HH:MM -- HH:MM (AEST)
Location     : [Virtual / In-person]
Attendees    : [Names and roles]
Apologies    : [Names]
Minutes by   : [Name]
============================================================

AGENDA

1. Opening and confirmation of quorum
   - Confirm attendees and roles
   - Approve previous meeting minutes (MR-YYYY-QN-1)

2. Status of actions from previous management review
   - Review action items from prior minutes
   - For each: status (complete / in progress / overdue)
   - Escalation of overdue items

3. Changes in external and internal issues (Clause 9.3.c)
   - Regulatory changes (ATO, AusIndustry, privacy law)
   - Technology landscape changes
   - Business environment changes (new customers, markets)
   - Supplier/vendor changes
   - Threat landscape updates

4. Information security performance feedback (Clause 9.3.d)
   a. Non-conformities and corrective actions
      - Open CAR count by grade (Major / Minor / Observation)
      - CARs closed since last review
      - Overdue CARs requiring escalation
   b. Monitoring and measurement results
      - KPI dashboard review (see Section 6)
      - Trend analysis vs prior quarter
   c. Audit results
      - Internal audit findings summary
      - External audit findings (if any)
      - Audit programme adherence
   d. Fulfilment of information security objectives
      - Progress against objectives in security policy

5. Risk assessment and treatment status (Clause 9.3.e)
   - Changes to the risk register since last review
   - New risks identified
   - Risks with changed likelihood or impact
   - Treatment plan progress
   - Risks recommended for acceptance

6. Incident review (Clause 9.3.d)
   - Security incidents since last review (count by severity)
   - Incident trends and patterns
   - Post-incident review outcomes
   - Lessons learned and actions taken
   - Near-misses and observations

7. Feedback from interested parties (Clause 9.3.b)
   - Customer feedback on security matters
   - Supplier security posture changes
   - Regulatory correspondence
   - Certification body communications (if applicable)

8. Opportunities for continual improvement (Clause 9.3.f)
   - Process improvement proposals
   - Technology improvements
   - Training and awareness needs
   - Resource requirements
   - Policy or procedure updates needed

9. ISMS resource adequacy (Clause 9.3.a)
   - Current resource allocation assessment
   - Budget status for security initiatives
   - Tooling and subscription review
   - Staffing / contractor needs

10. Decisions and action items
    - Formal decisions (see Section 5 format)
    - New action items with owners and deadlines

11. Next review date confirmation

12. Meeting close
============================================================
```

---

## 4. Required Inputs per ISO 27001 Clause 9.3

The following inputs must be prepared before each management review. The ISMS Owner is responsible for compiling these materials at least 5 business days before the review date.

### 4.1 Input Checklist

| #   | Input (per Clause 9.3)                                       | Source                                                  | Prepared By          | Ready |
| --- | ------------------------------------------------------------ | ------------------------------------------------------- | -------------------- | ----- |
| 1   | Status of actions from previous management reviews           | Prior MR minutes                                        | ISMS Owner           |       |
| 2   | Changes in external and internal issues relevant to the ISMS | Risk register; regulatory monitoring; RIF feed          | ISMS Owner           |       |
| 3   | Feedback on information security performance, including:     |                                                         |                      |       |
| 3a  | -- Non-conformities and corrective actions                   | Corrective action register                              | ISMS Owner           |       |
| 3b  | -- Monitoring and measurement results                        | KPI dashboard (Section 6)                               | ISMS Owner           |       |
| 3c  | -- Audit results                                             | Audit reports in `docs/iso27001/audits/`                | Auditor / ISMS Owner |       |
| 3d  | -- Fulfilment of information security objectives             | Policy objectives tracker                               | ISMS Owner           |       |
| 4   | Feedback from interested parties                             | Customer communications; supplier reviews               | ISMS Owner           |       |
| 5   | Results of risk assessment and status of risk treatment plan | `04-risk-register.md`; `05-risk-treatment-plan.md`      | ISMS Owner           |       |
| 6   | Opportunities for continual improvement                      | Incident reviews; audit observations; staff suggestions | All participants     |       |
| 7   | Incident log and post-incident reviews                       | `docs/iso27001/incidents/incidents-log.md`              | ISMS Owner           |       |
| 8   | Resource adequacy assessment                                 | Budget tracking; tooling inventory                      | ISMS Owner           |       |
| 9   | Security metrics and KPIs                                    | KPI dashboard (Section 6)                               | ISMS Owner           |       |

### 4.2 Input Preparation Timeline

| Days Before Review | Activity                                                |
| ------------------ | ------------------------------------------------------- |
| -10                | ISMS Owner begins compiling input materials             |
| -5                 | Input pack distributed to all attendees for pre-reading |
| -2                 | Attendees submit additional agenda items or questions   |
| 0                  | Management review held                                  |
| +3                 | Draft minutes circulated for review                     |
| +5                 | Final minutes published and action items assigned       |

---

## 5. Decision and Action Item Recording Format

### 5.1 Decision Record

Each formal decision made during the review is recorded using this format:

```
Decision ID  : MR-YYYY-QN-D-NN (e.g., MR-2026-Q3-D-01)
Date         : YYYY-MM-DD
Topic        : [Brief description of the matter decided]
Context      : [Background information and options considered]
Decision     : [The specific decision made]
Rationale    : [Why this decision was made]
Impact       : [Expected effect on the ISMS]
Decided by   : [Name(s)]
```

### 5.2 Action Item Record

Each action item is recorded using this format:

```
Action ID    : MR-YYYY-QN-A-NN (e.g., MR-2026-Q3-A-01)
Date raised  : YYYY-MM-DD
Description  : [Specific, measurable action to be taken]
Owner        : [Person responsible]
Priority     : Critical / High / Medium / Low
Due date     : YYYY-MM-DD
Dependencies : [Any prerequisites or blockers]
Status       : Open / In Progress / Complete / Overdue / Cancelled
Completed    : YYYY-MM-DD (when finished)
Evidence     : [Link to evidence of completion]
```

### 5.3 Action Item Tracking

All action items from management reviews are tracked in a consolidated register:

| Action ID       | Description                                | Owner | Priority | Due Date   | Status |
| --------------- | ------------------------------------------ | ----- | -------- | ---------- | ------ |
| MR-2026-Q3-A-01 | Example: Complete KPI dashboard automation | Aaron | High     | 2026-09-30 | Open   |

Action items are reviewed at the start of each subsequent management review (Agenda item 2). Overdue items must include an explanation and revised target date.

---

## 6. KPI Dashboard Template

### 6.1 Security Incident Metrics

| Metric                               | Q-1 | Q-2 | Q-3 | Q-4 | Target      | Trend |
| ------------------------------------ | --- | --- | --- | --- | ----------- | ----- |
| Total incidents                      |     |     |     |     | 0 critical  |       |
| Sev 1 (Critical) incidents           |     |     |     |     | 0           |       |
| Sev 2 (High) incidents               |     |     |     |     | <=2/quarter |       |
| Sev 3 (Medium) incidents             |     |     |     |     | <=5/quarter |       |
| Sev 4 (Low) incidents                |     |     |     |     | Monitor     |       |
| Mean time to detect (MTTD)           |     |     |     |     | <1 hour     |       |
| Mean time to respond (MTTR)          |     |     |     |     | <4 hours    |       |
| Mean time to resolve                 |     |     |     |     | <24 hours   |       |
| Incidents with root cause identified |     |     |     |     | 100%        |       |
| Post-incident reviews completed      |     |     |     |     | 100%        |       |

### 6.2 Training and Awareness Metrics

| Metric                                          | Q-1 | Q-2 | Q-3 | Q-4 | Target             | Trend |
| ----------------------------------------------- | --- | --- | --- | --- | ------------------ | ----- |
| Security policy acknowledged (%)                |     |     |     |     | 100%               |       |
| Security awareness training completed (%)       |     |     |     |     | 100%               |       |
| Phishing simulation pass rate (%)               |     |     |     |     | >=90%              |       |
| New-joiner security induction within SLA        |     |     |     |     | 100% within 5 days |       |
| Privileged-access holders with current training |     |     |     |     | 100%               |       |

### 6.3 Audit Finding Metrics

| Metric                                            | Q-1 | Q-2 | Q-3 | Q-4 | Target    | Trend |
| ------------------------------------------------- | --- | --- | --- | --- | --------- | ----- |
| Internal audits completed vs planned              |     |     |     |     | 100%      |       |
| Major NCs open                                    |     |     |     |     | 0         |       |
| Minor NCs open                                    |     |     |     |     | <=3       |       |
| Observations open                                 |     |     |     |     | Monitor   |       |
| CARs closed on time (%)                           |     |     |     |     | >=90%     |       |
| CARs overdue                                      |     |     |     |     | 0         |       |
| Average days to close CAR (Minor)                 |     |     |     |     | <=60 days |       |
| Average days to close CAR (Major)                 |     |     |     |     | <=25 days |       |
| Repeat findings (same clause, consecutive audits) |     |     |     |     | 0         |       |

### 6.4 SLA Adherence Metrics

| Metric                                      | Q-1 | Q-2 | Q-3 | Q-4 | Target      | Trend |
| ------------------------------------------- | --- | --- | --- | --- | ----------- | ----- |
| Platform availability (%)                   |     |     |     |     | >=99.5%     |       |
| Planned downtime within maintenance windows |     |     |     |     | 100%        |       |
| Unplanned downtime incidents                |     |     |     |     | <=1/quarter |       |
| Backup success rate (%)                     |     |     |     |     | 100%        |       |
| Backup restore drill completed              |     |     |     |     | >=1/quarter |       |
| Restore drill within RTO                    |     |     |     |     | 100%        |       |
| RPO compliance (WAL gap < 5 min)            |     |     |     |     | 100%        |       |
| Vulnerability patch SLA compliance (%)      |     |     |     |     | >=95%       |       |
| Critical CVE patched within 72h (%)         |     |     |     |     | 100%        |       |
| High CVE patched within 30d (%)             |     |     |     |     | >=95%       |       |

### 6.5 Access Control Metrics

| Metric                                    | Q-1 | Q-2 | Q-3 | Q-4 | Target      | Trend |
| ----------------------------------------- | --- | --- | --- | --- | ----------- | ----- |
| Quarterly access reviews completed        |     |     |     |     | 100%        |       |
| Orphan accounts identified and resolved   |     |     |     |     | 0 remaining |       |
| Inactive accounts (no login 90d) actioned |     |     |     |     | 100%        |       |
| Privileged accounts reviewed              |     |     |     |     | 100%        |       |
| MFA adoption for admin roles (%)          |     |     |     |     | 100%        |       |
| Secrets rotated on schedule (%)           |     |     |     |     | 100%        |       |

### 6.6 Supplier and Third-Party Metrics

| Metric                                    | Q-1 | Q-2 | Q-3 | Q-4 | Target | Trend |
| ----------------------------------------- | --- | --- | --- | --- | ------ | ----- |
| Supplier register up to date              |     |     |     |     | Yes    |       |
| Suppliers with current DPA/contract       |     |     |     |     | 100%   |       |
| Supplier risk assessments current         |     |     |     |     | 100%   |       |
| Supplier security incidents impacting CPA |     |     |     |     | 0      |       |

### 6.7 Risk Management Metrics

| Metric                                    | Q-1 | Q-2 | Q-3 | Q-4 | Target     | Trend |
| ----------------------------------------- | --- | --- | --- | --- | ---------- | ----- |
| Risk register reviewed this quarter       |     |     |     |     | Yes        |       |
| High/Critical risks with active treatment |     |     |     |     | 100%       |       |
| Risk treatment actions on schedule (%)    |     |     |     |     | >=90%      |       |
| New risks identified this quarter         |     |     |     |     | Monitor    |       |
| Risks accepted without treatment          |     |     |     |     | Documented |       |

### 6.8 Interpreting Trends

Use the Trend column to indicate direction with simple text markers:

| Marker    | Meaning                                              |
| --------- | ---------------------------------------------------- |
| Improving | Metric moving toward target                          |
| Stable    | Metric holding steady at or near target              |
| Declining | Metric moving away from target -- requires attention |
| N/A       | First quarter of measurement; no trend data          |

---

## 7. Management Review Minutes Template

Use the following template for recording each quarterly management review. Store completed minutes at `docs/iso27001/mgmt-reviews/YYYY-QN-management-review.md`.

```markdown
# Management Review Minutes -- MR-YYYY-QN

**Date:** YYYY-MM-DD
**Time:** HH:MM -- HH:MM (AEST)
**Location:** [Virtual / In-person]
**Attendees:** [Names and roles]
**Apologies:** [Names]
**Minutes prepared by:** [Name]
**Status:** Draft / Final

---

## 1. Previous Minutes and Actions

Previous review: MR-YYYY-QN-1 dated YYYY-MM-DD

| Action ID         | Description   | Owner   | Due    | Status   |
| ----------------- | ------------- | ------- | ------ | -------- |
| MR-YYYY-QN-1-A-01 | [Description] | [Owner] | [Date] | [Status] |

## 2. Changes in External/Internal Issues

[Document any changes since last review]

## 3. Security Performance

### 3.1 KPI Dashboard Summary

[Insert completed KPI dashboard from Section 6 or reference the compiled dashboard]

### 3.2 Non-Conformities and Corrective Actions

| Grade       | Open at Start | Raised | Closed | Open at End |
| ----------- | ------------- | ------ | ------ | ----------- |
| Major       |               |        |        |             |
| Minor       |               |        |        |             |
| Observation |               |        |        |             |

### 3.3 Audit Results

[Summary of audit findings since last review]

### 3.4 Objective Fulfilment

[Progress against each security objective]

## 4. Risk Assessment Status

[Changes to risk register; new risks; treatment progress]

## 5. Incident Summary

| Severity | Count | Key Incidents |
| -------- | ----- | ------------- |
| Sev 1    |       |               |
| Sev 2    |       |               |
| Sev 3    |       |               |
| Sev 4    |       |               |

[Lessons learned; systemic issues identified]

## 6. Interested Party Feedback

[Customer feedback; supplier updates; regulatory correspondence]

## 7. Improvement Opportunities

[Proposals discussed and disposition]

## 8. Resource Adequacy

[Budget status; tooling needs; staffing]

## 9. Decisions

| Decision ID     | Topic | Decision | Rationale |
| --------------- | ----- | -------- | --------- |
| MR-YYYY-QN-D-01 |       |          |           |

## 10. Action Items

| Action ID       | Description | Owner | Priority | Due Date |
| --------------- | ----------- | ----- | -------- | -------- |
| MR-YYYY-QN-A-01 |             |       |          |          |

## 11. Next Review

**Date:** YYYY-MM-DD
**Preliminary focus areas:** [Any known topics for next review]

---

**Minutes approved by:** [Name, Role, Date]
```

---

## 8. Outputs of Management Review

Per ISO 27001:2022 Clause 9.3.3, the outputs of management review must include decisions related to:

1. **Continual improvement opportunities** -- documented as action items or improvement proposals
2. **Need for changes to the ISMS** -- scope changes, policy updates, resource re-allocation
3. **Resource needs** -- budget, tooling, personnel, training

All outputs are captured in the Decisions (Section 5.1) and Action Items (Section 5.2) formats and tracked to completion through subsequent reviews.

---

## 9. Records Retention

| Record Type               | Retention Period                        | Storage Location                                   |
| ------------------------- | --------------------------------------- | -------------------------------------------------- |
| Management review minutes | 5 years minimum                         | `docs/iso27001/mgmt-reviews/` (version-controlled) |
| KPI dashboard snapshots   | 3 years minimum                         | Included in minutes or linked                      |
| Decision records          | 5 years minimum                         | Included in minutes                                |
| Action item register      | Active until all items closed + 3 years | Included in minutes                                |
| Input preparation packs   | 3 years minimum                         | Linked from minutes                                |

---

## Document Control

| Version | Date       | Author | Changes         |
| ------- | ---------- | ------ | --------------- |
| 1.0     | 2026-05-06 | Aaron  | Initial release |
