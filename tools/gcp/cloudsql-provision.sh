#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# CPA Platform — Cloud SQL Provisioning
#
# Idempotent script that provisions Cloud SQL Postgres 16 instances (prod + stg)
# with pgvector enabled, automated backups, and PITR in australia-southeast1.
#
# Usage:
#   bash tools/gcp/cloudsql-provision.sh
#
# All variables can be overridden via environment:
#   PROD_PROJECT      — defaults to cpa-platform-prod
#   STG_PROJECT       — defaults to cpa-platform-stg
#   REGION            — defaults to australia-southeast1
#   DB_INSTANCE_PROD  — defaults to cpa-prod-db
#   DB_INSTANCE_STG   — defaults to cpa-stg-db
#   DB_TIER           — defaults to db-custom-2-4096 (2 vCPU, 4 GB RAM)
#
# Region fallback:
#   If australia-southeast1 has insufficient capacity, set:
#     export REGION=australia-southeast2
#   and re-run.
# -----------------------------------------------------------------------------

PROD_PROJECT="${PROD_PROJECT:-cpa-platform-prod}"
STG_PROJECT="${STG_PROJECT:-cpa-platform-stg}"
REGION="${REGION:-australia-southeast1}"
DB_INSTANCE_PROD="${DB_INSTANCE_PROD:-cpa-prod-db}"
DB_INSTANCE_STG="${DB_INSTANCE_STG:-cpa-stg-db}"
DB_TIER="${DB_TIER:-db-custom-2-4096}"

# Tracks what this run actually changed vs. what was already in place
CREATED=()
SKIPPED=()

log()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
info() { log "INFO  $*"; }
ok()   { log "OK    $*"; }
warn() { log "WARN  $*"; }
skip() { log "SKIP  $*"; SKIPPED+=("$*"); }
done_created() { log "DONE  $*"; CREATED+=("$*"); }
err()  { log "ERROR $*" >&2; }

# -----------------------------------------------------------------------------
# Helper: create a Cloud SQL instance if it does not already exist
# -----------------------------------------------------------------------------
create_instance_if_missing() {
  local instance="$1"
  local project="$2"

  if gcloud sql instances describe "${instance}" \
       --project="${project}" --quiet 2>/dev/null; then
    skip "Cloud SQL instance ${instance} (${project}) already exists, skipping create"
    return 0
  fi

  info "Creating Cloud SQL instance ${instance} in project ${project} (${REGION})..."

  if ! gcloud sql instances create "${instance}" \
         --project="${project}" \
         --database-version=POSTGRES_16 \
         --region="${REGION}" \
         --tier="${DB_TIER}" \
         --availability-type=REGIONAL \
         --enable-google-private-path \
         --no-assign-ip \
         --quiet; then

    err "Failed to create ${instance} in ${REGION}."
    err "If this is a capacity error, retry with a different region:"
    err "  export REGION=australia-southeast2"
    err "  bash tools/gcp/cloudsql-provision.sh"
    exit 1
  fi

  done_created "Cloud SQL instance: ${instance} (${project})"
}

# -----------------------------------------------------------------------------
# Helper: enable pgvector via database flag
# -----------------------------------------------------------------------------
enable_pgvector() {
  local instance="$1"
  local project="$2"

  info "Enabling cloudsql.enable_pgvector flag on ${instance} (${project})..."
  gcloud sql instances patch "${instance}" \
    --project="${project}" \
    --database-flags=cloudsql.enable_pgvector=on \
    --quiet
  ok "pgvector flag set on ${instance} (${project})"
}

# -----------------------------------------------------------------------------
# Helper: create a database inside the instance if it does not exist
# -----------------------------------------------------------------------------
create_database_if_missing() {
  local db_name="$1"
  local instance="$2"
  local project="$3"

  if gcloud sql databases describe "${db_name}" \
       --instance="${instance}" \
       --project="${project}" --quiet 2>/dev/null; then
    skip "Database ${db_name} on ${instance} already exists, skipping create"
    return 0
  fi

  info "Creating database ${db_name} on ${instance} (${project})..."
  gcloud sql databases create "${db_name}" \
    --instance="${instance}" \
    --project="${project}" \
    --quiet
  done_created "Database: ${db_name} on ${instance} (${project})"
}

