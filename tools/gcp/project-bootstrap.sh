#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# CPA Platform — GCP Project Bootstrap
#
# Idempotent script that provisions GCP projects (prod + stg), links billing,
# enables required APIs, and creates the deployment service account.
#
# Usage:
#   export BILLING_ACCOUNT_ID="ABCDEF-123456-GHIJKL"
#   bash tools/gcp/project-bootstrap.sh
#
# All variables can be overridden via environment:
#   PROD_PROJECT   — defaults to cpa-platform-prod
#   STG_PROJECT    — defaults to cpa-platform-stg
#   BILLING_ACCOUNT_ID — required, no default
# -----------------------------------------------------------------------------

PROD_PROJECT="${PROD_PROJECT:-cpa-platform-prod}"
STG_PROJECT="${STG_PROJECT:-cpa-platform-stg}"
PROD_NAME="${PROD_NAME:-CPA Platform Production}"
STG_NAME="${STG_NAME:-CPA Platform Staging}"
DEPLOY_SA_NAME="cpa-deploy"
DEPLOY_SA="${DEPLOY_SA_NAME}@${PROD_PROJECT}.iam.gserviceaccount.com"

# BILLING_ACCOUNT_ID is required — fail fast with a helpful message if unset
: "${BILLING_ACCOUNT_ID:?ERROR: BILLING_ACCOUNT_ID must be set (e.g. export BILLING_ACCOUNT_ID=ABCDEF-123456-GHIJKL)}"

# APIs to enable on both projects
REQUIRED_APIS=(
  run.googleapis.com
  sqladmin.googleapis.com
  secretmanager.googleapis.com
  compute.googleapis.com
  cloudbuild.googleapis.com
  monitoring.googleapis.com
  logging.googleapis.com
  dns.googleapis.com
  iam.googleapis.com
)

# Roles to grant to the deployment service account (on prod project)
DEPLOY_SA_ROLES=(
  roles/run.admin
  roles/cloudsql.admin
  roles/secretmanager.admin
  roles/storage.admin
  roles/cloudbuild.builds.builder
)

# Tracks what this run actually changed vs. what was already in place
CREATED=()
SKIPPED=()

log()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
info() { log "INFO  $*"; }
ok()   { log "OK    $*"; }
skip() { log "SKIP  $*"; SKIPPED+=("$*"); }
done_created() { log "DONE  $*"; CREATED+=("$*"); }

# -----------------------------------------------------------------------------
# 1. Create GCP projects (idempotent)
# -----------------------------------------------------------------------------
info "=== Step 1: GCP project creation ==="

create_project_if_missing() {
  local project_id="$1"
  local display_name="$2"

  if gcloud projects describe "${project_id}" --quiet 2>/dev/null; then
    skip "Project ${project_id} already exists, skipping create"
  else
    info "Creating project ${project_id} (${display_name})..."
    gcloud projects create "${project_id}" \
      --name="${display_name}" \
      --quiet
    done_created "Project: ${project_id}"
  fi
}

create_project_if_missing "${PROD_PROJECT}" "${PROD_NAME}"
create_project_if_missing "${STG_PROJECT}"  "${STG_NAME}"

# -----------------------------------------------------------------------------
# 2. Link billing accounts
# -----------------------------------------------------------------------------
info "=== Step 2: Billing account linking ==="

link_billing() {
  local project_id="$1"
  info "Linking billing account ${BILLING_ACCOUNT_ID} to ${project_id}..."
  gcloud billing projects link "${project_id}" \
    --billing-account="${BILLING_ACCOUNT_ID}" \
    --quiet
  ok "Billing linked for ${project_id}"
}

link_billing "${PROD_PROJECT}"
link_billing "${STG_PROJECT}"

# -----------------------------------------------------------------------------
# 3. Enable required APIs on both projects
# -----------------------------------------------------------------------------
info "=== Step 3: Enabling APIs ==="

enable_apis() {
  local project_id="$1"
  info "Enabling APIs on ${project_id}..."
  for api in "${REQUIRED_APIS[@]}"; do
    info "  Enabling ${api} on ${project_id}..."
    gcloud services enable "${api}" \
      --project="${project_id}" \
      --quiet
    ok "  ${api} enabled on ${project_id}"
  done
}

enable_apis "${PROD_PROJECT}"
enable_apis "${STG_PROJECT}"

# -----------------------------------------------------------------------------
# 4. Create deployment service account (idempotent)
# -----------------------------------------------------------------------------
info "=== Step 4: Deployment service account ==="

SA_EXISTS=$(gcloud iam service-accounts list \
  --project="${PROD_PROJECT}" \
  --filter="email:${DEPLOY_SA}" \
  --format="value(email)" \
  --quiet 2>/dev/null || true)

if [[ -n "${SA_EXISTS}" ]]; then
  skip "Service account ${DEPLOY_SA} already exists, skipping create"
else
  info "Creating service account ${DEPLOY_SA}..."
  gcloud iam service-accounts create "${DEPLOY_SA_NAME}" \
    --project="${PROD_PROJECT}" \
    --display-name="CPA Platform Deployment SA" \
    --description="Used by CI/CD pipelines to deploy to Cloud Run, Cloud SQL, etc." \
    --quiet
  done_created "Service account: ${DEPLOY_SA}"
fi

# -----------------------------------------------------------------------------
# 5. Bind IAM roles to deployment service account
# -----------------------------------------------------------------------------
info "=== Step 5: IAM role bindings ==="

for role in "${DEPLOY_SA_ROLES[@]}"; do
  info "Granting ${role} to ${DEPLOY_SA} on ${PROD_PROJECT}..."
  gcloud projects add-iam-policy-binding "${PROD_PROJECT}" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="${role}" \
    --quiet \
    --condition=None 2>/dev/null
  ok "  Granted ${role}"
done

# -----------------------------------------------------------------------------
# 6. Summary
# -----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " CPA Platform GCP Bootstrap — Summary"
echo "============================================================"
echo " Production project : ${PROD_PROJECT}"
echo " Staging project    : ${STG_PROJECT}"
echo " Billing account    : ${BILLING_ACCOUNT_ID}"
echo " Deploy SA          : ${DEPLOY_SA}"
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
echo " Verification commands:"
echo "   gcloud projects describe ${PROD_PROJECT}"
echo "   gcloud projects describe ${STG_PROJECT}"
echo "   gcloud iam service-accounts describe ${DEPLOY_SA} --project=${PROD_PROJECT}"
echo "============================================================"
