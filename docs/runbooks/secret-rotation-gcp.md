# Secret Rotation — GCP Secret Manager

**Last updated:** 2026-05-07
**Owner:** Platform Engineering
**Related runbooks:** `backup-restore.md`, `on-call.md`

---

## Overview

This runbook covers secret rotation for the CPA Platform in production.
Secrets are stored in [GCP Secret Manager](https://cloud.google.com/secret-manager)
and injected into Cloud Run services at boot time via `--set-secrets`.

This extends the P8 secret management approach (local `.env` files for
development) to the production GCP deployment. In production there is no
`.env` file on disk — every secret comes from Secret Manager.

**Key properties of GCP Secret Manager in this project:**

- All secrets use `user-managed` replication pinned to `australia-southeast1`.
- Cloud Run services mount secrets as environment variables via `--set-secrets`.
- Secret versions are immutable; adding a new version does not delete the old one.
- Cloud Run reads the `latest` version at service start — a redeploy is required
  to pick up a new secret version (see §3 below).
- The `managed-by=bootstrap` label identifies secrets created by
  `tools/gcp/secrets-bootstrap.sh`.

---

## 1. Prerequisites

```bash
# Authenticate with sufficient permissions
gcloud auth login
gcloud config set project cpa-platform-prod

# Required roles on cpa-platform-prod:
#   roles/secretmanager.admin   — to add versions and describe secrets
#   roles/run.admin             — to redeploy services
```

---

## 2. Adding a new secret version

Use this procedure whenever a secret needs to be rotated (new value, key
compromise, scheduled rotation, etc.).

```bash
SECRET_NAME="session-jwt-secret"   # replace with target secret name

# Option A: pass value via stdin (recommended — avoids shell history)
gcloud secrets versions add "${SECRET_NAME}" \
  --project=cpa-platform-prod \
  --data-file=- <<< 'new-secret-value'

# Option B: pass from a file (useful for PEM keys or multi-line values)
gcloud secrets versions add "${SECRET_NAME}" \
  --project=cpa-platform-prod \
  --data-file=/path/to/secret.txt

# Verify the new version was added
gcloud secrets versions list "${SECRET_NAME}" \
  --project=cpa-platform-prod
```

Secret versions are numbered sequentially. Cloud Run services reference
`latest` — the highest enabled version.

---

## 3. Making Cloud Run pick up the new version

Cloud Run resolves `latest` at service startup, not at request time. After
adding a new secret version you must trigger a new revision.

### Option A: Redeploy (recommended for immediate rollout)

```bash
# Re-run the deployment script with the same image tag
IMAGE_TAG="$(git rev-parse --short HEAD)" \
  bash tools/gcp/cloudrun-deploy.sh

# Or update a single service (no image rebuild):
gcloud run services update cpa-api \
  --project=cpa-platform-prod \
  --region=australia-southeast1

gcloud run services update cpa-web \
  --project=cpa-platform-prod \
  --region=australia-southeast1
```

### Option B: Traffic split / staged rollout

```bash
# Deploy a new revision without sending traffic
gcloud run deploy cpa-api \
  --project=cpa-platform-prod \
  --region=australia-southeast1 \
  --image="gcr.io/cpa-platform-prod/cpa-api:${IMAGE_TAG}" \
  --no-traffic

# Get the new revision name
NEW_REVISION=$(gcloud run revisions list \
  --project=cpa-platform-prod \
  --region=australia-southeast1 \
  --service=cpa-api \
  --format="value(name)" \
  --limit=1)

# Shift 10 % of traffic to the new revision, then 100 % after validation
gcloud run services update-traffic cpa-api \
  --project=cpa-platform-prod \
  --region=australia-southeast1 \
  --to-revisions="${NEW_REVISION}=10"

# After validation:
gcloud run services update-traffic cpa-api \
  --project=cpa-platform-prod \
  --region=australia-southeast1 \
  --to-latest
```

---

## 4. Emergency rotation procedure (compromise scenario)

If a secret is believed to be compromised, follow this order to minimise the
window of exposure.

1. **Invalidate the secret at the source** (e.g. revoke the API key in the
   provider's dashboard, rotate the DB password, etc.) before updating Secret
   Manager — this stops any active abuse immediately.

2. **Generate the new value** locally:

   ```bash
   # JWT / symmetric key example
   openssl rand -base64 32

   # AES-256 hex key
   openssl rand -hex 32
   ```

3. **Add the new version** to Secret Manager:

   ```bash
   gcloud secrets versions add SESSION_JWT_SECRET \
     --project=cpa-platform-prod \
     --data-file=- <<< 'new-value'
   ```

4. **Disable the old version** to prevent accidental rollback:

   ```bash
   # List versions to get the old version number (e.g. "1")
   gcloud secrets versions list SESSION_JWT_SECRET \
     --project=cpa-platform-prod

   gcloud secrets versions disable SESSION_JWT_SECRET/1 \
     --project=cpa-platform-prod
   ```

5. **Redeploy all affected services** immediately:

   ```bash
   gcloud run services update cpa-api \
     --project=cpa-platform-prod \
     --region=australia-southeast1

   gcloud run services update cpa-web \
     --project=cpa-platform-prod \
     --region=australia-southeast1
   ```

6. **Verify** the new revision is serving healthy traffic:

   ```bash
   API_URL=$(gcloud run services describe cpa-api \
     --project=cpa-platform-prod \
     --region=australia-southeast1 \
     --format="value(status.url)")
   curl "${API_URL}/health"
   ```

7. **File a post-incident report** (see `docs/runbooks/first-incident.md`)
   within 24 hours. Record: discovery time, scope, remediation time.

---

## 5. Stripe key rotation

Stripe key rotation requires atomic coordination between the Stripe Dashboard
and Secret Manager to avoid dropped webhook events or failed API calls.

### Rotate `stripe-api-key` (live secret key)

1. Log in to [dashboard.stripe.com](https://dashboard.stripe.com) →
   Developers → API keys.
2. Click **Roll key** on the live secret key. Stripe immediately issues a new
   key; the old key remains valid for a configurable grace period (default 24h).
3. During the grace period, add the new key to Secret Manager:

   ```bash
   gcloud secrets versions add stripe-api-key \
     --project=cpa-platform-prod \
     --data-file=- <<< 'sk_live_new-key-here'
   ```

4. Redeploy the API service to pick up the new key:

   ```bash
   gcloud run services update cpa-api \
     --project=cpa-platform-prod \
     --region=australia-southeast1
   ```

5. Confirm the API is processing Stripe calls successfully (check Stripe
   Dashboard → Logs for 200 responses).
6. After confirming, let the grace period expire or manually revoke the old
   key in the Stripe Dashboard.

### Rotate `stripe-webhook-secret`

1. In Stripe Dashboard → Developers → Webhooks, select the endpoint.
2. Click **Roll secret**. Copy the new `whsec_...` value.
3. Add the new version to Secret Manager:

   ```bash
   gcloud secrets versions add stripe-webhook-secret \
     --project=cpa-platform-prod \
     --data-file=- <<< 'whsec_new-value'
   ```

4. Redeploy the API immediately — there is no grace period for webhook secrets.
   Any webhook delivered before the redeploy completes will fail HMAC
   validation and be retried by Stripe (Stripe retries for 3 days).

   ```bash
   gcloud run services update cpa-api \
     --project=cpa-platform-prod \
     --region=australia-southeast1
   ```

5. Verify the next webhook event in Stripe Dashboard → Events shows a 200
   response from the new endpoint.

---

## 6. GITHUB_APP_PRIVATE_KEY rotation

The GitHub App private key is a multi-line RSA PEM. Rotation requires creating
a new key in GitHub before removing the old one.

1. Go to [github.com/settings/apps](https://github.com/settings/apps) →
   select the CPA Platform GitHub App → **Private keys** → **Generate a
   private key**. Download the `.pem` file.

2. The app now has **two** active private keys (old + new). This means existing
   JWTs signed with the old key remain valid during the transition.

3. Upload the new PEM to Secret Manager:

   ```bash
   gcloud secrets versions add github-app-private-key \
     --project=cpa-platform-prod \
     --data-file=/path/to/new-private-key.pem
   ```

4. Redeploy the API:

   ```bash
   gcloud run services update cpa-api \
     --project=cpa-platform-prod \
     --region=australia-southeast1
   ```

5. Verify GitHub App functionality (check that the integration's webhook events
   are processed correctly — see `docs/runbooks/on-call.md`).

6. Once the new key is confirmed working, **delete the old key** in the GitHub
   App settings. This invalidates any JWTs signed with the old key, so only do
   this after the new revision is fully serving traffic.

7. Disable the old Secret Manager version:

   ```bash
   # Replace "1" with the actual version number of the old key
   gcloud secrets versions disable github-app-private-key/1 \
     --project=cpa-platform-prod
   ```

---

## 7. Listing all secrets and their current versions

```bash
# List all secrets with the managed-by=bootstrap label
gcloud secrets list \
  --project=cpa-platform-prod \
  --filter="labels.managed-by=bootstrap" \
  --format="table(name, createTime, replication.userManaged.replicas[0].location)"

# Check the latest version of a specific secret
gcloud secrets versions describe latest \
  --secret=session-jwt-secret \
  --project=cpa-platform-prod
```

---

## 8. Granting Cloud Run access to new secrets

If a new secret is added after the initial bootstrap, the Cloud Run service
account must have access before the `--set-secrets` flag will work.

```bash
SECRET_NAME="new-secret-name"
RUNTIME_SA="cpa-run@cpa-platform-prod.iam.gserviceaccount.com"

gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
  --project=cpa-platform-prod \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor"
```

This is handled automatically by `tools/gcp/project-bootstrap.sh` for secrets
that exist at bootstrap time, but must be done manually for secrets added later.
