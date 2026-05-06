# Monitoring Runbook — Cloud Monitoring + Sentry Routing

**Phase:** P9.0.5
**Last reviewed:** 2026-05-07
**Owner:** Aaron (founder / primary on-call)

This runbook covers the operational setup, verification, and maintenance of:
- Cloud Monitoring alert policies (`tools/gcp/monitoring/`)
- Cloud Logging → Sentry routing (currently via env-var DSN injection)
- Grafana OTLP trace verification
- Sentry SDK activation (deferred to P9.1)

For alert response procedures, see `docs/monitoring/alert-runbook.md`.
For the full observability architecture, see `docs/monitoring/monitoring-architecture.md`.

---

## Applying Alert Policies

Alert policies live in `tools/gcp/monitoring/` as individual YAML files. The
setup script `tools/gcp/monitoring-setup.sh` applies all four policies and
creates the required notification channels.

### One-time setup

```bash
export PROD_PROJECT="cpa-platform-prod"
export PAGERDUTY_SERVICE_KEY="<key from PagerDuty → Service → Integrations → Cloud Monitoring>"
export ALERT_EMAIL="aaron@cpaplatform.com"

bash tools/gcp/monitoring-setup.sh
```

The script is idempotent — re-running it will skip already-created channels and
policies.

### What each policy does

| File | Alert | Threshold | Notification |
|---|---|---|---|
| `cloudrun-error-rate.yaml` | Cloud Run 5xx rate | >5%/min over 60s | PagerDuty (P1) |
| `cloudrun-p99-latency.yaml` | Cloud Run p99 latency | >2000ms over 5 min | PagerDuty (P2) |
| `cloudsql-cpu.yaml` | Cloud SQL CPU | >80% over 5 min | Email (P2) |
| `cloudrun-min-instances.yaml` | cpa-api instance count | drops below 1 | PagerDuty (P1) |

### Verifying policies in Cloud Console

After running the setup script:

1. Open Cloud Console → Monitoring → Alerting.
2. Confirm all four policies appear with status "No incidents".
3. Click each policy → check the notification channel is set correctly
   (PagerDuty or email, per the table above).

### Updating an existing policy

```bash
# List existing policies to find the policy name
gcloud alpha monitoring policies list \
  --project=cpa-platform-prod \
  --format="table(name, displayName)"

# Update a specific policy from its YAML file
# (first edit tools/gcp/monitoring/<policy>.yaml, then:)
gcloud alpha monitoring policies update <POLICY_NAME> \
  --project=cpa-platform-prod \
  --policy-from-file=tools/gcp/monitoring/<policy>.yaml
```

---

## Sentry DSN Injection (Current State — P9.0)

The Sentry DSNs are already injected as environment variables from Secret Manager
by `tools/gcp/cloudrun-deploy.sh`:

- `cpa-api` receives: `SENTRY_DSN_API` (secret: `sentry-dsn-api`)
- `cpa-web` receives: `SENTRY_DSN_WEB` (secret: `sentry-dsn-web`)

This means the DSNs are available at runtime in both services. The Sentry SDK
itself is not yet installed or initialized. See the P9.1 section below.

### Verify the secret values are populated

```bash
# Check that the secrets have non-empty values
gcloud secrets versions access latest \
  --secret=sentry-dsn-api \
  --project=cpa-platform-prod

gcloud secrets versions access latest \
  --secret=sentry-dsn-web \
  --project=cpa-platform-prod
```

If the secrets return empty strings, populate them:

```bash
echo -n "https://XXXX@oXXXX.ingest.sentry.io/YYYY" | \
  gcloud secrets versions add sentry-dsn-api \
    --data-file=- \
    --project=cpa-platform-prod
```

### Verify env vars are visible in Cloud Run

```bash
gcloud run services describe cpa-api \
  --region=australia-southeast1 \
  --project=cpa-platform-prod \
  --format="value(spec.template.spec.containers[0].env[].name)" \
  | grep SENTRY
```

Expected output: `SENTRY_DSN_API`

---

## Sentry SDK Activation (P9.1 — deferred)

The Sentry SDK (`@sentry/node`) is not yet installed in `cpa-api` or `cpa-web`.
A `TODO(P9.1)` comment marks the integration point in `apps/api/src/server.ts`.

### Why it is deferred

Next.js `instrumentation.ts` requires `@sentry/nextjs` to be installed first
(the Sentry wizard generates it). Installing the SDK is a separate task to avoid
bundling an untested dependency into P9.0.

### P9.1 activation steps (for the implementer)

**cpa-api:**

```bash
pnpm --filter @cpa/api add @sentry/node @sentry/opentelemetry
```

