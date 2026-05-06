#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# CPA Platform — Cloud SQL Restore Drill
#
# Clones the latest production Cloud SQL instance to a temporary drill instance,
# prints connection information for manual verification, then deletes the drill
# instance (unless SKIP_DELETE=1 is set).
#
# Usage:
#   bash tools/gcp/cloudsql-restore-drill.sh
#
# All variables can be overridden via environment:
#   PROD_PROJECT      — defaults to cpa-platform-prod
#   REGION            — defaults to australia-southeast1
#   DB_INSTANCE_PROD  — defaults to cpa-prod-db
#   SKIP_DELETE       — set to 1 to keep the drill instance for manual inspection
#
# Examples:
#   # Standard drill (clone → verify → delete)
#   bash tools/gcp/cloudsql-restore-drill.sh
#
#   # Keep drill instance for manual inspection
#   SKIP_DELETE=1 bash tools/gcp/cloudsql-restore-drill.sh
# -----------------------------------------------------------------------------

PROD_PROJECT="${PROD_PROJECT:-cpa-platform-prod}"
REGION="${REGION:-australia-southeast1}"
DB_INSTANCE_PROD="${DB_INSTANCE_PROD:-cpa-prod-db}"
SKIP_DELETE="${SKIP_DELETE:-0}"

DRILL_SUFFIX="$(date +%Y%m%d)"
DRILL_INSTANCE="${DB_INSTANCE_PROD}-drill-${DRILL_SUFFIX}"

log()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
info() { log "INFO  $*"; }
ok()   { log "OK    $*"; }
warn() { log "WARN  $*"; }
err()  { log "ERROR $*" >&2; }

# -----------------------------------------------------------------------------
# Trap: ensure drill instance is deleted on unexpected exit unless SKIP_DELETE=1
# -----------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  if [[ "${SKIP_DELETE}" == "1" ]]; then
    warn "SKIP_DELETE=1 — leaving drill instance ${DRILL_INSTANCE} in place."
    warn "Remember to delete it manually when done:"
    warn "  gcloud sql instances delete ${DRILL_INSTANCE} --project=${PROD_PROJECT} --quiet"
    exit "${exit_code}"
  fi

  if gcloud sql instances describe "${DRILL_INSTANCE}" \
       --project="${PROD_PROJECT}" --quiet 2>/dev/null; then
    warn "Unexpected exit — cleaning up drill instance ${DRILL_INSTANCE}..."
    gcloud sql instances delete "${DRILL_INSTANCE}" \
      --project="${PROD_PROJECT}" \
      --quiet || true
    warn "Drill instance ${DRILL_INSTANCE} deleted during cleanup."
  fi

  exit "${exit_code}"
}
trap cleanup EXIT

# =============================================================================
# MAIN
# =============================================================================

info "CPA Platform — Cloud SQL Restore Drill"
info "Source instance : ${DB_INSTANCE_PROD} (${PROD_PROJECT})"
info "Drill instance  : ${DRILL_INSTANCE}"
info "SKIP_DELETE     : ${SKIP_DELETE}"
echo ""

# -----------------------------------------------------------------------------
# Step 1: Verify source instance exists
# -----------------------------------------------------------------------------
info "=== Step 1: Verify source instance ==="

if ! gcloud sql instances describe "${DB_INSTANCE_PROD}" \
     --project="${PROD_PROJECT}" --quiet 2>/dev/null; then
  err "Source instance ${DB_INSTANCE_PROD} not found in project ${PROD_PROJECT}."
  err "Ensure cloudsql-provision.sh has been run first."
  exit 1
fi

ok "Source instance ${DB_INSTANCE_PROD} confirmed."

# Check that a drill instance from today does not already exist
if gcloud sql instances describe "${DRILL_INSTANCE}" \
     --project="${PROD_PROJECT}" --quiet 2>/dev/null; then
  warn "Drill instance ${DRILL_INSTANCE} already exists from a previous run today."
  warn "Proceeding with the existing drill instance for verification."
