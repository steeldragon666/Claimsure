#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# CPA Platform — Cloud Run Deployment
#
# Builds container images via Cloud Build and deploys two Cloud Run services:
#   cpa-api  — Fastify API, port 3000, min-instances=1 (pg-boss persistence)
#   cpa-web  — Next.js web app, port 5173, min-instances=0
#
# Usage:
#   export PROD_PROJECT="cpa-platform-prod"     # default
#   export REGION="australia-southeast1"         # default
#   export IMAGE_TAG="$(git rev-parse --short HEAD)"  # recommended
#   bash tools/gcp/cloudrun-deploy.sh
#
# The script expects all secrets to exist in Secret Manager (run
# tools/gcp/secrets-bootstrap.sh first and fill in real values).
#
# Prerequisites:
#   gcloud auth application-default login
#   Roles required on PROD_PROJECT:
#     roles/cloudbuild.builds.editor
#     roles/run.admin
#     roles/secretmanager.viewer
#     roles/iam.serviceAccountUser  (for the Cloud Run service account)
# =============================================================================

PROD_PROJECT="${PROD_PROJECT:-cpa-platform-prod}"
REGION="${REGION:-australia-southeast1}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG must be set (e.g. export IMAGE_TAG=\$(git rev-parse --short HEAD))}"

REGISTRY="gcr.io/${PROD_PROJECT}"
API_IMAGE="${REGISTRY}/cpa-api:${IMAGE_TAG}"
WEB_IMAGE="${REGISTRY}/cpa-web:${IMAGE_TAG}"

# Service account that Cloud Run services run as (created by project-bootstrap.sh)
RUNTIME_SA="cpa-run@${PROD_PROJECT}.iam.gserviceaccount.com"

echo "=== CPA Platform — Cloud Run Deployment ==="
echo "  Project   : ${PROD_PROJECT}"
echo "  Region    : ${REGION}"
echo "  Image tag : ${IMAGE_TAG}"
echo "  API image : ${API_IMAGE}"
echo "  Web image : ${WEB_IMAGE}"
echo ""

# ─── 1. Build images via Cloud Build ─────────────────────────────────────────
echo "--- Building API image ---"
gcloud builds submit . \
  --tag="${API_IMAGE}" \
  --project="${PROD_PROJECT}" \
  --dockerfile="apps/api/Dockerfile"

echo ""
echo "--- Building Web image ---"
gcloud builds submit . \
  --tag="${WEB_IMAGE}" \
  --project="${PROD_PROJECT}" \
  --dockerfile="apps/web/Dockerfile"

echo ""

