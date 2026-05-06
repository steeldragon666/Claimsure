#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# CPA Platform — Secret Manager Bootstrap
#
# Idempotent script that creates all required secrets in GCP Secret Manager.
# For each secret:
#   - If it already exists → skip (prints "~")
#   - If it does not exist → create with PLACEHOLDER value (prints "+")
#
# Usage:
#   export PROD_PROJECT="cpa-platform-prod"   # default
#   export REGION="australia-southeast1"       # default
#   bash tools/gcp/secrets-bootstrap.sh
#
# After running, replace each PLACEHOLDER with the real secret value:
#   gcloud secrets versions add SECRET_NAME \
#     --project="${PROD_PROJECT}" \
#     --data-file=- <<< 'real-value'
#
# Prerequisites:
#   gcloud auth application-default login
#   Role required: roles/secretmanager.admin on PROD_PROJECT
# =============================================================================

PROD_PROJECT="${PROD_PROJECT:-cpa-platform-prod}"
REGION="${REGION:-australia-southeast1}"

# secrets array: "secret-name:Human-readable description (max 63 chars for label)"
# Format: name:description
SECRETS=(
  # ── Database ──────────────────────────────────────────────────────────────
  "database-url:Postgres privileged URL (migration runner)"
  "database-url-app:Postgres app URL (cpa_app role, RLS applies)"
  "database-pool-max:Postgres pool max connections"

  # ── AI / ML ───────────────────────────────────────────────────────────────
  "anthropic-api-key:Anthropic Claude API key"
  "voyage-api-key:Voyage AI embeddings API key"

  # ── Session / Crypto ──────────────────────────────────────────────────────
  "session-jwt-secret:JWT signing key (openssl rand -base64 32)"
  "token-encryption-key:AES-256-GCM key for OAuth tokens"

  # ── Observability ─────────────────────────────────────────────────────────
  "grafana-otlp-endpoint:Grafana Cloud OTLP endpoint URL"
  "grafana-otlp-username:Grafana Cloud OTLP username"
  "grafana-otlp-password:Grafana Cloud OTLP password"
  "sentry-dsn-api:Sentry DSN for the API service"
  "sentry-dsn-web:Sentry DSN for the web service"

  # ── Microsoft OIDC ────────────────────────────────────────────────────────
  "microsoft-oidc-client-id:Microsoft Entra OIDC client ID"
  "microsoft-oidc-client-secret:Microsoft Entra OIDC client secret"

  # ── Google OIDC ───────────────────────────────────────────────────────────
  "google-oidc-client-id:Google Workspace OIDC client ID"
  "google-oidc-client-secret:Google Workspace OIDC client secret"

  # ── DocuSign ──────────────────────────────────────────────────────────────
  "docusign-client-id:DocuSign OAuth client ID"
  "docusign-client-secret:DocuSign OAuth client secret"
  "docusign-webhook-hmac-secret:DocuSign Connect webhook HMAC secret"

  # ── Xero ──────────────────────────────────────────────────────────────────
  "xero-accounting-client-id:Xero Accounting OAuth client ID"
  "xero-accounting-client-secret:Xero Accounting OAuth client secret"

  # ── GitHub App ────────────────────────────────────────────────────────────
  "github-app-id:GitHub App numeric ID"
  "github-app-private-key:GitHub App RS256 private key PEM"
  "github-app-installation-id:GitHub App installation ID"
  "github-webhook-secret:GitHub webhook HMAC secret"

  # ── Stripe ────────────────────────────────────────────────────────────────
  "stripe-api-key:Stripe production API key (sk_live_...)"
  "stripe-webhook-secret:Stripe webhook signing secret (whsec_...)"
  "stripe-price-id-onboarding:Stripe price ID for onboarding fee"
  "stripe-price-id-per-claim:Stripe price ID for per-claim metered usage"
  "stripe-price-id-mobile:Stripe price ID for mobile subscription"
  "stripe-price-id-sla-bronze:Stripe price ID for SLA Bronze"
  "stripe-price-id-sla-silver:Stripe price ID for SLA Silver"
  "stripe-price-id-sla-gold:Stripe price ID for SLA Gold"
)

PLACEHOLDER="PLACEHOLDER — set real value before deploying"
CREATED=()
SKIPPED=()

echo "=== Secret Manager Bootstrap ==="
echo "  Project : ${PROD_PROJECT}"
echo "  Region  : ${REGION}"
echo ""

for entry in "${SECRETS[@]}"; do
  secret_name="${entry%%:*}"
  description="${entry##*:}"

  if gcloud secrets describe "${secret_name}" \
       --project="${PROD_PROJECT}" \
       --quiet 2>/dev/null; then
    SKIPPED+=("${secret_name}")
    echo "~ ${secret_name} (already exists — skipped)"
  else
    echo "${PLACEHOLDER}" | gcloud secrets create "${secret_name}" \
      --project="${PROD_PROJECT}" \
      --replication-policy=user-managed \
      --locations="${REGION}" \
      --data-file=- \
      --labels="managed-by=bootstrap" \
      --quiet
    CREATED+=("${secret_name}")
    echo "+ ${secret_name}  (${description})"
  fi
done

echo ""
echo "============================================================"
echo "Created : ${#CREATED[@]}"
echo "Skipped : ${#SKIPPED[@]} (already existed)"
echo "============================================================"

if [[ ${#CREATED[@]} -gt 0 ]]; then
  echo ""
  echo "IMPORTANT: The following secrets were created with PLACEHOLDER values."
  echo "Replace each with the real secret before deploying:"
  echo ""
  for name in "${CREATED[@]}"; do
    echo "  gcloud secrets versions add ${name} \\"
    echo "    --project=${PROD_PROJECT} --data-file=- <<< 'real-value'"
  done
fi
