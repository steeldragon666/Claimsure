# Business Continuity Plan (A.5.29-A.5.30)

**ISO 27001 Reference:** Annex A controls A.5.29 (Information security during disruption), A.5.30 (ICT readiness for business continuity)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2026-11-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Define the business continuity plan for the CPA Platform, ensuring that critical services can be restored within acceptable timeframes following a major disruption, and that information security controls remain effective during and after recovery.

## 2. BC Objectives

| Objective                        | Target                              |
| -------------------------------- | ----------------------------------- |
| Recovery Time Objective (RTO)    | 4 hours for critical services       |
| Recovery Point Objective (RPO)   | 1 hour (last successful backup)     |
| Maximum Tolerable Downtime (MTD) | 8 hours                             |
| Customer notification            | Within 4 hours for outages > 1 hour |

## 3. Recovery Priorities

Services are restored in priority order:

| Priority | Service                    | RTO     | Justification                                                    |
| -------- | -------------------------- | ------- | ---------------------------------------------------------------- |
| P1       | Authentication + audit_log | 1 hour  | Users must be able to log in; audit integrity must be maintained |
| P2       | API core (Fastify)         | 2 hours | Core platform functionality for consultants                      |
| P3       | UI (Next.js frontend)      | 3 hours | User-facing interface; API can operate headless temporarily      |
| P4       | Reporting + AI agents      | 4 hours | Narrative generation, expenditure classification, RIF processing |

## 4. Disaster Scenarios and Response

### 4.1 Cloud Region Outage

**Scenario:** The hosting provider's primary region becomes unavailable.

| Phase      | Action                                                                    | Owner | Timeline      |
| ---------- | ------------------------------------------------------------------------- | ----- | ------------- |
| Detection  | Provider status page alerts; PagerDuty notification; health check failure | Auto  | 0 – 5 min     |
| Assessment | Confirm region outage (not application bug); check provider status        | Aaron | 5 – 15 min    |
| Mitigation | If multi-region: failover to secondary region                             | Aaron | 15 – 60 min   |
| Mitigation | If single-region: wait for provider recovery; communicate to customers    | Aaron | Ongoing       |
| Recovery   | Verify data integrity after region restoration; resume normal operations  | Aaron | Post-restore  |
| Review     | Post-incident review; assess multi-region architecture need               | Aaron | Within 7 days |

**Runbook:** Verify database replication status; check for data divergence; run audit chain integrity check.

### 4.2 Database Corruption

**Scenario:** Production PostgreSQL database becomes corrupted or data is inadvertently modified.

| Phase        | Action                                                                       | Owner | Timeline      |
| ------------ | ---------------------------------------------------------------------------- | ----- | ------------- |
| Detection    | Application errors; data inconsistency reports; monitoring alerts            | Auto  | 0 – 5 min     |
| Assessment   | Identify scope of corruption; determine if backup restore is needed          | Aaron | 5 – 30 min    |
| Mitigation   | Take application offline to prevent further corruption                       | Aaron | 30 min        |
| Recovery     | Restore from most recent verified backup (`tools/postgres/restore-drill.sh`) | Aaron | 30 – 120 min  |
| Verification | Run audit chain integrity check; verify `content_hash` chain consistency     | Aaron | Post-restore  |
| Recovery     | Bring application back online; verify P1–P4 services                         | Aaron | Post-verify   |
| Review       | Root cause analysis; update backup/integrity procedures                      | Aaron | Within 7 days |

**Runbook:** See `tools/postgres/restore-drill.sh` for backup restore procedure; `tools/postgres/pgbackrest.conf` for backup configuration.

### 4.3 Key Personnel Unavailable

**Scenario:** Aaron (sole developer/operator) is unavailable for an extended period.

| Phase      | Action                                                                                      | Owner        | Timeline      |
| ---------- | ------------------------------------------------------------------------------------------- | ------------ | ------------- |
| Detection  | Unresponsive for > 24 hours during business hours                                           | Stakeholders | 24 hours      |
| Mitigation | Designated backup contact activates emergency access procedures                             | Backup       | 24 – 48 hours |
| Continuity | Platform continues to operate autonomously (no manual intervention needed for steady-state) | Auto         | Ongoing       |
| Recovery   | Engage contract developer if extended absence (> 2 weeks)                                   | Stakeholders | 2 weeks       |

**Mitigations in place:**

- Platform is designed for autonomous operation (no daily manual tasks)
- All infrastructure is managed (provider handles patching, scaling, backups)
- Documentation in this repository enables a competent developer to operate the platform
- Break-glass credentials documented in the secrets manager

### 4.4 Supplier Outage (Anthropic API)

**Scenario:** Anthropic's API becomes unavailable, preventing AI-powered features from functioning.

