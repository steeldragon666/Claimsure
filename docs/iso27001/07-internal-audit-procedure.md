# Internal Audit Procedure

**ISO 27001:2022 Reference:** Clause 9.2 -- Internal audit
**Document ID:** ISMS-07
**Version:** 1.0
**Owner:** Aaron (Founder / ISMS Owner)
**Last reviewed:** 2026-05-06
**Next review:** 2026-08-06 (quarterly)
**Approval:** Aaron, Top Management

---

## 1. Purpose

This procedure establishes the internal audit programme for the CPA Platform Information Security Management System (ISMS). It ensures audits are conducted at planned intervals to determine whether the ISMS conforms to ISO 27001:2022 requirements, the organisation's own ISMS requirements, and is effectively implemented and maintained.

## 2. Scope

This procedure applies to all processes, controls, and documentation within the ISMS scope as defined in `00-isms-scope.md`. It covers:

- All ISMS clauses (4 through 10)
- All applicable Annex A controls per the Statement of Applicability (`06-statement-of-applicability.md`)
- Supporting infrastructure, applications, and operational processes

## 3. References

| Document                   | Reference                                        |
| -------------------------- | ------------------------------------------------ |
| ISO 27001:2022 Clause 9.2  | Internal audit requirements                      |
| ISO 19011:2018             | Guidelines for auditing management systems       |
| ISMS Scope                 | `docs/iso27001/00-isms-scope.md`                 |
| Statement of Applicability | `docs/iso27001/06-statement-of-applicability.md` |
| Risk Register              | `docs/iso27001/04-risk-register.md`              |
| Management Review Template | `docs/iso27001/08-management-review-template.md` |

---

## 4. Audit Programme Schedule

### 4.1 Annual Audit Cycle

The internal audit programme follows a 12-month cycle aligned to the financial year (1 July -- 30 June). All ISMS clauses and applicable Annex A controls are audited at least once per annual cycle.

| Quarter | Period   | Audit Focus                       | ISMS Clauses | Annex A Themes                                         |
| ------- | -------- | --------------------------------- | ------------ | ------------------------------------------------------ |
| Q1      | Jul--Sep | Governance and planning           | 4, 5, 6      | A.5 Organisational (selected)                          |
| Q2      | Oct--Dec | Operational controls              | 7, 8         | A.6 People, A.7 Physical, A.8 Technological (selected) |
| Q3      | Jan--Mar | Performance evaluation            | 9            | Remaining A.5 Organisational, A.8 Technological        |
| Q4      | Apr--Jun | Improvement and full-cycle review | 10           | All controls -- gap sweep                              |

### 4.2 Quarterly Review Cadence

Between full audits, quarterly reviews are conducted to:

- Verify corrective actions from prior audits are progressing on schedule
- Review any changes in risk profile, scope, or interested-party requirements
- Sample-test high-risk controls identified in `04-risk-register.md`
- Feed findings into the quarterly management review (see `08-management-review-template.md`)

| Review    | Timing           | Activities                                                    |
| --------- | ---------------- | ------------------------------------------------------------- |
| Q1 Review | End of September | Corrective action status; scope-change assessment             |
| Q2 Review | End of December  | Mid-cycle progress check; high-risk control sampling          |
| Q3 Review | End of March     | Performance metrics review; audit-finding trend analysis      |
| Q4 Review | End of June      | Full-cycle closure; annual programme effectiveness assessment |

### 4.3 Unscheduled Audits

Unscheduled audits may be triggered by:

- A major security incident (Sev 1 or Sev 2)
- Significant changes to the ISMS scope or architecture
- Major non-conformity remaining unresolved beyond its remediation deadline
- Regulatory or customer-driven audit requests
- Findings from management review requiring immediate verification

---

## 5. Auditor Independence Requirements

### 5.1 Independence Principle

Per ISO 27001:2022 Clause 9.2, auditors must not audit their own work. For a solo-founder organisation, this means:

- **Internal audits must be conducted by an independent party** -- a fractional CISO, external consultant, or qualified contractor who is not responsible for the day-to-day operation of the controls being audited.
- The founder (Aaron) may participate as an interviewee and evidence provider but must NOT serve as auditor for any control they own or operate.

