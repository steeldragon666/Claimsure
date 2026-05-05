# Tabletop Exercise — 2026 Q3

**ISO 27001 Reference:** Annex A controls A.5.29 (Information security during disruption), A.5.30 (ICT readiness for business continuity)

| Field          | Value                                              |
| -------------- | -------------------------------------------------- |
| Document Owner | Aaron                                              |
| Classification | Internal                                           |
| Version        | 1.0 (Template)                                     |
| Status         | Template — to be completed during Q3 2026 exercise |

## Exercise Details

| Field        | Value               |
| ------------ | ------------------- |
| Date         | TBD (Q3 2026)       |
| Facilitator  | Aaron               |
| Participants | _To be completed_   |
| Duration     | 2 hours (estimated) |

---

## Scenario 1: Production Database Corruption

### Scenario Description

During routine morning checks, monitoring alerts indicate elevated error rates on the CPA Platform API. Investigation reveals that a database migration applied the previous evening contained a bug that corrupted data in the `expenditure` table for three tenants. The corruption affects expenditure records from the past 48 hours. The `audit_log` and `event` tables are unaffected (append-only controls prevented modification).

### Walkthrough

**Detection:**

- [ ] How was the issue detected? (Monitoring alert / user report / manual check)
- [ ] What was the time between corruption and detection?
- [ ] Which monitoring systems fired? (Sentry error rate / health check / PagerDuty)

**Decision:**

- [ ] Who made the decision to initiate the recovery procedure?
- [ ] Was the BC plan referenced? How quickly was it located?
- [ ] Was the decision made to take the application offline during recovery?
- [ ] How was the scope of corruption assessed? (Which tables, which tenants, which time range)

**Restore:**

- [ ] Which backup was selected for restore? (Point-in-time or specific snapshot)
- [ ] Was `tools/postgres/restore-drill.sh` used? Any issues?
- [ ] How long did the restore take?
- [ ] Was partial restore possible (affected tenants only) or was full restore required?

**Verification:**

- [ ] How was data integrity verified after restore?
- [ ] Was the `content_hash` chain checked for the `event` table?
- [ ] Were the `audit_log` append-only constraints confirmed intact?
- [ ] Were the three affected tenants' data verified against the last known good state?
- [ ] Were P1–P4 recovery priorities followed?

### Timeline

| Time | Event                         | Action Taken | By Whom |
| ---- | ----------------------------- | ------------ | ------- |
| T+0  | _Detection_                   |              |         |
| T+?  | _Assessment begins_           |              |         |
| T+?  | _Decision: initiate recovery_ |              |         |
| T+?  | _Application taken offline_   |              |         |
| T+?  | _Backup restore initiated_    |              |         |
| T+?  | _Restore complete_            |              |         |
| T+?  | _Verification complete_       |              |         |
| T+?  | _Application back online_     |              |         |
| T+?  | _Customer notification sent_  |              |         |

### Gaps Identified

_To be completed during exercise._

1. _Gap description_
2. _Gap description_

### Action Items

| Item | Description | Owner | Due Date | Status |
| ---- | ----------- | ----- | -------- | ------ |
| 1    |             |       |          |        |
| 2    |             |       |          |        |

---

## Scenario 2: Anthropic API Outage

### Scenario Description

At 10:00 AM AEST on a Monday, the Anthropic API begins returning 503 Service Unavailable errors for all requests. The Anthropic status page confirms a major outage affecting all API customers. No ETA for restoration is provided. Several CPA Platform customers are actively using the narrative generation and expenditure classification features.

### Walkthrough

**Detection:**

- [ ] How was the outage detected? (Application errors / Sentry alerts / user reports)
- [ ] What was the time between first API failure and confirmed diagnosis?
- [ ] Was the Anthropic status page checked? How quickly?

**Decision:**

- [ ] Who made the decision to activate graceful degradation?
- [ ] Was the BC plan referenced for the supplier outage scenario?
- [ ] What features were affected? (Narrative generation, expenditure classification, activity register drafting)
- [ ] What features remained operational? (Authentication, data entry, audit trail, reporting on existing data)

**Customer Communication:**

- [ ] When was the customer notification drafted?
- [ ] What channel was used? (Email via Resend / in-app notification / both)
- [ ] Was the notification sent within the 1-hour target?
- [ ] What information was included? (Affected features, workarounds, ETA if available)

**Workarounds:**

- [ ] Were manual workarounds communicated to customers?
  - Manual narrative drafting (direct text entry without AI assistance)
  - Manual expenditure classification (human review without AI suggestions)
- [ ] Were in-progress AI operations handled gracefully? (Queued for retry / error shown / partial results saved)

**Recovery:**

- [ ] When was the Anthropic API restored?
- [ ] How was restoration verified? (Test API call / monitoring green / user confirmation)
- [ ] Were queued operations processed after restoration?
- [ ] Was output quality verified after restoration? (AI responses consistent with pre-outage quality)

### Timeline

| Time | Event                            | Action Taken | By Whom |
| ---- | -------------------------------- | ------------ | ------- |
| T+0  | _First API failure_              |              |         |
| T+?  | _Outage confirmed_               |              |         |
| T+?  | _Graceful degradation activated_ |              |         |
| T+?  | _Customer notification sent_     |              |         |
| T+?  | _Anthropic API restored_         |              |         |
| T+?  | _Platform fully operational_     |              |         |
| T+?  | _All-clear notification sent_    |              |         |

### Gaps Identified

_To be completed during exercise._

1. _Gap description_
2. _Gap description_

### Action Items

| Item | Description | Owner | Due Date | Status |
| ---- | ----------- | ----- | -------- | ------ |
| 1    |             |       |          |        |
| 2    |             |       |          |        |

---

## Post-Exercise Summary

_To be completed after the exercise._

### Overall Assessment

- [ ] BC plan was accessible and understood by all participants
- [ ] Recovery priorities (P1–P4) were clear and followed
- [ ] Communication procedures were effective
- [ ] Runbooks and tools were adequate

### Key Findings

1. _Finding_
2. _Finding_
3. _Finding_

### Improvements to BC Plan

| Change Description | Section Affected | Implemented | Date |
| ------------------ | ---------------- | ----------- | ---- |
|                    |                  |             |      |

### Next Exercise

| Field    | Value         |
| -------- | ------------- |
| Date     | TBD (Q1 2027) |
| Scenario | TBD           |

---

**Sign-off:**

| Role        | Name | Signature | Date |
| ----------- | ---- | --------- | ---- |
| Facilitator |      |           |      |
| Participant |      |           |      |
| Participant |      |           |      |
