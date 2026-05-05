# Backup & Restore Runbook

Operational runbook for CPA Platform database backup and restore procedures.

## Trigger

Use this runbook when any of the following occur:

- **Data corruption** detected in production (e.g. constraint violations, missing rows).
- **Accidental deletion** of tenant data, user records, or audit logs.
- **Disaster recovery** — production database is unrecoverable or the hosting region is
  unavailable.
- **Scheduled restore drill** — monthly validation of backup integrity and RTO compliance.

## Severity

**Critical** — active or potential data loss. Escalate immediately to the on-call
engineer and platform lead.

## Prerequisites

Before starting a restore:

- [ ] pgBackRest is installed and the `cpa-prod` stanza is configured
      (see `tools/postgres/pgbackrest.conf`).
- [ ] Access to backup storage (S3 bucket `cpa-platform-backups` in `ap-southeast-2`).
- [ ] Database credentials with superuser privileges on the target host.
- [ ] `tools/postgres/restore-drill.sh` is available and executable.
- [ ] Sufficient disk space for the restored cluster (at least 2x current DB size).

## Restore Procedure

### 1. Identify recovery target

Determine the point-in-time to restore to:

- For data corruption: the last known-good timestamp **before** the corruption event.
- For accidental deletion: the timestamp immediately **before** the DELETE/UPDATE.
- For disaster recovery: the most recent available timestamp (`latest`).

```bash
# List available backups
pgbackrest --stanza=cpa-prod info
```

### 2. Stop application traffic

Prevent writes to the corrupted/damaged database:

```bash
# Scale down application replicas or enable maintenance mode
kubectl scale deployment cpa-web --replicas=0
# — or —
gcloud run services update cpa-web --no-traffic
```

### 3. Run the restore drill

Execute the automated restore script against the target timestamp:

```bash
chmod +x tools/postgres/restore-drill.sh
./tools/postgres/restore-drill.sh "2025-01-15 14:30:00+00"
```

The script will:

- Restore to a temporary cluster on port 5455.
- Verify row counts on all critical tables.
- Report elapsed time vs. RTO target.
- Exit non-zero if RTO is exceeded or verification fails.

### 4. Verify data integrity

If the automated drill passes, perform additional manual checks:

```sql
-- Connect to restored cluster
psql -p 5455 -d cpa

-- Spot-check recent audit log entries
SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 10;

-- Verify tenant isolation is intact
SELECT tenant_id, count(*) FROM subject_tenant GROUP BY tenant_id;

-- Check narrative drafts reference valid subjects
SELECT nd.id FROM narrative_draft nd
  LEFT JOIN subject_tenant st ON nd.subject_tenant_id = st.id
  WHERE st.id IS NULL;
```

### 5. Switch application to restored instance

Once verified, promote the restored cluster to production:

```bash
# Update connection string to point to restored instance
# (exact steps depend on infrastructure — Cloud SQL, RDS, self-hosted)

# If using pgBackRest restore to the original PGDATA location:
pgbackrest --stanza=cpa-prod \
  --type=time \
  --target="2025-01-15 14:30:00+00" \
  --target-action=promote \
  restore
```

### 6. Resume traffic

```bash
kubectl scale deployment cpa-web --replicas=3
# — or —
gcloud run services update cpa-web --to-latest
```

### 7. Notify stakeholders

Send notification to:

- Platform engineering team (Slack `#cpa-platform-ops`).
- Affected tenant administrators (if tenant-specific data was involved).
- Compliance/audit team (any audit_log recovery must be logged).

## Post-Recovery

After every restore (including drills):

1. **Log the incident** in the team incident tracker with:
   - Trigger (what caused the restore).
   - Target timestamp and actual restore time.
   - Tables verified and row counts.
   - Whether RPO and RTO targets were met.
2. **Update the drill results table** below.
3. **Review** whether the backup schedule or retention policy needs adjustment.
4. If RPO or RTO was **not** met, open a follow-up task to investigate and remediate.

## Monthly Drill Results

| Date | Target Timestamp | Restore Time (s) | Tables Verified | Pass/Fail |
| ---- | ---------------- | ---------------- | --------------- | --------- |
| TBD  | TBD              | TBD              | TBD             | TBD       |

> Record each monthly drill result here. Remove the placeholder row after the first
> real drill.