Then in `apps/api/src/server.ts`, replace the TODO comment block with:

```typescript
import * as Sentry from '@sentry/node';
import { buildApiSentryOptions } from '../../../tools/monitoring/sentry-config.js';
Sentry.init(buildApiSentryOptions());
```

The `buildApiSentryOptions()` function is already implemented in
`tools/monitoring/sentry-config.ts`. It reads `SENTRY_DSN_API` from the
environment (already injected by Cloud Run), applies PII scrubbing, and
sets sample rates appropriate for each environment.

**cpa-web:**

```bash
pnpm --filter @cpa/web add @sentry/nextjs
# Then run the Sentry wizard to generate instrumentation.ts:
pnpm dlx @sentry/wizard -i nextjs --dir apps/web
```

The wizard generates `apps/web/src/instrumentation.ts` and
`apps/web/sentry.client.config.ts`. Apply the options from
`tools/monitoring/sentry-config.ts#buildWebSentryOptions()`.

---

## Grafana OTLP Verification

The existing `packages/observability` OTLP setup sends traces from Cloud Run
to Grafana Tempo. Verify it is receiving traces after each deployment.

### Verify traces are flowing

1. Make a request to the production API:
   ```bash
   curl -s https://api.cpaplatform.com/health | jq
   ```

2. Open Grafana → Explore → set data source to Tempo.

3. Search for traces with service name `cpa-api`:
   ```
   { resource.service.name = "cpa-api" }
   ```

4. Confirm traces appear within 30 seconds of the request.

### Verify OTLP credentials in Cloud Run

```bash
gcloud run services describe cpa-api \
  --region=australia-southeast1 \
  --project=cpa-platform-prod \
  --format="value(spec.template.spec.containers[0].env[].name)" \
  | grep GRAFANA
```

Expected output includes: `GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_USERNAME`,
`GRAFANA_OTLP_PASSWORD`.

If any are missing, re-run `tools/gcp/cloudrun-deploy.sh` with the correct
`IMAGE_TAG`.

---

## Testing Alerts

After applying the policies, verify each alert fires correctly before relying
on it in production. Use Cloud Monitoring's "Test notification" feature or
trigger the condition deliberately in a staging environment.

### Test: PagerDuty notification channel

In Cloud Console → Monitoring → Notification channels → find the PagerDuty
channel → click "Send test notification". Verify a test incident appears in
PagerDuty and the escalation policy routes it correctly.

### Test: Cloud Run error rate alert

Use a staging/test endpoint to generate synthetic 500 errors:

```bash
# Generate 5xx responses against a staging revision (not production)
for i in $(seq 1 50); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://api-staging.cpaplatform.com/nonexistent-endpoint-for-testing"
done
```

Verify the alert fires within 2–3 minutes in Cloud Console → Alerting → Incidents.

### Test: Cloud SQL CPU alert

A CPU alert can be triggered deliberately by running a compute-heavy query in
the Supabase SQL editor. In production, this alert should be tested only in
staging.

### Test: cpa-api min-instances alert

This alert is hardest to test without impacting production. In staging, you can:

1. Temporarily update the staging service with `--min-instances=0`.
2. Wait for instances to scale to zero (may take several minutes of no traffic).
3. Verify the alert fires in Cloud Console.
4. Immediately restore `--min-instances=1` on the staging service.

---

## Cloud Logging → Sentry Routing

Cloud Logging captures all structured logs emitted by `@cpa/observability`'s
pino logger. Sentry routes are established at the SDK level (not Cloud Logging
level) — the `@sentry/node` SDK intercepts errors and ships them directly to
the Sentry ingest endpoint.

There is no Cloud Logging sink required for Sentry routing. The flow is:

```
Fastify error handler → @sentry/node captureException → Sentry ingest
Pino logger (structured JSON) → Cloud Logging → retained for 30 days
```

Cloud Logging retention is configured at the project level. The default for
Cloud Run logs is 30 days. For compliance with ISO 27001 A.8.15 (logging), this
is sufficient for application logs. Audit logs are retained separately in the
`audit_log` database table (7 years, append-only).

---

## Related Documents

- `tools/gcp/monitoring-setup.sh` — Setup script (run this to apply policies)
- `tools/gcp/monitoring/` — Individual policy YAML files
- `tools/monitoring/sentry-config.ts` — Sentry SDK options reference
- `docs/monitoring/monitoring-architecture.md` — Full observability architecture
- `docs/monitoring/alert-runbook.md` — Alert response procedures
- `docs/runbooks/on-call.md` — On-call procedures
- `apps/api/src/server.ts` — TODO(P9.1) Sentry init hook
- `packages/observability/src/tracer.ts` — Grafana OTLP tracer config
