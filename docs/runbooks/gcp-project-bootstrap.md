# Runbook: GCP Project Bootstrap

**Scope:** Initial provisioning and ongoing maintenance of the `cpa-platform-prod` and `cpa-platform-stg` GCP projects.
**Scripts:** `tools/gcp/project-bootstrap.sh`, `tools/gcp/budget-alerts.sh`
**Author:** P9.0.1
**Last updated:** 2026-05-06

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [First-time setup](#first-time-setup)
3. [Re-running (idempotency)](#re-running-idempotency)
4. [Verification steps](#verification-steps)
5. [Budget alert verification](#budget-alert-verification)
6. [Troubleshooting](#troubleshooting)
7. [Service account key rotation](#service-account-key-rotation)

---

## Prerequisites

### Tools

- **gcloud CLI** — version 450+ recommended.
  ```bash
  gcloud version
  ```
  Install: https://cloud.google.com/sdk/docs/install

- **Authenticated gcloud session** with an account that has the following IAM roles on the GCP organisation (or folder):
  - `roles/resourcemanager.projectCreator`
  - `roles/billing.user` (to link billing to projects)
  - `roles/billing.admin` (to create budget alerts)

  Authenticate:
  ```bash
  gcloud auth login
  gcloud auth application-default login
  ```

- **Billing account ID** — visible in the GCP console under Billing → Account management, or via:
  ```bash
  gcloud billing accounts list
  ```
  Format: `ABCDEF-123456-GHIJKL`

### Required permissions summary

| Action | Required role |
|---|---|
| Create projects | `roles/resourcemanager.projectCreator` |
| Link billing | `roles/billing.user` |
| Enable APIs | `roles/serviceusage.serviceUsageAdmin` |
| Create service accounts + bind IAM | `roles/iam.serviceAccountAdmin` + `roles/resourcemanager.projectIamAdmin` |
| Create budget alerts | `roles/billing.admin` |

---

## First-time setup

### 1. Clone the repository and navigate to the scripts

```bash
cd /path/to/cpa-platform
```

### 2. Make scripts executable

```bash
chmod +x tools/gcp/project-bootstrap.sh
chmod +x tools/gcp/budget-alerts.sh
```

### 3. Set environment variables

```bash
export BILLING_ACCOUNT_ID="ABCDEF-123456-GHIJKL"   # required

# Optional overrides (defaults shown):
export PROD_PROJECT="cpa-platform-prod"
export STG_PROJECT="cpa-platform-stg"
```

### 4. Run the project bootstrap script

```bash
bash tools/gcp/project-bootstrap.sh
```

The script will:
- Create `cpa-platform-prod` and `cpa-platform-stg` projects (if they do not exist)
- Link the billing account to both projects
- Enable all required APIs on both projects
- Create the `cpa-deploy` service account in the prod project
- Grant the deployment service account its required IAM roles

Expected runtime: 3–8 minutes (API enablement is the slow step).

### 5. Create budget alerts

```bash
bash tools/gcp/budget-alerts.sh
```

This creates budget alerts at 50%, 90%, and 100% of $200 AUD/month for each project.

**Note:** The budget script is **not** idempotent for budget creation — re-running it will create duplicate budgets. See [Re-running](#re-running-idempotency) below.

---

## Re-running (idempotency)

### `project-bootstrap.sh` — safe to re-run

The bootstrap script checks for the existence of each resource before creating it:

- **Projects:** Uses `gcloud projects describe <id>` — if exit code is 0, skips creation.
- **Service account:** Uses `gcloud iam service-accounts list --filter=email:...` — if the SA email is returned, skips creation.
- **Billing links + API enables:** These operations are idempotent by nature (GCP ignores duplicate link/enable calls).
- **IAM bindings:** `add-iam-policy-binding` is idempotent — re-adding an existing binding is a no-op.

Re-run safely any time:

```bash
bash tools/gcp/project-bootstrap.sh
```

### `budget-alerts.sh` — check before re-running

Budget creation is **not** idempotent. Before re-running, list existing budgets:

```bash
gcloud billing budgets list --billing-account="${BILLING_ACCOUNT_ID}"
```

If budgets already exist, do not re-run the script — manage them via the GCP console instead:

```
https://console.cloud.google.com/billing/<BILLING_ACCOUNT_ID>/budgets
```

---

## Verification steps

After running the bootstrap, verify each resource is active.

### Projects

```bash
gcloud projects describe cpa-platform-prod
gcloud projects describe cpa-platform-stg
```

Expected output includes `lifecycleState: ACTIVE` for each.

### Billing

```bash
gcloud billing projects describe cpa-platform-prod
gcloud billing projects describe cpa-platform-stg
```

Expected: `billingEnabled: true` and `billingAccountName` matches your account.

### APIs enabled

```bash
gcloud services list --project=cpa-platform-prod --enabled \
  --filter="name:(run.googleapis.com OR sqladmin.googleapis.com OR secretmanager.googleapis.com OR compute.googleapis.com OR cloudbuild.googleapis.com OR monitoring.googleapis.com OR logging.googleapis.com OR dns.googleapis.com OR iam.googleapis.com)"
```

All nine APIs should appear in the output.

### Service account

```bash
gcloud iam service-accounts describe \
  cpa-deploy@cpa-platform-prod.iam.gserviceaccount.com \
  --project=cpa-platform-prod
```

Expected: account is listed with `displayName: CPA Platform Deployment SA`.

### IAM bindings

```bash
gcloud projects get-iam-policy cpa-platform-prod \
  --flatten="bindings[].members" \
  --filter="bindings.members:cpa-deploy@cpa-platform-prod.iam.gserviceaccount.com" \
  --format="table(bindings.role)"
```

Expected roles:
- `roles/cloudbuild.builds.builder`
- `roles/cloudsql.admin`
- `roles/run.admin`
- `roles/secretmanager.admin`
- `roles/storage.admin`

---

## Budget alert verification

### Via GCP Console

Navigate to:

```
https://console.cloud.google.com/billing/<BILLING_ACCOUNT_ID>/budgets
```

You should see two budgets:
- `CPA Platform Prod Monthly Budget` — $200 AUD, alerts at 50%/90%/100%
- `CPA Platform Stg Monthly Budget` — $200 AUD, alerts at 50%/90%/100%

### Via CLI

```bash
gcloud billing budgets list \
  --billing-account="${BILLING_ACCOUNT_ID}" \
  --format="table(displayName,amount.specifiedAmount.units,thresholdRules.thresholdPercent)"
```

Budget alert emails are sent to all billing account administrators. To add an email recipient, edit the budget in the console and add notification channels under "Manage notifications".

---

## Troubleshooting

### Error: billing account permission denied

```
ERROR: (gcloud.billing.projects.link) PERMISSION_DENIED: ...
```

**Cause:** The authenticated account lacks `roles/billing.user` on the billing account.

**Fix:** Ask a billing admin to grant the role:

```bash
gcloud billing accounts add-iam-policy-binding "${BILLING_ACCOUNT_ID}" \
  --member="user:your.email@example.com" \
  --role="roles/billing.user"
```

Then re-run the bootstrap script.

### Error: project ID already taken globally

```
ERROR: (gcloud.projects.create) Project IDs must be unique across all of Google Cloud.
```

**Cause:** GCP project IDs are globally unique. `cpa-platform-prod` or `cpa-platform-stg` may be registered to another organisation.

**Fix:** Override the project ID variables and choose alternative IDs:

```bash
export PROD_PROJECT="cpa-platform-prod-au"
export STG_PROJECT="cpa-platform-stg-au"
bash tools/gcp/project-bootstrap.sh
```

Update the corresponding `PROD_PROJECT` / `STG_PROJECT` references in all other scripts and CI configuration to match.

### Error: API not enabled after running script

```
ERROR: API [run.googleapis.com] not enabled on project
```

**Cause:** Occasionally an API enable call succeeds but propagation is delayed (up to 60 seconds).

**Fix:** Wait 60 seconds, then re-run:

```bash
gcloud services enable run.googleapis.com --project=cpa-platform-prod --quiet
```

### Error: `BILLING_ACCOUNT_ID must be set`

```
ERROR: BILLING_ACCOUNT_ID must be set
```

**Cause:** The required environment variable was not exported before running the script.

**Fix:**

```bash
export BILLING_ACCOUNT_ID="ABCDEF-123456-GHIJKL"
bash tools/gcp/project-bootstrap.sh
```

### Error: insufficient quota to create project

```
ERROR: Quota exceeded for quota group 'projects-per-account' ...
```

**Cause:** GCP limits the number of projects per billing account (default 25).

**Fix:** Request a quota increase via the GCP console at:

```
https://console.cloud.google.com/iam-admin/quotas
```

Filter for `Projects` and request an increase.

---

## Service account key rotation

The `cpa-deploy` service account is used by CI/CD pipelines. Keys should be rotated every 90 days (or immediately on suspected compromise).

### 1. Create a new key

```bash
gcloud iam service-accounts keys create /tmp/cpa-deploy-new.json \
  --iam-account=cpa-deploy@cpa-platform-prod.iam.gserviceaccount.com \
  --project=cpa-platform-prod
```

### 2. Update the secret in Secret Manager

```bash
gcloud secrets versions add cpa-deploy-sa-key \
  --data-file=/tmp/cpa-deploy-new.json \
  --project=cpa-platform-prod
```

### 3. Update CI secrets

- In GitHub Actions: go to **Settings → Secrets and variables → Actions** and update `GCP_SA_KEY` with the new JSON.
- In Cloud Build: the secret is pulled from Secret Manager automatically when the new version is set as `latest`.

### 4. Verify CI pipeline passes with new key

Trigger a test build and confirm successful deployment.

### 5. Delete the old key

List existing keys:

```bash
gcloud iam service-accounts keys list \
  --iam-account=cpa-deploy@cpa-platform-prod.iam.gserviceaccount.com \
  --project=cpa-platform-prod
```

Delete the old key (replace `KEY_ID` with the ID of the previous key):

```bash
gcloud iam service-accounts keys delete KEY_ID \
  --iam-account=cpa-deploy@cpa-platform-prod.iam.gserviceaccount.com \
  --project=cpa-platform-prod
```

### 6. Shred the local key file

```bash
shred -u /tmp/cpa-deploy-new.json
```

Never commit service account key JSON files to the repository.
