#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# CPA Platform — DNS + Managed TLS Bootstrap
#
# Idempotent script that:
#   1. Creates a Cloud DNS managed zone for the production domain
#   2. Creates Cloud Run domain mappings for cpa-web and cpa-api
#   3. Prints the DNS nameservers and resource records to configure at the
#      registrar
#
# Usage:
#   bash tools/gcp/dns-bootstrap.sh
#
# All variables can be overridden via environment:
#   PROD_PROJECT — defaults to cpa-platform-prod
#   REGION       — defaults to australia-southeast1
#   DOMAIN       — defaults to cpa-platform.com.au
#   ZONE_NAME    — defaults to cpa-platform-prod
#
# Prerequisites:
#   1. Domain registered at a registrar (manual step — cannot be automated)
#   2. GCP project exists and Cloud Run services are deployed:
#        bash tools/gcp/project-bootstrap.sh
#        bash tools/gcp/cloudrun-deploy.sh
#   3. Authenticated gcloud session:
#        gcloud auth login
#        gcloud auth application-default login
#   4. Required IAM roles on PROD_PROJECT:
#        roles/dns.admin
#        roles/run.admin
# =============================================================================

PROD_PROJECT="${PROD_PROJECT:-cpa-platform-prod}"
REGION="${REGION:-australia-southeast1}"
DOMAIN="${DOMAIN:-cpa-platform.com.au}"
ZONE_NAME="${ZONE_NAME:-cpa-platform-prod}"

WEB_SUBDOMAIN="app.${DOMAIN}"
API_SUBDOMAIN="api.${DOMAIN}"

# Tracks what this run actually changed vs. what was already in place
CREATED=()
SKIPPED=()

log()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
info() { log "INFO  $*"; }
ok()   { log "OK    $*"; }
skip() { log "SKIP  $*"; SKIPPED+=("$*"); }
done_created() { log "DONE  $*"; CREATED+=("$*"); }
warn() { log "WARN  $*"; }

echo "=== CPA Platform — DNS + Managed TLS Bootstrap ==="
echo "  Project    : ${PROD_PROJECT}"
echo "  Region     : ${REGION}"
echo "  Domain     : ${DOMAIN}"
echo "  Zone name  : ${ZONE_NAME}"
echo "  Web host   : ${WEB_SUBDOMAIN}"
echo "  API host   : ${API_SUBDOMAIN}"
echo ""

# -----------------------------------------------------------------------------
# 1. Create Cloud DNS managed zone (idempotent)
# -----------------------------------------------------------------------------
info "=== Step 1: Cloud DNS managed zone ==="

if gcloud dns managed-zones describe "${ZONE_NAME}" \
     --project="${PROD_PROJECT}" \
     --quiet 2>/dev/null; then
  skip "DNS zone '${ZONE_NAME}' already exists"
else
  info "Creating DNS managed zone '${ZONE_NAME}' for '${DOMAIN}'..."
  gcloud dns managed-zones create "${ZONE_NAME}" \
    --project="${PROD_PROJECT}" \
    --dns-name="${DOMAIN}." \
    --description="CPA Platform production DNS" \
    --visibility=public \
    --quiet
  done_created "DNS zone: ${ZONE_NAME}"
fi

echo ""

# -----------------------------------------------------------------------------
# 2. Print nameservers (operator must configure these at the registrar)
# -----------------------------------------------------------------------------
info "=== Step 2: Nameserver details ==="

NS_RECORDS=$(gcloud dns managed-zones describe "${ZONE_NAME}" \
  --project="${PROD_PROJECT}" \
  --format="value(nameServers)" \
  --quiet)

echo ""
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │  MANUAL STEP REQUIRED — Configure nameservers at registrar  │"
echo "  └─────────────────────────────────────────────────────────────┘"
echo ""
echo "  Log in to your domain registrar for '${DOMAIN}' and update the"
echo "  nameservers to the following Google Cloud DNS values:"
echo ""
echo "${NS_RECORDS}" | tr ';' '\n' | while read -r ns; do
  echo "    ${ns}"
done
echo ""
echo "  NOTE: Nameserver propagation can take up to 48 hours. You can"
echo "  monitor propagation at: https://dnschecker.org/#NS/${DOMAIN}"
echo ""
echo "  Alternatively, if you cannot delegate the full zone, add CNAME"
echo "  records at your registrar instead (see runbook: docs/runbooks/dns-tls.md)."
echo ""

# -----------------------------------------------------------------------------
# 3. Create Cloud Run domain mapping — cpa-web → app.<domain>
# -----------------------------------------------------------------------------
info "=== Step 3: Domain mapping — cpa-web (${WEB_SUBDOMAIN}) ==="

if gcloud run domain-mappings describe \
     --domain="${WEB_SUBDOMAIN}" \
     --region="${REGION}" \
     --project="${PROD_PROJECT}" \
     --quiet 2>/dev/null; then
  skip "Domain mapping for '${WEB_SUBDOMAIN}' already exists"