# ─── 2. Deploy cpa-api ───────────────────────────────────────────────────────
echo "--- Deploying cpa-api ---"
gcloud run deploy cpa-api \
  --project="${PROD_PROJECT}" \
  --region="${REGION}" \
  --image="${API_IMAGE}" \
  --platform=managed \
  --service-account="${RUNTIME_SA}" \
  --min-instances=1 \
  --max-instances=10 \
  --memory=1Gi \
  --cpu=1 \
  --port=3000 \
  --concurrency=80 \
  --timeout=60 \
  --set-env-vars="NODE_ENV=production,API_PORT=3000,CLASSIFIER_IMPL=anthropic,XERO_IMPL=real,P6_AGENT_A_ENABLED=true,P6_AGENT_B_ENABLED=true,P6_AGENT_C_ENABLED=true,P6_AGENT_C_STREAMING_ENABLED=false,MICROSOFT_OIDC_TENANT=common,DOCUSIGN_AUTH_BASE_URL=https://account.docusign.com,DOCUSIGN_API_BASE_URL=https://na4.docusign.net,INTEGRATIONS_SUCCESS_REDIRECT=https://app.cpa-platform.com/integrations,SESSION_COOKIE_NAME=cpa_session,SESSION_TTL_SECONDS=86400" \
  --set-secrets="\
DATABASE_URL=database-url:latest,\
DATABASE_URL_APP=database-url-app:latest,\
DATABASE_POOL_MAX=database-pool-max:latest,\
ANTHROPIC_API_KEY=anthropic-api-key:latest,\
VOYAGE_API_KEY=voyage-api-key:latest,\
SESSION_JWT_SECRET=session-jwt-secret:latest,\
TOKEN_ENCRYPTION_KEY=token-encryption-key:latest,\
GRAFANA_OTLP_ENDPOINT=grafana-otlp-endpoint:latest,\
GRAFANA_OTLP_USERNAME=grafana-otlp-username:latest,\
GRAFANA_OTLP_PASSWORD=grafana-otlp-password:latest,\
SENTRY_DSN_API=sentry-dsn-api:latest,\
MICROSOFT_OIDC_CLIENT_ID=microsoft-oidc-client-id:latest,\
MICROSOFT_OIDC_CLIENT_SECRET=microsoft-oidc-client-secret:latest,\
GOOGLE_OIDC_CLIENT_ID=google-oidc-client-id:latest,\
GOOGLE_OIDC_CLIENT_SECRET=google-oidc-client-secret:latest,\
DOCUSIGN_CLIENT_ID=docusign-client-id:latest,\
DOCUSIGN_CLIENT_SECRET=docusign-client-secret:latest,\
DOCUSIGN_WEBHOOK_HMAC_SECRET=docusign-webhook-hmac-secret:latest,\
XERO_ACCOUNTING_CLIENT_ID=xero-accounting-client-id:latest,\
XERO_ACCOUNTING_CLIENT_SECRET=xero-accounting-client-secret:latest,\
GITHUB_APP_ID=github-app-id:latest,\
GITHUB_APP_PRIVATE_KEY=github-app-private-key:latest,\
GITHUB_APP_INSTALLATION_ID=github-app-installation-id:latest,\
GITHUB_WEBHOOK_SECRET=github-webhook-secret:latest,\
STRIPE_API_KEY=stripe-api-key:latest,\
STRIPE_WEBHOOK_SECRET=stripe-webhook-secret:latest,\
STRIPE_PRICE_ID_ONBOARDING=stripe-price-id-onboarding:latest,\
STRIPE_PRICE_ID_PER_CLAIM=stripe-price-id-per-claim:latest,\
STRIPE_PRICE_ID_MOBILE=stripe-price-id-mobile:latest,\
STRIPE_PRICE_ID_SLA_BRONZE=stripe-price-id-sla-bronze:latest,\
STRIPE_PRICE_ID_SLA_SILVER=stripe-price-id-sla-silver:latest,\
STRIPE_PRICE_ID_SLA_GOLD=stripe-price-id-sla-gold:latest,\
RESEND_API_KEY=resend-api-key:latest" \
  --allow-unauthenticated \
  --quiet

echo ""

# ─── 3. Deploy cpa-web ───────────────────────────────────────────────────────
echo "--- Deploying cpa-web ---"
gcloud run deploy cpa-web \
  --project="${PROD_PROJECT}" \
  --region="${REGION}" \
  --image="${WEB_IMAGE}" \
  --platform=managed \
  --service-account="${RUNTIME_SA}" \
  --min-instances=0 \
  --max-instances=5 \
  --memory=1Gi \
  --cpu=1 \
  --port=5173 \
  --concurrency=80 \
  --timeout=60 \
  --set-env-vars="NODE_ENV=production" \
  --set-secrets="SENTRY_DSN_WEB=sentry-dsn-web:latest" \
  --allow-unauthenticated \
  --quiet

echo ""

# ─── 4. Print service URLs ───────────────────────────────────────────────────
echo "=== Deployment complete ==="
echo ""

API_URL=$(gcloud run services describe cpa-api \
  --project="${PROD_PROJECT}" \
  --region="${REGION}" \
  --format="value(status.url)")

WEB_URL=$(gcloud run services describe cpa-web \
  --project="${PROD_PROJECT}" \
  --region="${REGION}" \
  --format="value(status.url)")

echo "  cpa-api : ${API_URL}"
echo "  cpa-web : ${WEB_URL}"
echo ""
echo "Health checks:"
echo "  curl ${API_URL}/health"
echo "  curl ${WEB_URL}/"