else

  # --------------------------------------------------------------------------
  # Step 2: Clone the production instance
  # --------------------------------------------------------------------------
  info "=== Step 2: Clone production instance ==="
  info "Cloning ${DB_INSTANCE_PROD} → ${DRILL_INSTANCE}..."
  info "(This operation typically takes 5–15 minutes)"

  gcloud sql instances clone "${DB_INSTANCE_PROD}" "${DRILL_INSTANCE}" \
    --project="${PROD_PROJECT}" \
    --quiet

  ok "Drill instance ${DRILL_INSTANCE} created from latest ${DB_INSTANCE_PROD} backup."
fi

# -----------------------------------------------------------------------------
# Step 3: Migration verification
# -----------------------------------------------------------------------------
info "=== Step 3: Migration verification ==="

DRILL_CONNECTION_NAME=$(gcloud sql instances describe "${DRILL_INSTANCE}" \
  --project="${PROD_PROJECT}" \
  --format="value(connectionName)" \
  --quiet)

echo ""
echo "------------------------------------------------------------"
echo " DRILL INSTANCE READY FOR VERIFICATION"
echo "------------------------------------------------------------"
echo " Instance name    : ${DRILL_INSTANCE}"
echo " Connection name  : ${DRILL_CONNECTION_NAME}"
echo " Project          : ${PROD_PROJECT}"
echo ""
echo " To connect via Cloud SQL Auth Proxy:"
echo "   cloud-sql-proxy ${DRILL_CONNECTION_NAME} --port=5434"
echo "   psql 'host=127.0.0.1 port=5434 dbname=cpa_app user=cpa_app'"
echo ""
echo " Verify pgvector extension:"
echo "   SELECT * FROM pg_extension WHERE extname = 'vector';"
echo ""
echo " Verify latest migration:"
echo "   SELECT version FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1;"
echo ""
echo " Verify row counts (sanity check):"
echo "   SELECT schemaname, tablename, n_live_tup"
echo "     FROM pg_stat_user_tables"
echo "     ORDER BY n_live_tup DESC"
echo "     LIMIT 20;"
echo "------------------------------------------------------------"
echo ""

# Give the operator a pause if SKIP_DELETE is not set
if [[ "${SKIP_DELETE}" != "1" ]]; then
  info "Drill instance is ready. Sleeping 60 seconds before auto-delete."
  info "Press Ctrl+C now to abort deletion (SKIP_DELETE=1 to preserve on next run)."
  sleep 60
fi

# -----------------------------------------------------------------------------
# Step 4: Delete drill instance (unless SKIP_DELETE=1)
# -----------------------------------------------------------------------------
if [[ "${SKIP_DELETE}" == "1" ]]; then
  warn "=== Step 4: Skipping deletion (SKIP_DELETE=1) ==="
  warn "Drill instance ${DRILL_INSTANCE} preserved for manual inspection."
  warn "Delete when done:"
  warn "  gcloud sql instances delete ${DRILL_INSTANCE} --project=${PROD_PROJECT} --quiet"
else
  info "=== Step 4: Delete drill instance ==="
  info "Deleting drill instance ${DRILL_INSTANCE}..."

  gcloud sql instances delete "${DRILL_INSTANCE}" \
    --project="${PROD_PROJECT}" \
    --quiet

  ok "Drill instance ${DRILL_INSTANCE} deleted."
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " CPA Platform Cloud SQL Restore Drill — Summary"
echo "============================================================"
echo " Source instance : ${DB_INSTANCE_PROD} (${PROD_PROJECT})"
echo " Drill instance  : ${DRILL_INSTANCE}"
if [[ "${SKIP_DELETE}" == "1" ]]; then
  echo " Status          : PRESERVED (SKIP_DELETE=1)"
  echo " Action required : Delete manually when inspection is complete"
else
  echo " Status          : COMPLETE — drill instance deleted"
fi
echo "============================================================"

# Disable trap — normal exit, no extra cleanup needed
trap - EXIT