| Phase         | Action                                                                    | Owner | Timeline      |
| ------------- | ------------------------------------------------------------------------- | ----- | ------------- |
| Detection     | API timeout/error responses; Sentry alerts                                | Auto  | 0 – 5 min     |
| Assessment    | Check Anthropic status page; confirm not a local issue                    | Aaron | 5 – 15 min    |
| Mitigation    | Graceful degradation: disable AI features; show "temporarily unavailable" | Aaron | 15 – 30 min   |
| Communication | Notify affected customers that AI features are temporarily unavailable    | Aaron | Within 1 hour |
| Workaround    | Manual narrative drafting; manual expenditure classification              | Users | Ongoing       |
| Recovery      | Re-enable AI features when API is restored; verify output quality         | Aaron | Post-restore  |
| Review        | Assess need for multi-provider AI strategy                                | Aaron | Within 7 days |

### 4.5 Ransomware / Compromise

**Scenario:** Production systems are compromised by ransomware or an attacker gains unauthorised access.

| Phase        | Action                                                                     | Owner | Timeline                                                |
| ------------ | -------------------------------------------------------------------------- | ----- | ------------------------------------------------------- |
| Detection    | Anomalous behaviour; monitoring alerts; user reports                       | Auto  | 0 – 15 min                                              |
| Containment  | Immediately isolate affected systems; revoke all access tokens             | Aaron | 15 – 30 min                                             |
| Assessment   | Determine scope of compromise; identify affected data                      | Aaron | 30 – 120 min                                            |
| Eradication  | Rebuild from clean images; restore from pre-compromise backup              | Aaron | 2 – 8 hours                                             |
| Recovery     | Bring services online in priority order (P1 → P4)                          | Aaron | Post-rebuild                                            |
| Notification | Notify affected customers per legal requirements (Australian Privacy Act)  | Aaron | Within 72 hours (regulatory); within 4 hours (internal) |
| Review       | Full incident report; update security controls; engage forensics if needed | Aaron | Within 14 days                                          |

**Critical actions:**

1. Do NOT pay ransom
2. Preserve evidence (logs, disk images) before remediation
3. Rotate ALL credentials (database, API keys, OAuth secrets, encryption keys)
4. Verify backup integrity before restore (ensure backups were not also compromised)
5. Engage legal counsel for regulatory notification requirements

## 5. Communication Plan

### 5.1 Internal Communication

| Trigger                  | Audience         | Channel     | Timeline      |
| ------------------------ | ---------------- | ----------- | ------------- |
| Incident detected        | Risk owner       | PagerDuty   | Immediate     |
| Major incident confirmed | Development team | Slack/email | Within 30 min |
| Recovery complete        | Development team | Slack/email | Post-recovery |

### 5.2 Customer Communication

| Trigger               | Audience           | Channel        | Timeline                     |
| --------------------- | ------------------ | -------------- | ---------------------------- |
| Outage > 1 hour       | All customers      | Email (Resend) | Within 4 hours               |
| Data breach suspected | Affected customers | Email + phone  | Within 72 hours (regulatory) |
| Recovery complete     | All customers      | Email (Resend) | Post-recovery                |

### 5.3 Regulatory Communication

| Trigger                    | Authority                                                | Timeline                                |
| -------------------------- | -------------------------------------------------------- | --------------------------------------- |
| Notifiable data breach     | OAIC (Office of the Australian Information Commissioner) | Within 30 days (as soon as practicable) |
| Significant cyber incident | ACSC (Australian Cyber Security Centre)                  | Within 72 hours                         |

## 6. Recovery Validation Criteria

Before declaring recovery complete, the following must be verified:

- [ ] All P1–P4 services are operational and responding to health checks
- [ ] Authentication flows work (OAuth login, session creation)
- [ ] Audit log is accepting new entries (append-only integrity confirmed)
- [ ] RLS policies are enforced (tenant isolation verified)
- [ ] Content hash chain integrity is verified for the `event` table
- [ ] Most recent data matches the expected RPO (no data loss beyond 1 hour)
- [ ] Monitoring and alerting are active (Sentry, PagerDuty)
- [ ] Customer notification has been sent (if applicable)

## 7. Testing

Business continuity procedures are tested through:

| Test Type         | Frequency     | Scope                                                          |
| ----------------- | ------------- | -------------------------------------------------------------- |
| Backup restore    | Quarterly     | `tools/postgres/restore-drill.sh` execution                    |
| Tabletop exercise | Semi-annually | Walk-through of disaster scenarios (see `tabletop-2026-Q3.md`) |
| Failover test     | Annually      | Region failover (if multi-region)                              |

## 8. Plan Maintenance

This plan is reviewed and updated:

- **Semi-annually:** Scheduled review (next: 2026-11-06)
- **After any incident:** Lessons learned incorporated within 14 days
- **After architecture changes:** New services, data flows, or infrastructure changes trigger a plan review
- **After tabletop exercises:** Gaps identified during exercises are addressed within 30 days

## 9. References

- ISO/IEC 27001:2022 Annex A controls A.5.29, A.5.30
- Backup configuration (`tools/postgres/pgbackrest.conf`)
- Restore procedure (`tools/postgres/restore-drill.sh`)
- Logging policy (`docs/iso27001/operations/logging-policy.md`)
- Supplier register (`docs/iso27001/suppliers/supplier-register.md`)
- Tabletop exercise template (`docs/iso27001/business-continuity/tabletop-2026-Q3.md`)
