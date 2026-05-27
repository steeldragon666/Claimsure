# ArchiveOne / CPA Platform Backups

Nightly `pg_dump` of `cpa_prod` is gzipped to `/var/backups/cpa`, then pushed
to an S3-compatible bucket with [restic](https://restic.net) for off-site,
encrypted, deduplicated retention. Job runs at **02:30 Australia/Melbourne**
via `cpa-backup.timer`.

## One-time setup (Ubuntu 24.04, Binary Lane Melbourne)

```bash
# 1. Install restic.
apt-get update && apt-get install -y restic
restic version   # confirm >= 0.16

# 2. Make sure host clock is Melbourne (the timer is local-time based).
timedatectl set-timezone Australia/Melbourne

# 3. Create env file (chmod 600 — contains secrets).
install -d -m 700 /etc/cpa
cat > /etc/cpa/backup.env <<'EOF'
RESTIC_REPOSITORY=s3:https://s3.ap-southeast-2.amazonaws.com/<your-bucket>
RESTIC_PASSWORD=<long random passphrase — store in 1Password>
AWS_ACCESS_KEY_ID=<scoped IAM key>
AWS_SECRET_ACCESS_KEY=<scoped IAM secret>
EOF
chmod 600 /etc/cpa/backup.env

# 4. Initialise the restic repo (only once).
set -a; . /etc/cpa/backup.env; set +a
restic init

# 5. Install the script + systemd units.
install -m 755 tools/vps/backup.sh /opt/cpa-platform/tools/vps/backup.sh
install -m 644 tools/vps/cpa-backup.service /etc/systemd/system/
install -m 644 tools/vps/cpa-backup.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cpa-backup.timer

# 6. Smoke test.
DRY_RUN=1 /opt/cpa-platform/tools/vps/backup.sh   # prints planned commands
systemctl start cpa-backup.service                # real run
journalctl -u cpa-backup.service -e               # check exit
```

## Restore drill

```bash
# 1. List snapshots, pick the one you want.
set -a; . /etc/cpa/backup.env; set +a
restic snapshots --tag cpa-prod

# 2. Restore that snapshot to a scratch dir.
restic restore <snapshot-id> --target /tmp/cpa-restore

# 3. Decompress the most-recent dump.
ls -lt /tmp/cpa-restore/var/backups/cpa/
gunzip -k /tmp/cpa-restore/var/backups/cpa/cpa_prod_*.sql.gz

# 4. Load into a fresh database (NEVER the live one).
docker exec -i cpa-postgres-prod psql -U postgres -c "CREATE DATABASE cpa_restore;"
docker exec -i cpa-postgres-prod psql -U postgres cpa_restore \
  < /tmp/cpa-restore/var/backups/cpa/cpa_prod_*.sql

# 5. Verify row counts on the load-bearing tables.
docker exec -i cpa-postgres-prod psql -U postgres cpa_restore -c "
  SELECT 'tenant'      AS t, count(*) FROM tenant      UNION ALL
  SELECT 'claim'       AS t, count(*) FROM claim       UNION ALL
  SELECT 'event'       AS t, count(*) FROM event       UNION ALL
  SELECT 'expenditure' AS t, count(*) FROM expenditure;"
```

Counts should be within an expected delta of production. If they match,
the snapshot is good. Drop `cpa_restore` when finished.

## Alerting

`cpa-backup.service` is a oneshot — a non-zero exit causes systemd to mark the
unit `failed`. Wire `OnFailure=cpa-backup-alert@%n.service` (template unit that
posts to Slack / PagerDuty / `sendmail`) so silent failures surface within
minutes instead of at the next quarterly drill.

## Cadence

- **Daily**: timer runs at 02:30 Melbourne. Inspect `journalctl -u cpa-backup`.
- **Quarterly**: run the full restore drill above against a scratch DB. Note
  the result in the ops log. Anything that has not been restored is not a
  backup.
