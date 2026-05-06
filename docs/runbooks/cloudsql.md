# Runbook: Cloud SQL (Postgres 16 + pgvector)

**Scope:** Provisioning, maintenance, and recovery of the `cpa-prod-db` and `cpa-stg-db` Cloud SQL instances.
**Scripts:** `tools/gcp/cloudsql-provision.sh`, `tools/gcp/cloudsql-restore-drill.sh`
**Author:** P9.0.2
**Last updated:** 2026-05-07

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [First-time provisioning](#first-time-provisioning)
3. [pgvector verification](#pgvector-verification)
4. [Connecting to Cloud SQL](#connecting-to-cloud-sql)
5. [Running migrations against Cloud SQL](#running-migrations-against-cloud-sql)
6. [Backup verification](#backup-verification)
7. [Restore drill procedure](#restore-drill-procedure)
8. [Region fallback procedure](#region-fallback-procedure)
9. [Point-in-time recovery (PITR)](#point-in-time-recovery-pitr)

---

## Prerequisites

### Tools

- **gcloud CLI** — version 450+ recommended.
  ```bash
  gcloud version
  ```
  Install: https://cloud.google.com/sdk/docs/install

- **Cloud SQL Auth Proxy** — required for local connections to Cloud SQL instances.
  ```bash
  cloud-sql-proxy --version
  ```
  Install: https://cloud.google.com/sql/docs/postgres/connect-auth-proxy

- **psql** — Postgres client for running SQL verification queries.
  ```bash
  psql --version
  ```

- **Authenticated gcloud session** with an account that has the following IAM roles on both projects:
  - `roles/cloudsql.admin` — to create and manage instances
  - `roles/cloudsql.client` — to connect via Cloud SQL Auth Proxy

  Authenticate:
  ```bash
  gcloud auth login
  gcloud auth application-default login
  ```

### Required permissions summary

| Action | Required role |
|---|---|
| Create / patch Cloud SQL instances | `roles/cloudsql.admin` |
| Create databases and users | `roles/cloudsql.admin` |
| Connect via Cloud SQL Auth Proxy | `roles/cloudsql.client` |
| Clone instances (restore drill) | `roles/cloudsql.admin` |

### Instance configuration

| Parameter | Value |
|---|---|
| Database version | `POSTGRES_16` |
| Tier | `db-custom-2-4096` (2 vCPU, 4 GB RAM) |
| Availability | `REGIONAL` (high availability with standby) |
| Primary region | `australia-southeast1` (Sydney) |
| Fallback region | `australia-southeast2` (Melbourne) |
| Network | Private IP only (no public IP) |
| pgvector | Enabled via `cloudsql.enable_pgvector=on` flag |
| Automated backups | Daily at 02:00 UTC, 7-day retention |
| PITR | Enabled |

---

## First-time provisioning

### 1. Ensure the GCP projects exist

The Cloud SQL provisioning script assumes the GCP projects (`cpa-platform-prod` and `cpa-platform-stg`) already exist. If they do not, run the project bootstrap first:

```bash
bash tools/gcp/project-bootstrap.sh
```

See `docs/runbooks/gcp-project-bootstrap.md` for details.

### 2. Make the script executable

```bash
chmod +x tools/gcp/cloudsql-provision.sh
```

### 3. Set optional environment overrides (if needed)

All variables have sensible defaults. Override only if the defaults do not match your environment:

```bash
# Optional — defaults shown:
export PROD_PROJECT="cpa-platform-prod"
export STG_PROJECT="cpa-platform-stg"
export REGION="australia-southeast1"
export DB_INSTANCE_PROD="cpa-prod-db"
export DB_INSTANCE_STG="cpa-stg-db"
export DB_TIER="db-custom-2-4096"
```

### 4. Run the provisioning script

```bash
bash tools/gcp/cloudsql-provision.sh
```

The script will, for each environment (prod + stg):
- Create the Cloud SQL Postgres 16 instance with REGIONAL availability and private IP only (idempotent)
- Enable the `cloudsql.enable_pgvector=on` database flag
- Create the `cpa_app` database
- Create the `cpa_app` database user
- Configure automated daily backups with 7-day retention and PITR

Expected runtime: 10–25 minutes (instance creation is the slowest step).

The script is safe to re-run. It checks for existing resources before creating them and prints a summary of what was created vs. skipped.

### 5. Verify the instances

```bash
gcloud sql instances describe cpa-prod-db --project=cpa-platform-prod
gcloud sql instances describe cpa-stg-db  --project=cpa-platform-stg
```

Both should show `state: RUNNABLE`.

---

## pgvector verification

After provisioning, connect to each instance and confirm the `vector` extension is available and can be created.

### 1. Start the Cloud SQL Auth Proxy

```bash
# Production
cloud-sql-proxy \
  "$(gcloud sql instances describe cpa-prod-db \
      --project=cpa-platform-prod \
      --format='value(connectionName)')" \
  --port=5433
```

### 2. Connect with psql

```bash
psql "host=127.0.0.1 port=5433 dbname=cpa_app user=cpa_app"
```

### 3. Check extension availability and status

```sql
-- Confirm vector extension is available to install
SELECT * FROM pg_available_extensions WHERE name = 'vector';

-- Create the extension (if not already done by migrations)
CREATE EXTENSION IF NOT EXISTS vector;

-- Confirm the extension is installed and active
SELECT * FROM pg_extension WHERE extname = 'vector';
```

Expected output from the last query (extension installed):

```
  oid  | extname | extowner | extnamespace | extrelocatable | extversion | extconfig | extcondition
-------+---------+----------+--------------+----------------+------------+-----------+--------------
 12345 | vector  |       10 |         2200 | t              | 0.7.0      |           |
```

### 4. Verify vector operations work

```sql
-- Create a test table with a vector column
CREATE TEMP TABLE vector_test (embedding vector(3));
INSERT INTO vector_test VALUES ('[1,2,3]'), ('[4,5,6]');

-- Run a similarity search
SELECT embedding, embedding <-> '[1,2,3]' AS distance
  FROM vector_test
  ORDER BY distance;

-- Clean up
DROP TABLE vector_test;
```

If these queries succeed, pgvector is functioning correctly.

---

## Connecting to Cloud SQL

Cloud SQL instances are configured with private IP only (`--no-assign-ip`). All connections must go through the **Cloud SQL Auth Proxy**, which handles IAM authentication and TLS.

### Local development / operator access

**1. Install Cloud SQL Auth Proxy:**

```bash
# macOS (Apple Silicon)
curl -o cloud-sql-proxy \
  "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.darwin.arm64"
chmod +x cloud-sql-proxy
sudo mv cloud-sql-proxy /usr/local/bin/

# Linux (amd64)
curl -o cloud-sql-proxy \
  "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.linux.amd64"
chmod +x cloud-sql-proxy
sudo mv cloud-sql-proxy /usr/local/bin/
```

**2. Get the connection name:**

```bash
gcloud sql instances describe cpa-prod-db \
  --project=cpa-platform-prod \
  --format="value(connectionName)"
# Output: cpa-platform-prod:australia-southeast1:cpa-prod-db
```

**3. Start the proxy (runs in foreground — use a separate terminal or tmux):**

```bash
# Production (port 5433)
cloud-sql-proxy cpa-platform-prod:australia-southeast1:cpa-prod-db --port=5433

# Staging (port 5434)
cloud-sql-proxy cpa-platform-stg:australia-southeast1:cpa-stg-db --port=5434
```

**4. Connect with psql:**

```bash
# Production
psql "host=127.0.0.1 port=5433 dbname=cpa_app user=cpa_app"

# Staging
psql "host=127.0.0.1 port=5434 dbname=cpa_app user=cpa_app"
```

### Application (Cloud Run)

Cloud Run services connect using the Cloud SQL connector for Node.js (configured via `DATABASE_URL` in Secret Manager). The connection string uses the Unix socket path format:

```
postgresql://cpa_app:<PASSWORD>@localhost/cpa_app?host=/cloudsql/cpa-platform-prod:australia-southeast1:cpa-prod-db
```

The Cloud Run service must have `roles/cloudsql.client` bound to its service account.

---

## Running migrations against Cloud SQL

Migrations live in `packages/db/migrations/` (currently migrations 0000–0040). They are applied via drizzle-kit.

### Prerequisites

- Cloud SQL Auth Proxy running and forwarding to the target instance (see [Connecting to Cloud SQL](#connecting-to-cloud-sql))
- `DATABASE_URL` pointing to the proxied instance

### Staging

```bash
# Start the proxy
cloud-sql-proxy cpa-platform-stg:australia-southeast1:cpa-stg-db --port=5434 &
PROXY_PID=$!

# Set DATABASE_URL to the proxied staging instance
export DATABASE_URL="postgresql://cpa_app:<STG_PASSWORD>@127.0.0.1:5434/cpa_app"

# Run migrations
pnpm --filter @cpa/db db:migrate

# Stop the proxy
kill "${PROXY_PID}"
```

### Production

Production migrations run via the CI/CD pipeline (Cloud Build). To run manually in an emergency:

```bash
# Start the proxy
cloud-sql-proxy cpa-platform-prod:australia-southeast1:cpa-prod-db --port=5433 &
PROXY_PID=$!

# Retrieve the production password from Secret Manager
PROD_PASSWORD=$(gcloud secrets versions access latest \
  --secret=cpa-app-db-password \
  --project=cpa-platform-prod)

export DATABASE_URL="postgresql://cpa_app:${PROD_PASSWORD}@127.0.0.1:5433/cpa_app"

# Run migrations — CAUTION: this affects production
pnpm --filter @cpa/db db:migrate

kill "${PROXY_PID}"
```

### Verify migrations applied

```sql
SELECT version, created_at
  FROM drizzle.__drizzle_migrations
  ORDER BY created_at DESC
  LIMIT 5;
```

The latest version should match the highest migration file in `packages/db/migrations/`.

---

## Backup verification

Cloud SQL automated backups are taken daily at 02:00 UTC and retained for 7 days. Verify the backup configuration and recent backup status as part of routine checks.

### List configured backup settings

```bash
gcloud sql instances describe cpa-prod-db \
  --project=cpa-platform-prod \
  --format="yaml(settings.backupConfiguration)"
```

Expected output:

```yaml
settings:
  backupConfiguration:
    backupRetentionSettings:
      retainedBackups: 7
      retentionUnit: COUNT
    enabled: true
    location: australia-southeast1
    pointInTimeRecoveryEnabled: true
    startTime: 02:00
    transactionLogRetentionDays: 7
```

### List recent automated backups

```bash
gcloud sql backups list \
  --instance=cpa-prod-db \
  --project=cpa-platform-prod \
  --filter="type=AUTOMATED" \
  --sort-by="~startTime" \
  --limit=7 \
  --format="table(id,startTime,status,windowStartTime)"
```

All recent backups should have `status: SUCCESSFUL`. If any show `FAILED`, investigate via the GCP console and escalate if the failure is recurring.

### GCP Console

```
https://console.cloud.google.com/sql/instances/cpa-prod-db/backups?project=cpa-platform-prod
```

---

## Restore drill procedure

A restore drill validates that the latest production backup can be successfully restored and that migrations are intact. Run this drill at least monthly (or after any significant schema change).

### 1. Make the script executable

```bash
chmod +x tools/gcp/cloudsql-restore-drill.sh
```

### 2. Run the standard drill

```bash
bash tools/gcp/cloudsql-restore-drill.sh
```

The script will:
1. Verify the source production instance exists
2. Clone the production instance to `cpa-prod-db-drill-YYYYMMDD`
3. Print connection information and verification queries
4. Wait 60 seconds (giving the operator time to connect and inspect manually)
5. Delete the drill instance

### 3. Run with manual inspection

To keep the drill instance alive for extended inspection:

```bash
SKIP_DELETE=1 bash tools/gcp/cloudsql-restore-drill.sh
```

Connect to the drill instance for verification:

```bash
# Get the drill connection name
DRILL_DATE=$(date +%Y%m%d)
gcloud sql instances describe "cpa-prod-db-drill-${DRILL_DATE}" \
  --project=cpa-platform-prod \
  --format="value(connectionName)"

# Start the proxy on a different port
cloud-sql-proxy "cpa-platform-prod:australia-southeast1:cpa-prod-db-drill-${DRILL_DATE}" --port=5435

# Connect
psql "host=127.0.0.1 port=5435 dbname=cpa_app user=cpa_app"
```

### 4. Verify in psql

Run the following queries to confirm data integrity:

```sql
-- Confirm pgvector is present
SELECT * FROM pg_extension WHERE extname = 'vector';

-- Confirm all migrations applied
SELECT version, created_at
  FROM drizzle.__drizzle_migrations
  ORDER BY created_at DESC
  LIMIT 5;

-- Check row counts for key tables
SELECT schemaname, tablename, n_live_tup
  FROM pg_stat_user_tables
  ORDER BY n_live_tup DESC
  LIMIT 20;
```

### 5. Delete drill instance manually (if SKIP_DELETE=1 was used)

```bash
DRILL_DATE=$(date +%Y%m%d)
gcloud sql instances delete "cpa-prod-db-drill-${DRILL_DATE}" \
  --project=cpa-platform-prod \
  --quiet
```

### Drill frequency and record-keeping

| Trigger | Action |
|---|---|
| Monthly (minimum) | Run standard drill |
| After any migration batch (0010+) | Run standard drill with manual inspection |
| After major incident | Run standard drill + document results |

Record each drill result (date, instance cloned from, migrations verified, pass/fail) in the incident log or a drill register doc.

---

## Region fallback procedure

The primary region is `australia-southeast1` (Sydney). If GCP reports insufficient capacity in that region, fall back to `australia-southeast2` (Melbourne).

### Signs of a capacity error

```
ERROR: (gcloud.sql.instances.create) HTTPError 409: The Cloud SQL instance already exists.
ERROR: (gcloud.sql.instances.create) HTTPError 503: The zone does not have enough resources ...
```

### Fallback steps

**1. Override the region and re-run provisioning:**

```bash
export REGION="australia-southeast2"
bash tools/gcp/cloudsql-provision.sh
```

The script variables default to `australia-southeast1`; overriding `REGION` switches all operations to Melbourne.

**2. Update all references to the connection name:**

After provisioning in the fallback region, the Cloud SQL connection name will include `australia-southeast2`:

```
cpa-platform-prod:australia-southeast2:cpa-prod-db
```

Update the following to reflect the new connection name:
- `DATABASE_URL` in Secret Manager
- Cloud Run service environment configuration
- Any hardcoded connection strings in CI/CD configuration

**3. Update this runbook:**

Change the `REGION` row in the [Instance configuration table](#prerequisites) to `australia-southeast2` and note the date of the fallback.

**4. Monitor for Sydney capacity restoration:**

Check GCP Status: https://status.cloud.google.com/

When Sydney capacity is restored, consider migrating back:
- Provision a new instance in `australia-southeast1`
- Use PITR or a backup clone to migrate data
- Update connection strings
- Decommission the Melbourne fallback instance

---

## Point-in-time recovery (PITR)

PITR allows restoring the database to any point within the transaction log retention window (7 days). Use PITR when automated backups are insufficient — for example, to recover from a data corruption event that occurred between backups.

### When to use PITR vs. backup restore

| Scenario | Recommended approach |
|---|---|
| Recover from last known good state (daily granularity is sufficient) | Restore from automated backup |
| Recover to a specific timestamp (e.g., 30 minutes before an incident) | PITR |
| Restore drill / regular verification | `cloudsql-restore-drill.sh` (uses clone from latest backup) |

### PITR prerequisites

- PITR is enabled on `cpa-prod-db` (`--enable-point-in-time-recovery` was set during provisioning)
- Identify the target recovery timestamp in UTC (ISO 8601 format: `2026-05-07T03:45:00Z`)
- Identify a target instance name for the recovery (PITR always restores to a new instance)

### PITR procedure

**1. Confirm PITR is enabled:**

```bash
gcloud sql instances describe cpa-prod-db \
  --project=cpa-platform-prod \
  --format="value(settings.backupConfiguration.pointInTimeRecoveryEnabled)"
# Expected: True
```

**2. Identify the recovery point:**

Determine the exact UTC timestamp to recover to. Consult application logs, audit logs, or the incident timeline to identify when the data was last known good.

```bash
# Example: recover to 03:45 UTC on 2026-05-07
RECOVERY_TIME="2026-05-07T03:45:00.000Z"
RECOVERY_INSTANCE="cpa-prod-db-pitr-$(date +%Y%m%d%H%M)"
```

**3. Initiate the PITR clone:**

```bash
gcloud sql instances clone cpa-prod-db "${RECOVERY_INSTANCE}" \
  --project=cpa-platform-prod \
  --point-in-time="${RECOVERY_TIME}" \
  --quiet
```

This operation typically takes 5–20 minutes depending on the size of the database.

**4. Verify the recovered instance:**

```bash
# Start the proxy
cloud-sql-proxy \
  "cpa-platform-prod:australia-southeast1:${RECOVERY_INSTANCE}" \
  --port=5435

# Connect and verify
psql "host=127.0.0.1 port=5435 dbname=cpa_app user=cpa_app"
```

Run the verification queries from the [restore drill](#4-verify-in-psql) section.

**5. Promote the recovered instance (if data is correct):**

If the recovered instance is confirmed correct and needs to become the new production instance:

```bash
# Option A: Rename (if GCP supports it for your configuration)
# Not directly supported — instead, update connection strings to point at the recovery instance.

# Option B: Update application connection strings
# Retrieve new connection name
gcloud sql instances describe "${RECOVERY_INSTANCE}" \
  --project=cpa-platform-prod \
  --format="value(connectionName)"

# Update DATABASE_URL in Secret Manager to point at the new instance
gcloud secrets versions add cpa-database-url \
  --data-file=<(echo -n "postgresql://cpa_app:<PASSWORD>@.../<new connection name>") \
  --project=cpa-platform-prod

# Redeploy Cloud Run services to pick up the new secret version
gcloud run services update cpa-web \
  --project=cpa-platform-prod \
  --region=australia-southeast1 \
  --update-secrets=DATABASE_URL=cpa-database-url:latest
```

**6. Decommission the old (corrupted) instance:**

Only after the recovered instance is confirmed healthy and all traffic has been redirected:

```bash
gcloud sql instances delete cpa-prod-db \
  --project=cpa-platform-prod \
  --quiet
```

**WARNING:** This is irreversible. Ensure you have a confirmed working recovery instance and a backup of the corrupted instance before deleting. Consider renaming rather than deleting if there is any uncertainty.

### PITR limitations

- Recovery point must be within the transaction log retention window (7 days).
- PITR always creates a new instance — it cannot overwrite the existing instance in-place.
- The recovered instance will have the same flags and configuration as the source, but IAM bindings and Secret Manager references will need updating.
- If the source instance is deleted, PITR from it is no longer possible — ensure backups are verified before decommissioning.
