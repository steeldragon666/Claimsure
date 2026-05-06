# Runbook: DNS + Managed TLS for Production Domains

**Scope:** Provisioning Cloud DNS, Cloud Run domain mappings, and managed TLS certificates for `cpa-platform.com.au`.
**Scripts:** `tools/gcp/dns-bootstrap.sh`
**Author:** P9.0.4
**Last updated:** 2026-05-07

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Running dns-bootstrap.sh](#running-dns-bootstrapsh)
3. [Manual step: configuring nameservers at the registrar](#manual-step-configuring-nameservers-at-the-registrar)
4. [Alternative: adding records without delegating the zone](#alternative-adding-records-without-delegating-the-zone)
5. [Verifying DNS propagation](#verifying-dns-propagation)
6. [Monitoring TLS certificate provisioning](#monitoring-tls-certificate-provisioning)
7. [Verifying cert validity](#verifying-cert-validity)
8. [TLS troubleshooting](#tls-troubleshooting)
9. [Rollback: removing domain mappings](#rollback-removing-domain-mappings)

---

## Prerequisites

### Manual pre-requisites (cannot be automated)

- **Domain registered at a registrar.** The domain `cpa-platform.com.au` must be registered and the registrar account must be accessible. `.com.au` domains require an Australian Business Number (ABN) or ACN for registration.
- **Domain ownership verified.** If Google Search Console or any other Google property requires domain verification, complete that before running the script (it can coexist with Cloud DNS delegation).

### GCP pre-requisites

The following must be completed before running `dns-bootstrap.sh`:

| Prerequisite | Script |
|---|---|
| GCP project `cpa-platform-prod` exists | `tools/gcp/project-bootstrap.sh` |
| Cloud Run services `cpa-web` and `cpa-api` are deployed | `tools/gcp/cloudrun-deploy.sh` |
| `dns.googleapis.com` API is enabled | Handled by `project-bootstrap.sh` |

Verify Cloud Run services are running:

```bash
gcloud run services list \
  --project=cpa-platform-prod \
  --region=australia-southeast1 \
  --format="table(name,status.url,status.conditions[0].status)"
```

Both `cpa-web` and `cpa-api` must appear with a `status.conditions` of `True`.

### Tools

- **gcloud CLI** — version 450+ recommended.
  ```bash
  gcloud version
  ```

- **Authenticated gcloud session** with the following IAM roles on `cpa-platform-prod`:
  - `roles/dns.admin` — to create and manage Cloud DNS zones
  - `roles/run.admin` — to create Cloud Run domain mappings

  Authenticate:
  ```bash
  gcloud auth login
  gcloud auth application-default login
  ```

---

## Running dns-bootstrap.sh

### 1. Make the script executable

```bash
chmod +x tools/gcp/dns-bootstrap.sh
```

### 2. Set optional environment overrides (if needed)

All variables have sensible defaults. Override only if the defaults do not match your environment:

```bash
# Optional — defaults shown:
export PROD_PROJECT="cpa-platform-prod"
export REGION="australia-southeast1"
export DOMAIN="cpa-platform.com.au"
export ZONE_NAME="cpa-platform-prod"
```

### 3. Run the script

```bash
bash tools/gcp/dns-bootstrap.sh
```

The script will:

1. **Create a Cloud DNS managed zone** (`cpa-platform-prod`) for `cpa-platform.com.au` — idempotent, skipped if it already exists.
2. **Print the nameservers** that must be configured at the registrar (see [step 3](#manual-step-configuring-nameservers-at-the-registrar) below).
3. **Create a Cloud Run domain mapping** `app.cpa-platform.com.au → cpa-web` — idempotent.
4. **Create a Cloud Run domain mapping** `api.cpa-platform.com.au → cpa-api` — idempotent.
5. **Print the DNS resource records** (CNAME or A/AAAA records) that must be added to the zone.
6. Print a summary of actions taken and next steps.

The script is safe to re-run at any point. It checks for existing resources before creating them and prints what was created vs. skipped.

Expected runtime: under 2 minutes (Cloud Run domain mappings are accepted immediately but provisioning is asynchronous).

---

## Manual step: configuring nameservers at the registrar

This step cannot be automated — it requires logging in to the domain registrar's control panel.

### What the script prints

After creating the DNS zone, the script prints four nameservers similar to:

```
ns-cloud-a1.googledomains.com.
ns-cloud-a2.googledomains.com.
ns-cloud-a3.googledomains.com.
ns-cloud-a4.googledomains.com.
```

You can retrieve them again at any time:

```bash
gcloud dns managed-zones describe cpa-platform-prod \
  --project=cpa-platform-prod \
  --format="value(nameServers)"
```

### Updating nameservers at the registrar

1. Log in to the registrar account for `cpa-platform.com.au`.
2. Navigate to **DNS / Nameservers** settings for the domain.
3. Replace the existing nameservers with the four Google Cloud DNS nameservers printed by the script.
4. Save the changes.

**Propagation time:** Nameserver changes for `.com.au` domains typically propagate within 2–24 hours. The theoretical maximum is 48 hours.

Monitor propagation:

```bash
# Check NS records from multiple global resolvers
dig NS cpa-platform.com.au @8.8.8.8
dig NS cpa-platform.com.au @1.1.1.1

# Or use a web-based propagation checker:
# https://dnschecker.org/#NS/cpa-platform.com.au
```

---

## Alternative: adding records without delegating the zone

If full zone delegation is not possible (e.g., the registrar manages other records on the domain), you can keep the existing nameservers and add individual DNS records at the registrar instead.

### Retrieve the resource records from domain mappings

```bash
# Web subdomain
gcloud run domain-mappings describe \
  --domain=app.cpa-platform.com.au \
  --region=australia-southeast1 \
  --project=cpa-platform-prod \
  --format="yaml(status.resourceRecords)"

# API subdomain
gcloud run domain-mappings describe \
  --domain=api.cpa-platform.com.au \
  --region=australia-southeast1 \
  --project=cpa-platform-prod \
  --format="yaml(status.resourceRecords)"
```

Each mapping returns records in one of two forms:

| Record type | Value format | When used |
|---|---|---|
| `CNAME` | `ghs.googlehosted.com.` | Subdomains only (use this if available) |
| `A` | One or more IPv4 addresses | When CNAME is not available |
| `AAAA` | One or more IPv6 addresses | Accompanies A records |

Add these records at your registrar exactly as shown. Use a TTL of 300 seconds (5 minutes) initially so that changes propagate quickly while you verify the configuration.

### If you are using the Google Cloud DNS zone (recommended)

Add the records to the managed zone:

```bash
# Example: CNAME record for the web subdomain
gcloud dns record-sets create app.cpa-platform.com.au. \
  --project=cpa-platform-prod \
  --zone=cpa-platform-prod \
  --type=CNAME \
  --ttl=300 \
  --rrdatas=ghs.googlehosted.com.

# Example: CNAME record for the API subdomain
gcloud dns record-sets create api.cpa-platform.com.au. \
  --project=cpa-platform-prod \
  --zone=cpa-platform-prod \
  --type=CNAME \
  --ttl=300 \
  --rrdatas=ghs.googlehosted.com.
```

Replace `CNAME` and `ghs.googlehosted.com.` with the actual type and value from the `domain-mappings describe` output above.

---

## Verifying DNS propagation

Once nameservers are configured (or records added at the registrar), verify that DNS resolves correctly before expecting TLS to provision.

```bash
# Verify the web subdomain resolves
dig app.cpa-platform.com.au A +short
dig app.cpa-platform.com.au CNAME +short

# Verify the API subdomain resolves
dig api.cpa-platform.com.au A +short
dig api.cpa-platform.com.au CNAME +short

# Confirm the records match what domain-mappings describe returned
gcloud run domain-mappings describe \
  --domain=app.cpa-platform.com.au \
  --region=australia-southeast1 \
  --project=cpa-platform-prod \
  --format="value(status.resourceRecords[0].rrdata)"
```

DNS is considered propagated when `dig` returns the expected value from at least two different resolvers (e.g., `8.8.8.8` and `1.1.1.1`).

---

## Monitoring TLS certificate provisioning

Cloud Run provisions managed TLS certificates automatically once the domain mapping is verified and DNS is resolving correctly. No manual certificate request is required.

### Check provisioning status

```bash
# Web subdomain
gcloud run domain-mappings describe \
  --domain=app.cpa-platform.com.au \
  --region=australia-southeast1 \
  --project=cpa-platform-prod \
  --format="yaml(status.conditions)"

# API subdomain
gcloud run domain-mappings describe \
  --domain=api.cpa-platform.com.au \
  --region=australia-southeast1 \
  --project=cpa-platform-prod \
  --format="yaml(status.conditions)"
```

### Status conditions to watch

| Condition type | Status value | Meaning |
|---|---|---|
| `Ready` | `True` | Mapping is fully provisioned, TLS active |
| `Ready` | `False` | Provisioning failed — check `message` field |
| `Ready` | `Unknown` | Still provisioning — wait and retry |
| `CertificateProvisioned` | `True` | TLS certificate issued and active |
| `CertificateProvisioned` | `False` | Certificate provisioning failed |
| `DomainMappingRegistered` | `True` | GCP has verified domain ownership |

### Expected timeline

| Stage | Typical duration |
|---|---|
| Nameserver propagation | 2–24 hours (up to 48 hours worst case) |
| GCP domain verification | 5–30 minutes after DNS resolves |
| TLS certificate issuance | 30 minutes – 24 hours after domain verified |
| Total end-to-end | 3 hours – 2 days |

### Poll until ready (optional)

```bash
# Poll every 5 minutes until CertificateProvisioned is True
watch -n 300 "gcloud run domain-mappings describe \
  --domain=app.cpa-platform.com.au \
  --region=australia-southeast1 \
  --project=cpa-platform-prod \
  --format='value(status.conditions)'"
```

---

## Verifying cert validity

Once TLS is provisioned, verify the certificate is valid and has sufficient expiry (60+ days is the target — Cloud Run auto-renews well in advance).

```bash
# Check TLS for the web endpoint
curl -v --silent https://app.cpa-platform.com.au/healthz 2>&1 | grep -E "subject:|issuer:|expire date:|SSL certificate"

# Check TLS for the API endpoint
curl -v --silent https://api.cpa-platform.com.au/health 2>&1 | grep -E "subject:|issuer:|expire date:|SSL certificate"
```

Expected output (abbreviated):

```
*  subject: CN=app.cpa-platform.com.au
*  start date: ...
*  expire date: <date at least 60 days from now>
*  issuer: C=US; O=Google Trust Services; CN=WE1
*  SSL certificate verify ok.
```

### Check cert expiry programmatically

```bash
echo | openssl s_client -connect app.cpa-platform.com.au:443 -servername app.cpa-platform.com.au 2>/dev/null \
  | openssl x509 -noout -dates -subject

echo | openssl s_client -connect api.cpa-platform.com.au:443 -servername api.cpa-platform.com.au 2>/dev/null \
  | openssl x509 -noout -dates -subject
```

The `notAfter` date must be at least 60 days from today. Cloud Run renews certificates automatically; if expiry drops below 30 days without renewal, open a GCP support ticket.

---

## TLS troubleshooting

### Certificate not provisioned after 24 hours

**Likely cause:** DNS is not resolving to the Cloud Run domain mapping target.

1. Confirm DNS is resolving:
   ```bash
   dig app.cpa-platform.com.au +short
   dig api.cpa-platform.com.au +short
   ```
   If these return no results or wrong results, the nameserver or record configuration is incorrect. Revisit [step 3](#manual-step-configuring-nameservers-at-the-registrar).

2. Check domain mapping conditions for error messages:
   ```bash
   gcloud run domain-mappings describe \
     --domain=app.cpa-platform.com.au \
     --region=australia-southeast1 \
     --project=cpa-platform-prod \
     --format="yaml(status.conditions)"
   ```
   The `message` field on a `False` condition contains the GCP error.

3. Confirm Cloud Run domain verification status. GCP must be able to reach the domain over HTTP during the verification step. If the domain is behind a firewall or returning non-2xx for the `/.well-known/acme-challenge/` path, verification will fail.

### `DomainMappingRegistered: False` — domain ownership not verified

Cloud Run uses a token-based verification. Ensure:
- The domain mapping was created (check: `gcloud run domain-mappings list --region=australia-southeast1 --project=cpa-platform-prod`)
- DNS is resolving and the service is reachable over HTTP (port 80)
- No CDN or proxy is stripping ACME challenge requests

### `CertificateProvisioned: False` — certificate issue failed

1. Delete and recreate the domain mapping (this resets the certificate request):
   ```bash
   gcloud run domain-mappings delete \
     --domain=app.cpa-platform.com.au \
     --region=australia-southeast1 \
     --project=cpa-platform-prod \
     --quiet

   gcloud run domain-mappings create \
     --service=cpa-web \
     --domain=app.cpa-platform.com.au \
     --region=australia-southeast1 \
     --project=cpa-platform-prod
   ```
2. Wait 30–60 minutes and re-check status.
3. If the failure persists after two attempts, file a GCP support ticket with the mapping name and project ID.

### `curl` returns SSL error after certificate shows `True`

- Allow 5–10 minutes after the condition flips to `True` for the certificate to propagate to all Cloud Run instances.
- Verify the correct domain is being tested (not the `*.run.app` URL).
- Clear local DNS cache: `sudo dscacheutil -flushcache` (macOS) or `sudo systemd-resolve --flush-caches` (Linux).

### Certificate expiry warning

Cloud Run auto-renews certificates at approximately 30 days before expiry. If a cert is within 30 days of expiry and has not renewed:
1. Check the domain mapping conditions for errors.
2. Confirm DNS is still resolving correctly (records may have been accidentally removed).
3. Contact GCP support if auto-renewal has not triggered within 7 days of the 30-day threshold.

---

## Rollback: removing domain mappings

To remove the Cloud Run domain mappings (e.g., to reconfigure or decommission):

```bash
# Remove web mapping
gcloud run domain-mappings delete \
  --domain=app.cpa-platform.com.au \
  --region=australia-southeast1 \
  --project=cpa-platform-prod \
  --quiet

# Remove API mapping
gcloud run domain-mappings delete \
  --domain=api.cpa-platform.com.au \
  --region=australia-southeast1 \
  --project=cpa-platform-prod \
  --quiet
```

To remove the Cloud DNS managed zone:

```bash
# Delete all non-SOA/NS records from the zone first (required before zone deletion)
gcloud dns record-sets list \
  --zone=cpa-platform-prod \
  --project=cpa-platform-prod

# Delete any additional records (e.g., CNAME records added manually)
gcloud dns record-sets delete app.cpa-platform.com.au. \
  --type=CNAME \
  --zone=cpa-platform-prod \
  --project=cpa-platform-prod

# Delete the zone
gcloud dns managed-zones delete cpa-platform-prod \
  --project=cpa-platform-prod \
  --quiet
```

**WARNING:** Deleting the DNS zone while the domain is live will cause a production outage. Only proceed if the domain is being decommissioned or migrated to a different zone or registrar-managed DNS.

After removing domain mappings, update nameservers at the registrar back to the registrar's default nameservers (or the new provider) to restore DNS resolution for the domain.