### 5.2 Auditor Qualifications

Internal auditors must demonstrate:

| Requirement            | Minimum Standard                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Knowledge of ISO 27001 | Certified (e.g., ISO 27001 Lead Auditor) or demonstrable equivalent experience                                    |
| Audit principles       | Familiarity with ISO 19011:2018                                                                                   |
| Technical competence   | Sufficient understanding of SaaS platforms, cloud infrastructure, and database security to evaluate controls      |
| Independence           | No direct involvement in designing, implementing, or operating the controls under audit within the past 12 months |
| Confidentiality        | Signed NDA covering all ISMS documentation and audit findings                                                     |

### 5.3 Auditor Selection Process

1. Identify candidate auditors (fractional CISO firms, independent consultants, compliance platforms with audit services)
2. Verify qualifications against Section 5.2 criteria
3. Confirm no conflicts of interest
4. Execute engagement agreement including NDA, scope, timeline, and deliverables
5. Provide auditor with access to ISMS documentation, evidence, and relevant personnel

### 5.4 Recommended Engagement Model

| Option                 | Description                                                                 | Estimated Cost           | Best For                   |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------ | -------------------------- |
| Fractional CISO        | Part-time security leader on retainer; conducts audit as part of engagement | $3,000--$5,000 per cycle | Ongoing advisory + audit   |
| Independent consultant | One-off audit engagement                                                    | $2,000--$4,000 per cycle | Cost-conscious; audit-only |
| Compliance platform    | Vanta, Drata, Secureframe -- automated evidence collection + human audit    | $5,000--$15,000/year     | Scaling beyond solo        |

---

## 6. Audit Checklist Template

The following checklist covers all ISMS clauses (4--10). Auditors use this as a minimum baseline; additional control-specific checks are drawn from the Statement of Applicability.

### 6.1 Clause 4 -- Context of the Organisation

| Ref | Check Item                                                                       | Evidence Required                              | Status | Finding |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------- | ------ | ------- |
| 4.1 | Are external and internal issues relevant to the ISMS identified and documented? | `00-isms-scope.md` Section: Context            |        |         |
| 4.2 | Are interested parties and their requirements identified?                        | `00-isms-scope.md` Section: Interested parties |        |         |
| 4.3 | Is the ISMS scope clearly defined including boundaries and applicability?        | `00-isms-scope.md` Section: Scope statement    |        |         |
| 4.4 | Is the ISMS established, implemented, maintained, and continually improved?      | Overall ISMS documentation suite               |        |         |

### 6.2 Clause 5 -- Leadership

| Ref | Check Item                                                                         | Evidence Required                                              | Status | Finding |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ | ------- |
| 5.1 | Does top management demonstrate leadership and commitment to the ISMS?             | `01-information-security-policy.md`; management review minutes |        |         |
| 5.2 | Is there a documented information security policy appropriate to the organisation? | `01-information-security-policy.md`                            |        |         |
| 5.3 | Are roles, responsibilities, and authorities assigned and communicated?            | `02-roles-and-responsibilities.md`                             |        |         |

### 6.3 Clause 6 -- Planning

| Ref   | Check Item                                                                        | Evidence Required                                               | Status | Finding |
| ----- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------ | ------- |
| 6.1.1 | Are risks and opportunities identified through a documented methodology?          | `03-risk-assessment-methodology.md`                             |        |         |
| 6.1.2 | Is a risk assessment performed and documented?                                    | `04-risk-register.md`                                           |        |         |
| 6.1.3 | Is a risk treatment plan documented with selected controls justified?             | `05-risk-treatment-plan.md`; `06-statement-of-applicability.md` |        |         |
| 6.2   | Are information security objectives established at relevant functions and levels? | `01-information-security-policy.md` Section: Objectives         |        |         |
| 6.3   | Are changes to the ISMS planned and managed?                                      | Change management evidence; ADRs in `docs/decisions/`           |        |         |

### 6.4 Clause 7 -- Support

