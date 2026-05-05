# Incident Management Plan (ISO 27001:2022 A.5.24-A.5.27)

**Document owner:** Aaron (Founder)
**Last reviewed:** 2026-05-06
**Next review:** 2026-08-06 (quarterly)
**Version:** 1.0

## 1. Purpose

Establishes the framework for detecting, responding to, and learning from information security incidents affecting the CPA Platform.

## 2. Scope

All information security events and incidents within the ISMS scope, including:

- Platform availability incidents (outages, degradation)
- Data confidentiality breaches (unauthorized access, data leakage)
- Data integrity incidents (corruption, unauthorized modification)
- Authentication/authorization failures
- Third-party supplier incidents affecting our platform

## 3. Definitions

| Term              | Definition                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Security event    | An identified occurrence relevant to information security (e.g., failed login attempt)                   |
| Security incident | A security event that has a significant probability of compromising operations or threatening security   |
| Data breach       | A security incident resulting in unauthorized access to, or disclosure of, personal or confidential data |

## 4. Incident classification

| Severity         | Criteria                                                                   | Response targets                         |
| ---------------- | -------------------------------------------------------------------------- | ---------------------------------------- |
| Sev 1 (Critical) | Platform unavailable; confirmed data breach; authentication bypass         | Ack: 5 min, Contain: 30 min, Resolve: 4h |
| Sev 2 (High)     | Major feature impaired; suspected data exposure; significant error spike   | Ack: 15 min, Contain: 2h, Resolve: 8h    |
| Sev 3 (Medium)   | Degraded performance; non-critical feature failure; minor security finding | Ack: 1h, Resolve: 24h                    |
| Sev 4 (Low)      | Cosmetic issue; informational security event; false positive               | Next business day                        |

## 5. Roles during incident

| Role               | Current holder | Responsibilities                                                                |
| ------------------ | -------------- | ------------------------------------------------------------------------------- |
| Incident Commander | Aaron          | Overall coordination; severity classification; customer communication decisions |
| Technical Lead     | Aaron          | Investigation; containment; fix implementation                                  |
| Communications     | Aaron          | Customer notifications; status page updates                                     |

_Note: For a solo operation, all roles are held by the founder. When the team grows, these separate into distinct responsibilities._

## 6. Detection sources

- **Sentry**: Error tracking and alerting → routes to PagerDuty
- **Grafana synthetics**: Uptime probe failures → routes to PagerDuty
- **Sentry-Cron**: Missed cron heartbeats (backup drills, RIF scrape) → email alert
- **Customer-reported**: Via support channel → manual triage
- **Supplier outage**: Anthropic/GitHub/hosting provider status pages → manual check
- **Automated tests**: CI-enforced RLS audit, hash-chain verification

## 7. Response phases

### 7.1 Detect

Monitoring alerts or customer report triggers incident awareness. Classification determines response urgency.

### 7.2 Contain

Immediate actions to limit impact:

- Isolate affected component (disable feature flag, block endpoint, restrict access)
- Preserve evidence (don't modify logs; screenshot dashboards)
- If data breach suspected: assess scope immediately

### 7.3 Eradicate

Remove the root cause:

- Deploy fix via standard CI/CD (or hotfix for Sev 1)
- Verify fix in staging before production (unless Sev 1 time pressure overrides)
- Update related security controls if finding reveals gap

### 7.4 Recover

Restore normal operations:

- Verify all monitoring probes green
- Confirm customer-facing functionality restored
- Re-enable any disabled features
- Monitor for recurrence (heightened alerting for 24h)

### 7.5 Post-incident

Required for all Sev 1 and Sev 2 incidents; recommended for Sev 3:

- Complete post-incident review using template
- Update incidents log
- Identify improvement actions
- Schedule follow-up for action items

## 8. Communication plan

### Internal communication

All severities: log in incidents-log.md with timestamp, classification, and status.

### External communication (customer notification)

| Trigger                               | Notification target             | Timeline                              | Method              |
| ------------------------------------- | ------------------------------- | ------------------------------------- | ------------------- |
| Confirmed data breach                 | Affected customers + regulators | Within 72h (Privacy Act 1988 cl 26WK) | Email + phone       |
| Service outage ≥ 1h                   | All active customers            | Within 4h of detection                | Email + status page |
| Service degradation ≥ 4h              | Affected customers              | Within 8h                             | Email               |
| Security finding (no customer impact) | No external notification        | N/A                                   | N/A                 |

## 9. Evidence and records

All incident records serve as ISO A.5.27 evidence:

- Incidents log: `docs/iso27001/incidents/incidents-log.md`
- Post-incident reviews: `docs/iso27001/incidents/pir-YYYY-MM-DD-*.md`
- Communication records: stored in email / Slack archives

## 10. Document control

| Version | Date       | Author | Change       |
| ------- | ---------- | ------ | ------------ |
| 1.0     | 2026-05-06 | Aaron  | Initial plan |
