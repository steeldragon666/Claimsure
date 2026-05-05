# Disaster Recovery Targets

CPA Platform production database DR targets. These govern backup strategy, restore
procedures, and drill cadence.

## RPO — Recovery Point Objective

**Target: <= 5 minutes**

Achieved via continuous WAL archiving (pgBackRest `archive-async`). Every committed
transaction is shipped to the backup repository within seconds under normal conditions.
Worst-case data loss is bounded by the last archived WAL segment.

## RTO — Recovery Time Objective

**Target: <= 1 hour from outage declared to traffic restored**

This includes:

- Incident triage and decision to restore (~10 min)
- PITR restore from pgBackRest (~30 min for current dataset)
- Data integrity verification (~5 min)
- Application switchover and traffic resume (~15 min)

## Backup Schedule

| Type        | Frequency          | Time (UTC)          |
| ----------- | ------------------ | ------------------- |
| Full        | Daily              | 03:00               |
| Incremental | Every 6 hours      | 09:00, 15:00, 21:00 |
| WAL archive | Continuous (async) | N/A                 |

## Retention

| Asset        | Retention Period |
| ------------ | ---------------- |
| Full backups | 7 days           |
| WAL segments | 30 days          |

The 30-day WAL window allows point-in-time recovery to any moment in the last month,
provided a full backup older than the target timestamp still exists in the 7-day window.

## Recovery Validation

- **Cadence:** Monthly restore drills using `tools/postgres/restore-drill.sh`.
- **Scope:** Full PITR to a timestamp 5 minutes before drill start. Verify row counts
  on all critical tables (`tenant`, `user`, `subject_tenant`, `event`, `activity`,
  `expenditure`, `narrative_draft`, `audit_log`).
- **Pass criteria:** Restore completes within RTO (3600 s) and all table counts are > 0.

## Escalation

If a drill fails:

1. Open a P1 incident and investigate root cause immediately.
2. Do **not** proceed with the next production deployment until the drill passes.
3. Re-run the drill after the fix is applied and confirmed green.
4. Document the failure and remediation in the monthly drill results table
   (see `docs/runbooks/backup-restore.md`).
