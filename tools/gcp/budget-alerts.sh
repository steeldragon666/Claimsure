#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# CPA Platform — GCP Budget Alerts
#
# Creates billing budget alerts at 50%, 90%, and 100% of a $200 AUD/month
# cap for both the production and staging projects.
#
# Usage:
#   export BILLING_ACCOUNT_ID="ABCDEF-123456-GHIJKL"
#   bash tools/gcp/budget-alerts.sh
#
# All variables can be overridden via environment:
#   PROD_PROJECT        — defaults to cpa-platform-prod
#   STG_PROJECT         — defaults to cpa-platform-stg
#   BUDGET_AMOUNT       — defaults to 200AUD
#   BILLING_ACCOUNT_ID  — required, no default
#
# Note: This script creates budgets; it does not check for existing budgets
# before creating. Re-running will create duplicate budgets. Use the GCP
# console or `gcloud billing budgets list` to audit existing budgets before
# re-running.
# -----------------------------------------------------------------------------

PROD_PROJECT="${PROD_PROJECT:-cpa-platform-prod}"
STG_PROJECT="${STG_PROJECT:-cpa-platform-stg}"
BUDGET_AMOUNT="${BUDGET_AMOUNT:-200AUD}"

# BILLING_ACCOUNT_ID is required — fail fast with a helpful message if unset
: "${BILLING_ACCOUNT_ID:?ERROR: BILLING_ACCOUNT_ID must be set (e.g. export BILLING_ACCOUNT_ID=ABCDEF-123456-GHIJKL)}"

log()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
info() { log "INFO  $*"; }
ok()   { log "OK    $*"; }

# -----------------------------------------------------------------------------
# Helper: create a budget for one project
# -----------------------------------------------------------------------------
create_budget() {
  local project_id="$1"
  local display_name="$2"

  info "Creating budget '${display_name}' for project ${project_id}..."

  gcloud billing budgets create \
    --billing-account="${BILLING_ACCOUNT_ID}" \
    --display-name="${display_name}" \
    --projects="projects/${project_id}" \
    --budget-amount="${BUDGET_AMOUNT}" \
    --threshold-rule=percent=0.5,basis=CURRENT_SPEND \
    --threshold-rule=percent=0.9,basis=CURRENT_SPEND \
    --threshold-rule=percent=1.0,basis=CURRENT_SPEND

  ok "Budget created: ${display_name}"
  ok "  Alerts at 50%, 90%, and 100% of ${BUDGET_AMOUNT}/month"
}

# -----------------------------------------------------------------------------
# List existing budgets so the operator can decide whether to proceed
# -----------------------------------------------------------------------------
info "=== Existing budgets for billing account ${BILLING_ACCOUNT_ID} ==="
gcloud billing budgets list \
  --billing-account="${BILLING_ACCOUNT_ID}" \
  --format="table(displayName,amount.specifiedAmount.units,amount.specifiedAmount.currencyCode)" \
  2>/dev/null || info "(none found or insufficient permissions)"

echo ""
info "=== Creating budget alerts ==="

# -----------------------------------------------------------------------------
# Production budget
# -----------------------------------------------------------------------------
create_budget "${PROD_PROJECT}" "CPA Platform Prod Monthly Budget"

# -----------------------------------------------------------------------------
# Staging budget
# -----------------------------------------------------------------------------
create_budget "${STG_PROJECT}" "CPA Platform Stg Monthly Budget"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " CPA Platform GCP Budget Alerts — Summary"
echo "============================================================"
echo " Billing account : ${BILLING_ACCOUNT_ID}"
echo " Budget amount   : ${BUDGET_AMOUNT} / month (per project)"
echo ""
echo " Budgets created:"
echo "   + CPA Platform Prod Monthly Budget (${PROD_PROJECT})"
echo "     Alerts at 50% (\$100), 90% (\$180), 100% (\$200)"
echo "   + CPA Platform Stg Monthly Budget (${STG_PROJECT})"
echo "     Alerts at 50% (\$100), 90% (\$180), 100% (\$200)"
echo ""
echo " Verify in GCP Console:"
echo "   https://console.cloud.google.com/billing/${BILLING_ACCOUNT_ID}/budgets"
echo ""
echo " List via CLI:"
echo "   gcloud billing budgets list --billing-account=${BILLING_ACCOUNT_ID}"
echo "============================================================"
