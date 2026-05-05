# Security Findings Register

**Date created:** 2026-05-06
**Last updated:** 2026-05-06
**Scope:** All security findings from pentests, audits, vulnerability assessments, and internal security reviews

---

## Overview

This document serves as a **running register** of all security findings across the CPA Platform lifecycle. Each finding is tracked from discovery through closure, with linked remediation evidence.

### Purpose

- **ISO 27001 Annex A.12.6.1 compliance:** Internal audit records
- **Audit trail:** Historical record of all security issues and response times
- **Metrics:** Trending severity distribution, time-to-resolution, repeat issues
- **Accountability:** Owner and closure evidence for each finding

---

## Triage Service Level Agreements (SLAs)

All findings are subject to the following response and remediation timelines:

| Severity     | Definition                                               | Initial Response | Fix Deadline           | Examples                                                                    |
| ------------ | -------------------------------------------------------- | ---------------- | ---------------------- | --------------------------------------------------------------------------- |
| **Critical** | Gate-blocking; production outage or data breach risk     | 24 hours         | 7 days                 | RLS bypass; auth bypass; unauthenticated data access                        |
| **High**     | Significant security flaw; reasonable exploit path       | 48 hours         | 14 days                | SQL injection; privilege escalation; token prediction                       |
| **Medium**   | Exploitable but low likelihood; requires user action     | 5 business days  | 30 days post-launch    | Weak password validation; missing rate limiting; XSS with user interaction  |
| **Low**      | Theoretical or minimal business impact; no clear exploit | 14 business days | 90 days or accept risk | Outdated dependency; missing security headers; minor information disclosure |

### SLA Exceptions

- **Out-of-scope services** (e.g. third-party SaaS): No SLA, logged for awareness
- **Accepted risk:** Documented waiver signed by security lead + product lead (see "Closure" column)
- **Force majeure:** Infrastructure outage or vendor unavailability (documented)

---

## Findings Table

| ID                                    | Severity | Source | Title | Status | Date Found | Date Closed | Owner | Related PR/Commit | Notes |
| ------------------------------------- | -------- | ------ | ----- | ------ | ---------- | ----------- | ----- | ----------------- | ----- |
| _[To be populated during engagement]_ |          |        |       |        |            |             |       |                   |       |

---

## Findings Detail Section

### Template: F-00X

Use this template when adding a new finding to the register above.

**ID:** F-00X
**Severity:** [Critical / High / Medium / Low]
**Source:** [pentest / audit / internal / vulnerability scanner]
**Title:** [Brief title, max 80 chars]
**Status:** [open / in-progress / closed / accepted]
**Date Found:** YYYY-MM-DD
**Date Closed:** YYYY-MM-DD (or N/A if open)
**Owner:** [Team or individual responsible for fix]
**Related PR/Commit:** [Link to GitHub PR or commit; or N/A]

**Summary:**
[2–3 sentences describing the vulnerability, affected component, and business impact]

**Attack Vector:**
[e.g. Authenticated API call to `/v1/tenants/{tenant_id}/claims` with JWT from user in Tenant B]

**Reproduction Steps:**

1. [Step 1]
2. [Step 2]
   ...

**Expected Behavior:**
[What the system should do]

**Actual Behavior:**
[What it does instead]

**Root Cause:**
[Technical explanation: e.g. RLS policy missing tenant_id check in WHERE clause]

**Remediation:**
[Fix applied: code change, configuration, architecture update]

**Verification:**
[How the fix was tested and validated: re-test confirmation, code review, automated test coverage]

**CVSS v3.1 Score:**
[e.g. 7.5 (High)]

**References:**
[CWE-ID, OWASP Top 10, external advisory]

**Acceptance Notes (if applicable):**
[Documented reason for accepting the risk; sign-off by authorized parties; target review date]

---

## Metrics Dashboard

### Cumulative Findings by Severity

| Severity  | Total | Closed | Open  | Accepted Risk |
| --------- | ----- | ------ | ----- | ------------- |
| Critical  | 0     | 0      | 0     | 0             |
| High      | 0     | 0      | 0     | 0             |
| Medium    | 0     | 0      | 0     | 0             |
| Low       | 0     | 0      | 0     | 0             |
| **Total** | **0** | **0**  | **0** | **0**         |

### Time-to-Resolution (Mean)

| Severity | Mean Days to Close | Target SLA (Days) | Variance |
| -------- | ------------------ | ----------------- | -------- |
| Critical | N/A                | 7                 | —        |
| High     | N/A                | 14                | —        |
| Medium   | N/A                | 30                | —        |
| Low      | N/A                | 90                | —        |

---

## Finding Sources

### Pentest Engagements

1. **2026-Q2 Pentest (Cobalt.io or TBD)**
   - Status: Planned
   - Report Location: `docs/iso27001/security-testing/pentest-2026-q2.md`

### Internal Security Audits

1. **Dependency scanning (Dependabot)**
   - Automated; findings logged as Low (unless elevated by severity assessment)

2. **Code review security concerns**
   - Flagged during peer review; entered as Medium or Low unless exploit path is clear

### Third-party Audits

1. **ISO 27001 compliance audit**
   - Scheduled for Q3 2026
   - Auditor findings logged with source designation

---

## Workflows

### Finding Discovery → Triage → Fix → Verification

1. **Discovery (Test, Audit, or Code Review)**
   - Tester or reviewer documents finding in temporary tracking (Slack thread, GitHub issue, or vendor report)

2. **Triage (Security Lead + Owner)**
   - Severity assigned using CVSS v3.1 and business context
   - Owner identified (backend, frontend, infra team)
   - SLA calculated from date found
   - Finding added to this register with `Status: open`

3. **Development and Code Review**
   - Owner creates feature branch (e.g. `fix/pentest-f-001-rls-bypass`)
   - Fix implemented with test coverage
   - Status updated to `in-progress` in register
   - PR reviewed and merged to `main`

4. **Deployment and Verification**
   - Fix deployed to staging (or production, depending on severity)
   - Tester or security lead validates fix against PoC
   - Status updated to `closed` with closure date and verification notes
   - Related PR/Commit link added to register

5. **Metrics and Closure**
   - Calculate time-to-resolution
   - Update metrics dashboard
   - Archive finding documentation if required

### Risk Acceptance Workflow

If a finding cannot be fixed by SLA deadline:

1. **Risk Assessment Document (internal)**
   - Owner + Security Lead document: why fix is deferred, residual risk, mitigation strategy

2. **Acceptance Sign-Off**
   - Security Lead and Product Lead (or CTO) sign off
   - Documented in "Acceptance Notes" field in register

3. **Monitoring and Review**
   - Marked as `Status: accepted`
   - Target review date set (e.g. 6 months post-launch)
   - Periodically re-assessed in security reviews

---

## Related Documents

- **Pentest scope:** `docs/iso27001/security-testing/pentest-2026-q2.md`
- **ISO 27001 policy:** `docs/iso27001/` (parent directory)
- **Incident response:** `docs/incident-response/` (see policy for escalation)
- **Security team contacts:** See pentest engagement doc (Appendix: Contact Information)

---

## Appendix: Finding ID Numbering Scheme

- **F-001 to F-099:** Pentest findings (Q2 2026)
- **F-100 to F-199:** Internal audit findings
- **F-200 to F-299:** Dependency / vulnerability scanner findings
- **F-300+:** Reserved for future audit types

Next available ID: **F-001**

---

## Revision History

| Date       | Author          | Change                                                         |
| ---------- | --------------- | -------------------------------------------------------------- |
| 2026-05-06 | Claude Opus 4.6 | Initial template creation; register opened for findings intake |
