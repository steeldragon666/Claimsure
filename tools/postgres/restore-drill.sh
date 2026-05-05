#!/usr/bin/env bash
# restore-drill.sh — Automated PITR restore drill for CPA Platform
#
# Restores a pgBackRest backup to a temporary cluster, verifies data
# integrity against critical tables, and checks that elapsed time stays
# within the RTO target (1 hour / 3600 seconds).
#
# Usage:
#   ./restore-drill.sh [TARGET_TIMESTAMP]
#
# TARGET_TIMESTAMP defaults to 5 minutes ago (UTC) when omitted.
# Format: "YYYY-MM-DD HH:MM:SS+00" (PostgreSQL timestamp with tz).

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────
STANZA="cpa-prod"
RESTORE_PORT=5455
RTO_SECONDS=3600
PG_BIN="/usr/lib/postgresql/16/bin"

# Critical tables whose row counts are verified post-restore.
CRITICAL_TABLES=(
  tenant
  "user"
  subject_tenant
  event
  activity
  expenditure
  narrative_draft
  audit_log
)

# ── Resolve target timestamp ──────────────────────────────────────────
if [[ $# -ge 1 ]]; then
  TARGET_TS="$1"
else
  TARGET_TS=$(date -u -d '5 minutes ago' '+%Y-%m-%d %H:%M:%S+00' 2>/dev/null \
    || date -u -v-5M '+%Y-%m-%d %H:%M:%S+00')
fi

echo "=== CPA Platform PITR Restore Drill ==="
echo "Target timestamp : ${TARGET_TS}"
echo "Restore port     : ${RESTORE_PORT}"
echo "RTO target       : ${RTO_SECONDS}s"
echo ""

# ── Create temp working directory ─────────────────────────────────────
WORK_DIR=$(mktemp -d /tmp/cpa-restore-drill.XXXXXX)
echo "Working directory : ${WORK_DIR}"

cleanup() {
  echo ""
  echo "--- Cleanup ---"
  # Shut down the restored cluster if it's running.
  if [[ -f "${WORK_DIR}/postmaster.pid" ]]; then
    "${PG_BIN}/pg_ctl" -D "${WORK_DIR}" -m fast stop 2>/dev/null || true
  fi
  rm -rf "${WORK_DIR}"
  echo "Temporary directory removed."
}
trap cleanup EXIT

# ── Run the restore ───────────────────────────────────────────────────
START_EPOCH=$(date +%s)

echo ""
echo "--- Restoring backup (PITR to ${TARGET_TS}) ---"
pgbackrest --stanza="${STANZA}" \
  --pg1-path="${WORK_DIR}" \
  --type=time \
  --target="${TARGET_TS}" \
  --target-action=promote \
  --set=latest \
  restore

# ── Start the restored cluster ────────────────────────────────────────
echo ""
echo "--- Starting restored cluster on port ${RESTORE_PORT} ---"
"${PG_BIN}/pg_ctl" -D "${WORK_DIR}" \
  -o "-p ${RESTORE_PORT}" \
  -l "${WORK_DIR}/restore.log" \
  start

# Wait for the cluster to accept connections (up to 30 seconds).
for i in $(seq 1 30); do
  if "${PG_BIN}/pg_isready" -p "${RESTORE_PORT}" -q 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! "${PG_BIN}/pg_isready" -p "${RESTORE_PORT}" -q 2>/dev/null; then
  echo "ERROR: Restored cluster did not become ready within 30 seconds."
  exit 1
fi

# ── Verify data integrity ────────────────────────────────────────────
echo ""
echo "--- Verifying data integrity ---"
VERIFY_FAILED=0

for table in "${CRITICAL_TABLES[@]}"; do
  COUNT=$(psql -p "${RESTORE_PORT}" -d cpa -t -A \
    -c "SELECT count(*) FROM ${table};" 2>/dev/null || echo "ERROR")

  if [[ "${COUNT}" == "ERROR" ]]; then
    echo "  FAIL  ${table}: query failed"
    VERIFY_FAILED=1
  else
    echo "  OK    ${table}: ${COUNT} rows"
  fi
done

if [[ ${VERIFY_FAILED} -ne 0 ]]; then
  echo ""
  echo "ERROR: One or more table verifications failed."
  exit 1
fi

# ── Stop the restored cluster ─────────────────────────────────────────
echo ""
echo "--- Stopping restored cluster ---"
"${PG_BIN}/pg_ctl" -D "${WORK_DIR}" -m fast stop

# ── Check RTO ─────────────────────────────────────────────────────────
END_EPOCH=$(date +%s)
ELAPSED=$(( END_EPOCH - START_EPOCH ))

echo ""
echo "=== Drill Results ==="
echo "Elapsed time : ${ELAPSED}s"
echo "RTO target   : ${RTO_SECONDS}s"

if [[ ${ELAPSED} -gt ${RTO_SECONDS} ]]; then
  echo "RESULT       : FAIL (exceeded RTO by $(( ELAPSED - RTO_SECONDS ))s)"
  exit 1
else
  echo "RESULT       : PASS (${ELAPSED}s within ${RTO_SECONDS}s RTO)"
  exit 0
fi