| Ref | Check Item                                                                                         | Evidence Required                                                        | Status | Finding |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------ | ------- |
| 7.1 | Are resources determined and provided for the ISMS?                                                | Budget records; tooling subscriptions; engagement contracts              |        |         |
| 7.2 | Is competence of persons performing ISMS work determined and maintained?                           | Auditor qualifications; training records                                 |        |         |
| 7.3 | Are persons aware of the security policy, their contribution, and implications of non-conformance? | Policy acknowledgement records; onboarding checklist                     |        |         |
| 7.4 | Are internal and external communications regarding the ISMS determined?                            | Communication plan; incident comms procedure                             |        |         |
| 7.5 | Is documented information created, updated, and controlled appropriately?                          | Document control metadata (version, owner, review date) on all ISMS docs |        |         |

### 6.5 Clause 8 -- Operation

| Ref | Check Item                                                                | Evidence Required                                              | Status | Finding |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ | ------- |
| 8.1 | Are operational processes planned, implemented, and controlled?           | Runbooks; CI/CD pipeline configuration; deployment procedures  |        |         |
| 8.2 | Are information security risk assessments performed at planned intervals? | `04-risk-register.md` review dates; quarterly review records   |        |         |
| 8.3 | Is the risk treatment plan implemented?                                   | Control implementation evidence per SoA; treatment plan status |        |         |

### 6.6 Clause 9 -- Performance Evaluation

| Ref | Check Item                                                        | Evidence Required                                          | Status | Finding |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------- | ------ | ------- |
| 9.1 | Is ISMS performance monitored, measured, analysed, and evaluated? | KPI dashboard; monitoring metrics; Sentry/Grafana reports  |        |         |
| 9.2 | Are internal audits conducted at planned intervals?               | This procedure; audit reports in `docs/iso27001/audits/`   |        |         |
| 9.3 | Does top management review the ISMS at planned intervals?         | Management review minutes in `docs/iso27001/mgmt-reviews/` |        |         |

### 6.7 Clause 10 -- Improvement

| Ref  | Check Item                                                    | Evidence Required                                                           | Status | Finding |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ | ------- |
| 10.1 | Are non-conformities identified and corrective actions taken? | Corrective action log; NC tracking records                                  |        |         |
| 10.2 | Is the ISMS continually improved?                             | Trend analysis; improvement actions from management review; lessons learned |        |         |

---

## 7. Non-Conformity Grading

### 7.1 Grading Definitions

| Grade                    | Definition                                                                                                                                                                             | Examples                                                                                                                                                        | Required Response                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Major Non-Conformity** | A control or requirement is entirely absent, completely ineffective, or there is a systematic failure to implement a required process. Poses significant risk to information security. | Missing risk assessment; no access control on production database; security policy does not exist; complete absence of incident management process              | Corrective action plan within **5 business days**; remediation within **30 calendar days**; verification audit required           |
| **Minor Non-Conformity** | A control exists but is partially implemented, inconsistently applied, or evidence is incomplete. Does not pose immediate significant risk but weakens the ISMS.                       | Risk register exists but has not been reviewed in 6+ months; backup procedure documented but restore drill not performed; policy exists but missing review date | Corrective action plan within **10 business days**; remediation within **90 calendar days**; verification at next scheduled audit |
| **Observation**          | An area where improvement is recommended. The control meets minimum requirements but could be strengthened. Not a failure to conform.                                                  | Documentation could be clearer; process works but is manual where automation is feasible; additional monitoring would improve detection capability              | Logged for consideration; addressed at management discretion; reviewed at next management review                                  |

### 7.2 Escalation Criteria

- Three or more minor non-conformities within the same ISMS clause may be escalated to a major non-conformity at the auditor's discretion.
- Any non-conformity directly resulting in a security incident is automatically classified as major.
- A minor non-conformity that remains unresolved beyond its remediation deadline is escalated to major.

---

## 8. Corrective Action Tracking Procedure

### 8.1 Corrective Action Record Format

Each non-conformity generates a Corrective Action Record (CAR):