# -----------------------------------------------------------------------------
# Helper: create a Cloud SQL user if it does not exist
# -----------------------------------------------------------------------------
create_user_if_missing() {
  local username="$1"
  local instance="$2"
  local project="$3"

  local existing
  existing=$(gcloud sql users list \
    --instance="${instance}" \
    --project="${project}" \
    --format="value(name)" \
    --quiet 2>/dev/null | grep -x "${username}" || true)

  if [[ -n "${existing}" ]]; then
    skip "User ${username} on ${instance} already exists, skipping create"
    return 0
  fi

  info "Creating user ${username} on ${instance} (${project})..."
  gcloud sql users create "${username}" \
    --instance="${instance}" \
    --project="${project}" \
    --quiet
  done_created "User: ${username} on ${instance} (${project})"
}

# -----------------------------------------------------------------------------
# Helper: configure automated backups + PITR
# -----------------------------------------------------------------------------
configure_backups() {
  local instance="$1"
  local project="$2"

  info "Configuring automated backups and PITR on ${instance} (${project})..."
  gcloud sql instances patch "${instance}" \
    --project="${project}" \
    --backup-start-time="02:00" \
    --backup-location="${REGION}" \
    --retained-backups-count=7 \
    --enable-point-in-time-recovery \
    --quiet
  ok "Backups + PITR configured on ${instance} (${project})"
}

# -----------------------------------------------------------------------------
# Helper: provision one full environment (instance + db + user + backups)
# -----------------------------------------------------------------------------
provision_environment() {
  local instance="$1"
  local project="$2"
  local env_label="$3"

  info "=== Provisioning ${env_label} (${instance} in ${project}) ==="

  # 1. Create instance
  create_instance_if_missing "${instance}" "${project}"

  # 2. Enable pgvector
  enable_pgvector "${instance}" "${project}"

  # 3. Create application database
  create_database_if_missing "cpa_app" "${instance}" "${project}"

  # 4. Create application user
  create_user_if_missing "cpa_app" "${instance}" "${project}"

  # 5. Configure backups + PITR
  configure_backups "${instance}" "${project}"

  ok "=== ${env_label} provisioning complete ==="
  echo ""
}

# =============================================================================
# MAIN
# =============================================================================

info "CPA Platform — Cloud SQL Provisioning"
info "Region   : ${REGION}"
info "Prod     : ${DB_INSTANCE_PROD} in ${PROD_PROJECT}"
info "Staging  : ${DB_INSTANCE_STG} in ${STG_PROJECT}"
info "Tier     : ${DB_TIER}"
echo ""

# -----------------------------------------------------------------------------
# Production
# -----------------------------------------------------------------------------
provision_environment "${DB_INSTANCE_PROD}" "${PROD_PROJECT}" "Production"

# -----------------------------------------------------------------------------
# Staging
# -----------------------------------------------------------------------------
provision_environment "${DB_INSTANCE_STG}" "${STG_PROJECT}" "Staging"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo "============================================================"
echo " CPA Platform Cloud SQL Provisioning — Summary"
echo "============================================================"
echo " Region          : ${REGION}"
echo " Prod instance   : ${DB_INSTANCE_PROD} (${PROD_PROJECT})"
echo " Stg  instance   : ${DB_INSTANCE_STG} (${STG_PROJECT})"
echo " Tier            : ${DB_TIER}"
echo " pgvector        : enabled (cloudsql.enable_pgvector=on)"
echo " Backups         : daily at 02:00 UTC, retained 7 days, PITR on"
echo ""

if [[ ${#CREATED[@]} -gt 0 ]]; then
  echo " Resources CREATED this run:"
  for item in "${CREATED[@]}"; do
    echo "   + ${item}"
  done
else
  echo " No new resources created — all already existed."
fi

if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  echo ""
  echo " Resources SKIPPED (already existed):"
  for item in "${SKIPPED[@]}"; do
    echo "   ~ ${item}"
  done
fi

echo ""
echo " Connection strings:"
echo "   Prod: ${DB_INSTANCE_PROD} — $(gcloud sql instances describe "${DB_INSTANCE_PROD}" \
    --project="${PROD_PROJECT}" --format='value(connectionName)' --quiet 2>/dev/null || echo '<run after instance is ready>')"
echo "   Stg:  ${DB_INSTANCE_STG} — $(gcloud sql instances describe "${DB_INSTANCE_STG}" \
    --project="${STG_PROJECT}" --format='value(connectionName)' --quiet 2>/dev/null || echo '<run after instance is ready>')"
echo ""
echo " Verification commands:"
echo "   gcloud sql instances describe ${DB_INSTANCE_PROD} --project=${PROD_PROJECT}"
echo "   gcloud sql instances describe ${DB_INSTANCE_STG}  --project=${STG_PROJECT}"
echo "============================================================"
