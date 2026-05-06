# Runbook Index

Operational runbooks for CPA Platform. Each runbook follows a standard structure:
Trigger → Severity → First Response → Escalation → Resolution → Post-incident.

| Runbook                                                      | Trigger                                    | Severity  |
| ------------------------------------------------------------ | ------------------------------------------ | --------- |
| [on-call.md](./on-call.md)                                   | Being paged / starting on-call shift       | Reference |
| [first-incident.md](./first-incident.md)                     | First time being paged                     | Reference |
| [backup-restore.md](./backup-restore.md)                     | Database corruption or data loss suspected | Sev 1-2   |
| [pentest-finding-response.md](./pentest-finding-response.md) | Pen-test finding received                  | Varies    |
| [gcp-project-bootstrap.md](./gcp-project-bootstrap.md)       | GCP project provisioning / re-provisioning | Ops       |
| [monitoring.md](./monitoring.md)                             | Applying/updating alert policies; Sentry activation (P9.1) | Ops |

## Quick links

- **PagerDuty**: [configured in T1.2]
- **Sentry**: [configured in T1.2]
- **Grafana**: [existing OTLP target]
- **Status page**: [TBD]