```
CAR ID        : CAR-YYYY-NNN (e.g., CAR-2026-001)
Audit ref     : Audit report ID and finding number
Date raised   : YYYY-MM-DD
Raised by     : Auditor name
Grade         : Major / Minor / Observation
Clause/Control: ISO 27001 clause or Annex A control reference
Description   : Factual description of the non-conformity
Root cause    : Analysis of why the non-conformity occurred
Corrective
  action plan : Specific steps to resolve the non-conformity
Owner         : Person responsible for implementation
Target date   : Deadline for completion
Status        : Open / In Progress / Implemented / Verified / Closed
Verification  : Evidence that corrective action is effective
Verified by   : Auditor name
Verified date : YYYY-MM-DD
```

### 8.2 Corrective Action Workflow

```
[NC Identified by Auditor]
         |
         v
[CAR Created + Graded]
         |
         v
[Root Cause Analysis] --- Owner identifies why the NC occurred
         |
         v
[Corrective Action Plan] --- Owner proposes specific remediation steps
         |
         v
[Approval] --- ISMS Owner reviews and approves the plan
         |
         v
[Implementation] --- Owner executes the corrective actions
         |
         v
[Evidence Collection] --- Owner documents evidence of implementation
         |
         v
[Verification Audit] --- Auditor verifies effectiveness
         |                   |
    [PASS]              [FAIL]
         |                   |
         v                   v
   [CAR Closed]     [Re-open CAR; revise plan]
```

### 8.3 Tracking Register

All CARs are tracked in a central register maintained at `docs/iso27001/audits/corrective-action-register.md`:

| CAR ID       | Audit   | Grade | Clause | Description (summary)             | Owner | Target Date | Status | Verified |
| ------------ | ------- | ----- | ------ | --------------------------------- | ----- | ----------- | ------ | -------- |
| CAR-2026-001 | 2026-Q3 | Minor | 9.1    | KPI dashboard not yet operational | Aaron | 2026-09-30  | Open   | --       |

### 8.4 Reporting and Escalation

- **Weekly**: Owner updates CAR status during the remediation period.
- **Quarterly**: All open CARs are reviewed at the management review meeting (see `08-management-review-template.md`).
- **Overdue CARs**: If a CAR exceeds its target date:
  - Minor: ISMS Owner is notified; new target date set (maximum 30-day extension).
  - Major: Escalated to management review as an urgent agenda item; unscheduled audit may be triggered.

### 8.5 Closure Criteria

A CAR may be closed when:

1. The corrective action has been fully implemented
2. Evidence of implementation has been documented
3. The auditor (or independent reviewer) has verified the action is effective
4. The root cause has been addressed (not just the symptom)
5. The ISMS Owner has approved closure

---

## 9. Audit Reporting

### 9.1 Audit Report Template

Each audit produces a formal report stored at `docs/iso27001/audits/YYYY-QN-internal-audit-report.md` containing:

1. **Header**: Audit ID, date range, auditor(s), scope
2. **Executive summary**: Overall ISMS health assessment; key findings
3. **Methodology**: Interview, document review, sample testing, technical verification
4. **Findings**: Each finding with clause reference, evidence examined, grade, and recommendation
5. **Non-conformity summary**: Count by grade (Major / Minor / Observation)
6. **Corrective action records**: CARs raised during this audit
7. **Prior audit follow-up**: Status of CARs from previous audits
8. **Positive observations**: Controls found to be particularly effective
9. **Conclusion and recommendation**: Auditor's overall assessment; readiness opinion for certification (if applicable)

### 9.2 Audit Evidence Retention

- Audit reports are retained for a minimum of **3 years**
- Supporting evidence (screenshots, query outputs, configuration snapshots) is retained alongside audit reports
- All audit documentation is version-controlled in the repository under `docs/iso27001/audits/`

---

## 10. Continual Improvement

The audit programme itself is subject to review and improvement:

- After each audit cycle, the ISMS Owner assesses programme effectiveness
- Auditor feedback on programme structure is collected and considered
- The audit schedule is adjusted based on risk profile changes, prior findings, and organisational changes
- Programme improvements are documented and tracked through the management review process

---

## Document Control

| Version | Date       | Author | Changes         |
| ------- | ---------- | ------ | --------------- |
| 1.0     | 2026-05-06 | Aaron  | Initial release |
