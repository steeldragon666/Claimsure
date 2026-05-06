#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# CPA Platform — Cloud Monitoring Alert Policy Setup
#
# Creates (or updates) the four production alert policies for the CPA Platform
# and wires them to PagerDuty (for critical/warning) and email (for Cloud SQL).
#
# Prerequisites:
#   gcloud auth application-default login
#   Roles required on PROD_PROJECT:
#     roles/monitoring.alertPolicyEditor
#     roles/monitoring.notificationChannelEditor
#
# Usage:
#   export PROD_PROJECT="cpa-platform-prod"      # default
#   export PAGERDUTY_SERVICE_KEY="<pd-key>"      # from PagerDuty (P8 T1.2)
#   export ALERT_EMAIL="aaron@cpaplatform.com"   # email for non-critical alerts
#   bash tools/gcp/monitoring-setup.sh
#
# Idempotency:
#   The script checks for existing channels/policies by display name and skips
#   creation if they already exist. Re-running is safe.
# =============================================================================

PROD_PROJECT="${PROD_PROJECT:-cpa-platform-prod}"
PAGERDUTY_SERVICE_KEY="${PAGERDUTY_SERVICE_KEY:?PAGERDUTY_SERVICE_KEY must be set (from PagerDuty integration — P8 T1.2)}"
ALERT_EMAIL="${ALERT_EMAIL:?ALERT_EMAIL must be set (e.g. aaron@cpaplatform.com)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_DIR="${SCRIPT_DIR}/monitoring"

echo "=== CPA Platform — Cloud Monitoring Setup ==="
echo "  Project : ${PROD_PROJECT}"
echo "  Email   : ${ALERT_EMAIL}"
echo ""

# ─── 1. Create or retrieve the PagerDuty notification channel ────────────────

echo "--- Configuring PagerDuty notification channel ---"

PD_CHANNEL_NAME="CPA Platform PagerDuty"

EXISTING_PD=$(gcloud alpha monitoring channels list \
  --project="${PROD_PROJECT}" \
  --filter="displayName=\"${PD_CHANNEL_NAME}\"" \
  --format="value(name)" 2>/dev/null | head -1 || true)

if [[ -n "${EXISTING_PD}" ]]; then
  echo "  PagerDuty channel already exists: ${EXISTING_PD}"
  PD_CHANNEL_ID="${EXISTING_PD}"
else
  echo "  Creating PagerDuty notification channel..."
  PD_CHANNEL_ID=$(gcloud alpha monitoring channels create \
    --project="${PROD_PROJECT}" \
    --display-name="${PD_CHANNEL_NAME}" \
    --type=pagerduty \
    --channel-labels="service_key=${PAGERDUTY_SERVICE_KEY}" \
    --format="value(name)")
  echo "  Created: ${PD_CHANNEL_ID}"
fi

# ─── 2. Create or retrieve the email notification channel ────────────────────

echo ""
echo "--- Configuring email notification channel ---"

EMAIL_CHANNEL_NAME="CPA Platform Email Alerts"

EXISTING_EMAIL=$(gcloud alpha monitoring channels list \
  --project="${PROD_PROJECT}" \
  --filter="displayName=\"${EMAIL_CHANNEL_NAME}\"" \
  --format="value(name)" 2>/dev/null | head -1 || true)

if [[ -n "${EXISTING_EMAIL}" ]]; then
  echo "  Email channel already exists: ${EXISTING_EMAIL}"
  EMAIL_CHANNEL_ID="${EXISTING_EMAIL}"
else
  echo "  Creating email notification channel..."
  EMAIL_CHANNEL_ID=$(gcloud alpha monitoring channels create \
    --project="${PROD_PROJECT}" \
    --display-name="${EMAIL_CHANNEL_NAME}" \
    --type=email \
    --channel-labels="email_address=${ALERT_EMAIL}" \
    --format="value(name)")
  echo "  Created: ${EMAIL_CHANNEL_ID}"
fi

# ─── 3. Helper: create or skip alert policy ──────────────────────────────────

create_policy_if_absent() {
  local policy_file="$1"
  local channel_id="$2"
  local display_name
  display_name=$(grep '^displayName:' "${policy_file}" | sed 's/^displayName: *//' | tr -d '"')

  echo ""
  echo "--- Policy: ${display_name} ---"

  EXISTING_POLICY=$(gcloud alpha monitoring policies list \
    --project="${PROD_PROJECT}" \
    --filter="displayName=\"${display_name}\"" \
    --format="value(name)" 2>/dev/null | head -1 || true)

  if [[ -n "${EXISTING_POLICY}" ]]; then
    echo "  Already exists — skipping: ${EXISTING_POLICY}"
    return
  fi

  # Inject the notification channel into the YAML (replace placeholder list)
  local tmp_file
  tmp_file=$(mktemp /tmp/cpa-policy-XXXXXX.yaml)
  sed "s|notificationChannels: \[\].*|notificationChannels:\n  - ${channel_id}|" \
    "${policy_file}" > "${tmp_file}"

  gcloud alpha monitoring policies create \
    --project="${PROD_PROJECT}" \
    --policy-from-file="${tmp_file}" \
    --format="value(name)"

  rm -f "${tmp_file}"
  echo "  Created."
}

# ─── 4. Create alert policies ─────────────────────────────────────────────────

# P1 policies → PagerDuty
create_policy_if_absent "${POLICY_DIR}/cloudrun-error-rate.yaml"    "${PD_CHANNEL_ID}"
create_policy_if_absent "${POLICY_DIR}/cloudrun-min-instances.yaml" "${PD_CHANNEL_ID}"

# P2 policy → PagerDuty (latency is customer-impacting but not P1)
create_policy_if_absent "${POLICY_DIR}/cloudrun-p99-latency.yaml"   "${PD_CHANNEL_ID}"

# P2 policy → email (Cloud SQL CPU is infrastructure-only, not directly customer-facing)
create_policy_if_absent "${POLICY_DIR}/cloudsql-cpu.yaml"           "${EMAIL_CHANNEL_ID}"

# ─── 5. Summary ───────────────────────────────────────────────────────────────

echo ""
echo "=== Cloud Monitoring setup complete ==="
echo ""
echo "Alert policies created in project: ${PROD_PROJECT}"
echo ""
echo "Next steps:"
echo "  1. Open Cloud Console → Monitoring → Alerting to verify policies."
echo "  2. Test each policy: see docs/runbooks/monitoring.md — Testing Alerts section."
echo "  3. Verify Grafana OTLP is receiving traces: check Grafana → Explore → Tempo."
echo "  4. Verify Sentry DSNs are populated: gcloud secrets versions access latest"
echo "       --secret=sentry-dsn-api --project=${PROD_PROJECT}"
echo "  5. Once @sentry/node is installed in cpa-api, activate the TODO in"
echo "       apps/api/src/server.ts (P9.1)."
echo ""