else
  info "Creating domain mapping: ${WEB_SUBDOMAIN} → cpa-web..."
  gcloud run domain-mappings create \
    --service=cpa-web \
    --domain="${WEB_SUBDOMAIN}" \
    --region="${REGION}" \
    --project="${PROD_PROJECT}" \
    --quiet
  done_created "Domain mapping: ${WEB_SUBDOMAIN} → cpa-web"
fi

echo ""

# -----------------------------------------------------------------------------
# 4. Create Cloud Run domain mapping — cpa-api → api.<domain>
# -----------------------------------------------------------------------------
info "=== Step 4: Domain mapping — cpa-api (${API_SUBDOMAIN}) ==="

if gcloud run domain-mappings describe \
     --domain="${API_SUBDOMAIN}" \
     --region="${REGION}" \
     --project="${PROD_PROJECT}" \
     --quiet 2>/dev/null; then
  skip "Domain mapping for '${API_SUBDOMAIN}' already exists"
else
  info "Creating domain mapping: ${API_SUBDOMAIN} → cpa-api..."
  gcloud run domain-mappings create \
    --service=cpa-api \
    --domain="${API_SUBDOMAIN}" \
    --region="${REGION}" \
    --project="${PROD_PROJECT}" \
    --quiet
  done_created "Domain mapping: ${API_SUBDOMAIN} → cpa-api"
fi

echo ""

# -----------------------------------------------------------------------------
# 5. Print DNS resource records from domain mappings
# -----------------------------------------------------------------------------
info "=== Step 5: DNS resource records from domain mappings ==="
echo ""
echo "  The following DNS records must be added to your DNS zone."
echo "  If you delegated the zone to Google Cloud DNS (Step 2 above),"
echo "  add them via 'gcloud dns record-sets create' or the GCP console."
echo "  If you are keeping your existing nameservers, add these records"
echo "  directly at your registrar."
echo ""

print_mapping_records() {
  local subdomain="$1"
  local service="$2"

  echo "  --- ${subdomain} (${service}) ---"
  if gcloud run domain-mappings describe \
       --domain="${subdomain}" \
       --region="${REGION}" \
       --project="${PROD_PROJECT}" \
       --format="yaml(status.resourceRecords)" \
       --quiet 2>/dev/null; then
    :
  else
    warn "Could not retrieve resource records for ${subdomain} — mapping may still be provisioning."
    echo "  Retry: gcloud run domain-mappings describe --domain=${subdomain} --region=${REGION} --project=${PROD_PROJECT}"
  fi
  echo ""
}

print_mapping_records "${WEB_SUBDOMAIN}" "cpa-web"
print_mapping_records "${API_SUBDOMAIN}" "cpa-api"

# -----------------------------------------------------------------------------
# 6. TLS provisioning note
# -----------------------------------------------------------------------------
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │  TLS certificate provisioning — PLEASE READ                     │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
echo "  Google Cloud Run provisions managed TLS certificates automatically"
echo "  once DNS propagation is complete and the domain mapping is verified."
echo ""
echo "  Expected timeline:"
echo "    - DNS propagation:      up to 48 hours"
echo "    - Certificate issue:    30 minutes – 24 hours after DNS resolves"
echo ""
echo "  Monitor certificate status:"
echo "    gcloud run domain-mappings describe \\"
echo "      --domain=${WEB_SUBDOMAIN} \\"
echo "      --region=${REGION} \\"
echo "      --project=${PROD_PROJECT}"
echo ""
echo "  Look for:"
echo "    status.conditions[type=CertificateProvisioned].status: True"
echo ""
echo "  For troubleshooting, see: docs/runbooks/dns-tls.md"
echo ""

# -----------------------------------------------------------------------------
# 7. Summary
# -----------------------------------------------------------------------------
echo "============================================================"
echo " CPA Platform DNS Bootstrap — Summary"
echo "============================================================"
echo " Project    : ${PROD_PROJECT}"
echo " Region     : ${REGION}"
echo " Domain     : ${DOMAIN}"
echo " DNS zone   : ${ZONE_NAME}"
echo " Web host   : ${WEB_SUBDOMAIN}"
echo " API host   : ${API_SUBDOMAIN}"
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
echo " Next steps:"
echo "   1. Configure nameservers at registrar (see Step 2 output above)"
echo "   2. Wait for DNS propagation (up to 48 hours)"
echo "   3. Monitor TLS provisioning (30 min – 24 h after DNS resolves)"
echo "   4. Verify: curl -v https://${WEB_SUBDOMAIN}/healthz"
echo "   5. Verify: curl -v https://${API_SUBDOMAIN}/health"
echo ""
echo " Verification commands:"
echo "   gcloud dns managed-zones describe ${ZONE_NAME} --project=${PROD_PROJECT}"
echo "   gcloud run domain-mappings describe --domain=${WEB_SUBDOMAIN} --region=${REGION} --project=${PROD_PROJECT}"
echo "   gcloud run domain-mappings describe --domain=${API_SUBDOMAIN} --region=${REGION} --project=${PROD_PROJECT}"
echo "============================================================"
