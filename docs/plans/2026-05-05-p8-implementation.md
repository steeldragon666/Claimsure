# P8 Implementation Plan — Production Hardening + ISO 27001 Prep

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the platform to first paying tenant in ~6 weeks; produce an ISO 27001 stage-1-audit-ready posture by phase end (week 12).

**Architecture:** Two interleaved tracks. Track 1 (weeks 1-4) ships customer-launch hardening — the components without which production traffic is irresponsible. Track 2 (weeks 4-12) builds the ISMS framework + Annex A documentation in parallel with operating the platform, so day-to-day ops *generate* the audit evidence. Stage-1 audit happens after P8 ends.

**Tech Stack:** TypeScript (Fastify, Next.js), postgres-js, OTLP/Grafana (existing), Sentry (or equivalent — see T1.2 vendor decision), PagerDuty (or equivalent — see T1.2), pgBackRest or `pg_basebackup` + WAL archiving (T1.1), Vault or AWS Secrets Manager (T1.5), markdown for ISO artifacts in `docs/iso27001/`.

**Design reference:** `docs/plans/2026-05-05-p8-design.md`

**Worktree / branch:** `C:\Users\Aaron\cpa-platform-worktrees\p8` on `p8/design-and-plan` branched from `origin/main`. Note: P8 is large enough that individual tasks may want their own feature branches off `main` — see "Branch hygiene" below.

---

## Sequencing overview

```
Week 1                Week 2                Week 3                Week 4                Weeks 5-12
─────                 ─────                 ─────                 ─────                 ──────────
T1.1 backup+DR        T1.4 RLS audit        T1.6 pen-test         T1.8 onboarding       T2.* ISO 27001 prep
T1.2 monitoring       T1.5 secrets rotn     T1.7 email transac    polish                 (see Track 2 below)
                      (in parallel)         (3rd party kicks)     T1.9 runbooks
                                                                  GATE → first customer
                                                                  T1.3 RIF alerting can
                                                                  shift earlier if T1.2
                                                                  finishes ahead
```

Track 1 components are mostly parallelizable across weeks 1-4. Track 2 components have internal sequencing (T2.1 → T2.3 → T2.4 → others). Detailed dependencies in each task.

## Branch hygiene

P8 produces ~23 components and many separate PRs. Recommended workflow:

1. **Track 1 components**: each gets its own feature branch (`p8/t1.1-backup-dr`, etc.) and ships as one PR. Merging cadence ~2-3 PRs/week. Don't bundle Track 1 into one mega-PR — review burden too high.
2. **Track 2 components**: each ISO artifact ships as one PR with a single commit (the document). Bundling 2-3 small ISO doc PRs together is OK if they're related (e.g., T2.1 + T2.2 are both ISMS-foundation docs).
3. **Branch base**: each branch cuts off the latest `main` after the previous P8 PR merges. Rebase rather than merge if main moves under you.

The `p8/design-and-plan` branch holds *only* the design doc + this implementation plan. It opens its own PR for review of the plan itself.

---

# Track 1 — Customer-launch hardening (weeks 1-4)

## Task T1.1: DB backup + DR

**Effort:** ~3-4 days. **Branch:** `p8/t1.1-backup-dr`. **Type:** ops-config + tested drill.

**Vendor decision:** Self-hosted (`pgBackRest` + S3 / Azure Blob for WAL + base backups) vs managed (Supabase Pro / Neon / Crunchy Bridge backup feature). Self-hosted gives more control + lower cost; managed is faster to set up but couples you to the provider's restore semantics. **Recommendation**: pgBackRest if Postgres is self-hosted; managed feature if on a managed Postgres provider.

**Files:**
- Create: `tools/postgres/pgbackrest.conf` (or equivalent provider config)
- Create: `tools/postgres/restore-drill.sh` — automated restore script
- Create: `docs/runbooks/backup-restore.md` — runbook
- Create: `docs/runbooks/dr-targets.md` — RTO/RPO commitments

**Step 1: Decide RTO/RPO targets**

Document explicit numbers in `docs/runbooks/dr-targets.md`. Suggested starting point for first-customer-readiness:
- **RPO (Recovery Point Objective)**: ≤ 5 minutes data loss (continuous WAL archiving every 1 minute)
- **RTO (Recovery Time Objective)**: ≤ 1 hour from outage declared to traffic restored

**Step 2: Configure WAL archiving**

For pgBackRest:
```bash
# On the postgres host
sudo -u postgres pgbackrest stanza-create --stanza=cpa-prod
sudo -u postgres pgbackrest --stanza=cpa-prod backup --type=full
```

Cron entry (every 6 hours for incremental, daily for full):
```cron
0 */6 * * *  postgres  pgbackrest --stanza=cpa-prod --type=incr backup
0  3 * * *   postgres  pgbackrest --stanza=cpa-prod --type=full backup
```

**Step 3: Write `tools/postgres/restore-drill.sh`**

```bash
#!/usr/bin/env bash
# Performs a timed PITR restore to a fresh instance and verifies data
# integrity. Fails non-zero if restore exceeds RTO or hashes don't match.
set -euo pipefail

DRILL_TARGET=${1:-$(date -u -d '5 minutes ago' --iso-8601=seconds)}
WORK_DIR=$(mktemp -d)
START=$(date +%s)

echo "Restoring to $DRILL_TARGET in $WORK_DIR..."
pgbackrest --stanza=cpa-prod --target="$DRILL_TARGET" \
           --pg1-path="$WORK_DIR/pg" --type=time restore

# Bring up the restored cluster on a non-conflicting port
pg_ctl -D "$WORK_DIR/pg" -o "-p 5455" start
sleep 5

# Verify data integrity: count critical tables
TABLES=(tenant "user" subject_tenant event activity expenditure narrative_draft audit_log)
for t in "${TABLES[@]}"; do
  COUNT=$(psql -h localhost -p 5455 -U cpa -d cpa_dev -tAc "SELECT count(*) FROM \"$t\"")
  echo "  $t: $COUNT rows"
done

pg_ctl -D "$WORK_DIR/pg" stop -m fast
rm -rf "$WORK_DIR"

ELAPSED=$(($(date +%s) - START))
RTO_SECS=3600
if [ $ELAPSED -gt $RTO_SECS ]; then
  echo "FAIL: restore took ${ELAPSED}s (RTO is ${RTO_SECS}s)"
  exit 1
fi
echo "PASS: restore completed in ${ELAPSED}s"
```

**Step 4: Run the drill**

```bash
bash tools/postgres/restore-drill.sh
```

Expected: PASS with elapsed time, row counts for each critical table. If FAIL: investigate before proceeding to T1.2.

**Step 5: Document results in `docs/runbooks/backup-restore.md`**

Include: drill date, restore time, target timestamp, verification output. This becomes the first ISO A.5.29 evidence entry.

**Step 6: Schedule monthly drills via cron + Sentry-Cron monitoring**

Once T1.2 is in place, the drill cron job emits a heartbeat to Sentry-Cron. Missed drills page on-call.

**Step 7: Commit**

```bash
git add tools/postgres/pgbackrest.conf tools/postgres/restore-drill.sh \
        docs/runbooks/backup-restore.md docs/runbooks/dr-targets.md
git commit -m "feat(ops): pgBackRest backup + automated restore drill (T1.1, RTO 1h, RPO 5min)"
```

---

## Task T1.2: App monitoring + general alerting

**Effort:** ~4-5 days. **Branch:** `p8/t1.2-monitoring-alerting`. **Type:** ops-config + integration code.

**Vendor decisions:**
- **Error tracking**: Sentry (recommended; tight Fastify + Next.js integrations) vs Bugsnag vs Highlight. Cost ~$26/mo at small scale.
- **Metrics + uptime**: Grafana Cloud (existing OTLP target) + Synthetics; alternative: Datadog (heavier, more $). Existing OTLP→Grafana setup in `packages/observability/` already produces traces; we extend it with logs + alerts.
- **On-call routing**: PagerDuty (recommended; ~$21/user/mo) vs Opsgenie vs Better Stack.

**Files:**
- Modify: `apps/api/src/server.ts` — add Sentry init at app boot
- Modify: `apps/web/src/instrumentation.ts` (Next.js) — add Sentry init
- Create: `tools/observability/synthetic-checks.yaml` — Grafana synthetic monitoring config (uptime probes for `/healthz`, `/v1/auth/me`, `/v1/audit/...`)
- Create: `docs/runbooks/on-call.md`

**Step 1: Create Sentry projects + capture DSNs**

Two projects: `cpa-api` and `cpa-web`. Stash DSNs in env vars (`SENTRY_DSN_API`, `SENTRY_DSN_WEB`). Add to CI secrets if Sentry releases are configured.

**Step 2: Add Sentry to API**

```ts
// apps/api/src/server.ts (top of file, before app boots)
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN_API) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN_API,
    tracesSampleRate: 0.1, // 10% sample to keep cost predictable
    environment: process.env.NODE_ENV,
    beforeSend(event) {
      // PII scrubbing — Sentry's defaults already strip query strings,
      // but we add explicit redaction for known sensitive fields.
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      return event;
    },
  });
}
```

**Step 3: Add Sentry to Web**

Follow Next.js Sentry wizard (`pnpm dlx @sentry/wizard@latest -i nextjs`). Verify it instruments `app/` directory.

**Step 4: Wire OTLP traces to also surface in Sentry**

Existing OTLP setup in `packages/observability/src/index.ts` exports to Grafana. Add Sentry as a parallel exporter so traces correlate with errors. (Sentry's @opentelemetry adapter handles this.)

**Step 5: Configure Grafana synthetic uptime probes**

Three probes, 1-minute interval:
- `GET /healthz` (unauthenticated; checks DB connectivity)
- `GET /v1/auth/me` with a fixed test session JWT
- `GET /v1/audit/activity/<test-activity-id>/timeline` (touches a real query path)

All probes alert on >2 consecutive failures or >5s response time.

**Step 6: Configure PagerDuty service + escalation policy**

- Service: "CPA Platform Production"
- Escalation: Aaron (page) → Aaron (email after 15 min) → backup contact (after 30 min if applicable)
- Integrations: Sentry (criticals page; high emails), Grafana (uptime failures page), Sentry-Cron (missed cron heartbeats email)

**Step 7: Inject synthetic errors to verify routing**

```ts
// In a temp dev-only route or via a test
throw new Error('test:critical:should-page-on-call');
```

Verify: PagerDuty page fires within 60s; Sentry shows the error; Grafana correlates trace.

**Step 8: Document in `docs/runbooks/on-call.md`**

Cover: who's on-call, escalation chain, severity definitions, common error classes + first-response steps.

**Step 9: Commit**

```bash
git add apps/api/src/server.ts apps/web/src/instrumentation.ts \
        tools/observability/synthetic-checks.yaml \
        docs/runbooks/on-call.md
git commit -m "feat(ops): Sentry + PagerDuty + Grafana synthetics for prod alerting (T1.2)"
```

---

## Task T1.3: RIF alerting integration

**Effort:** ~2-3 days. **Branch:** `p8/t1.3-rif-alerting`. **Type:** code + integration. **Depends on:** T1.2 in place.

The RIF (Regulatory Intelligence Feed) lands in P7 Theme D, but its alerting layer was deferred to P8 (Q-D4 from P7 design). Routes RIF events through the same Sentry + PagerDuty channels as production errors, with severity-based fan-out.

**Files:**
- Create: `apps/api/src/routes/rif/alerter.ts` — emits to Sentry + PagerDuty
- Modify: `apps/api/src/jobs/regulatory-classify.ts` (created in P7 Theme D) — call alerter post-classification
- Test: `apps/api/src/routes/rif/alerter.test.ts`

**Step 1: Write failing test**

```ts
// apps/api/src/routes/rif/alerter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendRifAlert } from './alerter.js';

test('sendRifAlert: severity=high routes to page channel', async () => {
  const captured: { channel: string; payload: unknown }[] = [];
  await sendRifAlert(
    { severity: 'high', source: 'AAT', summary: 'Body by Michael decision', url: 'https://...' },
    {
      sendToPagerDuty: async (p) => captured.push({ channel: 'page', payload: p }),
      sendToSentry: async (p) => captured.push({ channel: 'sentry', payload: p }),
      sendToEmailDigest: async (p) => captured.push({ channel: 'email', payload: p }),
    },
  );
  assert.deepEqual(
    captured.map((c) => c.channel),
    ['page', 'sentry'],
    'high severity routes to page + sentry, not email-only',
  );
});

test('sendRifAlert: severity=medium routes to email + sentry', async () => {
  const captured: string[] = [];
  await sendRifAlert(
    { severity: 'medium', source: 'ATO', summary: 'TA 2026/3 published', url: 'https://...' },
    {
      sendToPagerDuty: async () => captured.push('page'),
      sendToSentry: async () => captured.push('sentry'),
      sendToEmailDigest: async () => captured.push('email'),
    },
  );
  assert.deepEqual(captured.sort(), ['email', 'sentry']);
});

test('sendRifAlert: severity=low routes to email digest only', async () => {
  const captured: string[] = [];
  await sendRifAlert(
    { severity: 'low', source: 'AusIndustry', summary: 'Updated guidance section 2.4', url: 'https://...' },
    {
      sendToPagerDuty: async () => captured.push('page'),
      sendToSentry: async () => captured.push('sentry'),
      sendToEmailDigest: async () => captured.push('email'),
    },
  );
  assert.deepEqual(captured, ['email']);
});
```

**Step 2: Run tests — expect fail (alerter doesn't exist)**

```bash
pnpm --filter @cpa/api test -- --test-name-pattern="sendRifAlert"
```

**Step 3: Implement `apps/api/src/routes/rif/alerter.ts`**

```ts
export type RifSeverity = 'high' | 'medium' | 'low';

export interface RifAlertInput {
  severity: RifSeverity;
  source: string;
  summary: string;
  url: string;
}

export interface RifAlertChannels {
  sendToPagerDuty: (payload: RifAlertInput) => Promise<void>;
  sendToSentry: (payload: RifAlertInput) => Promise<void>;
  sendToEmailDigest: (payload: RifAlertInput) => Promise<void>;
}

const ROUTING: Record<RifSeverity, (keyof RifAlertChannels)[]> = {
  high: ['sendToPagerDuty', 'sendToSentry'],
  medium: ['sendToSentry', 'sendToEmailDigest'],
  low: ['sendToEmailDigest'],
};

export async function sendRifAlert(
  input: RifAlertInput,
  channels: RifAlertChannels,
): Promise<void> {
  const dispatched = ROUTING[input.severity].map((fn) => channels[fn](input));
  await Promise.all(dispatched);
}
```

**Step 4: Wire into `regulatory-classify` job**

In `apps/api/src/jobs/regulatory-classify.ts` (after classification produces severity), call:
```ts
await sendRifAlert(classifiedEvent, {
  sendToPagerDuty: pagerDutyClient.dispatchEvent,
  sendToSentry: sentryClient.captureMessage,
  sendToEmailDigest: emailDigestQueue.enqueue,
});
```

**Step 5: Run tests + verify they pass**

```bash
pnpm --filter @cpa/api test -- --test-name-pattern="sendRifAlert"
```

**Step 6: Trigger end-to-end test event in staging**

Manually insert a high-severity test RIF event and verify PagerDuty page fires within 60s, Sentry message appears.

**Step 7: Commit**

```bash
git add apps/api/src/routes/rif/alerter.ts apps/api/src/routes/rif/alerter.test.ts \
        apps/api/src/jobs/regulatory-classify.ts
git commit -m "feat(rif): severity-based alert routing through Sentry + PagerDuty (T1.3)"
```

---

## Task T1.4: RLS coverage audit

**Effort:** ~3-4 days. **Branch:** `p8/t1.4-rls-audit`. **Type:** TDD code + audit doc.

The platform has 40+ tables across migrations 0001-0040ish. Some are RLS-enforced (most), some are intentionally not (`tenant`, `user`, `expenditure_line` per existing tests/docs). This task produces an automated test that asserts coverage and an audit doc.

**Files:**
- Create: `packages/db/src/schema/rls-coverage.test.ts` — automated test asserting every table is RLS-enforced OR explicitly listed as exempt
- Create: `docs/iso27001/access-control/rls-coverage.md` — audit doc with rationale per table

**Step 1: Write the failing test**

```ts
// packages/db/src/schema/rls-coverage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '@cpa/db/client';

// Tables intentionally not RLS-protected. ANY addition requires updating
// docs/iso27001/access-control/rls-coverage.md with rationale.
const RLS_EXEMPT_TABLES = new Set([
  'tenant',           // global; tenant_user is the RLS gate
  'user',             // global; ACL via tenant_user + subject_tenant_user
  'expenditure_line', // child of expenditure; RLS enforced on parent
  '__drizzle_migrations',
  // Add new tables here ONLY with rationale doc update
]);

test('RLS coverage: every non-exempt table has rowsecurity enabled', async () => {
  const tables = await sql<{ relname: string; relrowsecurity: boolean }[]>`
    SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
     ORDER BY c.relname
  `;

  const missing = tables.filter(
    (t) => !t.relrowsecurity && !RLS_EXEMPT_TABLES.has(t.relname),
  );

  assert.deepEqual(
    missing.map((t) => t.relname),
    [],
    `${missing.length} tables missing RLS without exempt-list entry: ${missing
      .map((t) => t.relname)
      .join(', ')}`,
  );
});

test('RLS coverage: every RLS-enabled table has at least one policy', async () => {
  const tables = await sql<{ relname: string; policy_count: number }[]>`
    SELECT c.relname, COUNT(p.polname)::int as policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relrowsecurity = true
     GROUP BY c.relname
     ORDER BY c.relname
  `;

  const noPolicy = tables.filter((t) => t.policy_count === 0);
  assert.deepEqual(
    noPolicy.map((t) => t.relname),
    [],
    `RLS enabled but no policies (default-deny accidental?): ${noPolicy
      .map((t) => t.relname)
      .join(', ')}`,
  );
});
```

**Step 2: Run test — expect pass OR specific failures**

```bash
pnpm --filter @cpa/db test -- --test-name-pattern="RLS coverage"
```

If PASS: skip Step 3. If FAIL: list of tables that need either RLS enabled or exempt-list entry.

**Step 3: For each failing table, decide**

Either:
- Add RLS + appropriate policy via a new migration (preferred for tenant-scoped tables)
- Add to `RLS_EXEMPT_TABLES` set + document rationale in `docs/iso27001/access-control/rls-coverage.md`

**Step 4: Re-run test — verify pass**

**Step 5: Write the audit doc**

`docs/iso27001/access-control/rls-coverage.md`:

```markdown
# RLS Coverage Audit (ISO 27001 A.5.18, A.8.3)

**Last reviewed:** YYYY-MM-DD
**Reviewer:** Aaron
**Audit period:** 2026-Q2 onwards (quarterly review cadence)

## Method

Automated test in `packages/db/src/schema/rls-coverage.test.ts` runs on
every CI build and asserts:
1. Every public-schema table has `rowsecurity=true` OR is in the exempt list
2. Every RLS-enabled table has at least one policy attached

## Exempt tables (intentional non-RLS)

| Table | Rationale | RLS-equivalent gate |
|-------|-----------|----------------------|
| `tenant` | Global identity; cross-tenant lookup needed by auth | `tenant_user` membership join |
| `user` | Global identity; user can be in multiple tenants | `tenant_user` + `subject_tenant_user` ACL |
| `expenditure_line` | Child rows; tenant_id lives on parent `expenditure` | Always JOIN through `expenditure` (RLS-enforced) |
| `__drizzle_migrations` | Migration metadata; admin-only | DBA access only |

## Findings (most recent audit)

[Document any tables flagged + remediation]
```

**Step 6: Commit**

```bash
git add packages/db/src/schema/rls-coverage.test.ts \
        docs/iso27001/access-control/rls-coverage.md
git commit -m "feat(db): automated RLS coverage audit + exemption rationale doc (T1.4)"
```

---

## Task T1.5: Secrets rotation procedure

**Effort:** ~2-3 days. **Branch:** `p8/t1.5-secrets-rotation`. **Type:** ops-config + tested rotation script.

**Vendor decision:** AWS Secrets Manager / Azure Key Vault / HashiCorp Vault / Doppler. **Recommendation**: Whichever cloud you're already on. Doppler is a good cloud-agnostic option (~$5/user/mo).

**Files:**
- Create: `tools/secrets/rotation-policy.md` — what rotates, when, how
- Create: `tools/secrets/rotate-jwt-secret.sh` — example rotation script for `SESSION_JWT_SECRET`
- Create: `docs/iso27001/cryptography/secrets-management.md` — A.8.24 evidence

**Step 1: Inventory all production secrets**

Identify each secret used in production:
- `SESSION_JWT_SECRET` — JWT signing key
- `TOKEN_ENCRYPTION_KEY` — AES-256 for OAuth token encryption (B3 from P3)
- `DOCUSIGN_WEBHOOK_HMAC_SECRET` — webhook signature verification
- `XERO_ACCOUNTING_CLIENT_ID` / `_CLIENT_SECRET` — OAuth client creds
- GitHub App private key PEM (added in P7 Theme B)
- Anthropic API key
- Database connection strings (`DATABASE_URL`, `DATABASE_URL_APP`)
- Sentry DSNs (lower-sensitivity)
- PagerDuty integration keys

**Step 2: Define rotation policy per secret class**

In `tools/secrets/rotation-policy.md`:

| Secret class | Rotation cadence | Procedure |
|--------------|-----------------|-----------|
| Symmetric keys (JWT, encryption) | 90 days | Rolling rotation: emit both keys, accept old, sign with new for 24h, retire old |
| OAuth client secrets (Xero, GitHub) | 12 months OR on suspected leak | Provider-specific re-issue + redeploy |
| Database passwords | 12 months | Rolling password update via `pg_password_for_role` |
| API keys (Anthropic) | 12 months OR on suspected leak | Re-issue from provider; deploy |
| Webhook HMACs | 12 months | Coordinate with provider; dual-validate during transition |

**Step 3: Implement rolling rotation for `SESSION_JWT_SECRET`**

JWT verification needs to accept BOTH old and new key during transition. Modify `packages/auth/src/jwt.ts` to read `SESSION_JWT_SECRET` AND `SESSION_JWT_SECRET_PREVIOUS` (optional). On rotation:
1. Set `SESSION_JWT_SECRET_PREVIOUS = SESSION_JWT_SECRET` (old)
2. Set `SESSION_JWT_SECRET = <new>` (sign new tokens with this)
3. Wait 24h (max session lifetime)
4. Unset `SESSION_JWT_SECRET_PREVIOUS`

Write `tools/secrets/rotate-jwt-secret.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

NEW_SECRET=$(openssl rand -hex 32)
echo "Rolling SESSION_JWT_SECRET..."

# Provider-specific. Example for AWS Secrets Manager:
OLD_SECRET=$(aws secretsmanager get-secret-value --secret-id cpa/session-jwt --query SecretString --output text)
aws secretsmanager update-secret --secret-id cpa/session-jwt-previous --secret-string "$OLD_SECRET"
aws secretsmanager update-secret --secret-id cpa/session-jwt --secret-string "$NEW_SECRET"

# Trigger app restart to pick up new env vars (deployment-specific)
echo "Old → previous, new → current. Wait 24h then run cleanup-jwt-previous.sh"
```

**Step 4: Test rotation in staging**

Run `rotate-jwt-secret.sh` against staging. Generate a session token, wait, run rotation, verify the existing session still works (within the 24h window) AND new logins use the new key.

**Step 5: Document procedure + write A.8.24 evidence file**

`docs/iso27001/cryptography/secrets-management.md`:
- List every secret + class
- Rotation cadence + last-rotated date per secret
- Procedure links
- Evidence of last rotation drill (link to staging run)

**Step 6: Commit**

```bash
git add tools/secrets/rotation-policy.md tools/secrets/rotate-jwt-secret.sh \
        packages/auth/src/jwt.ts \
        docs/iso27001/cryptography/secrets-management.md
git commit -m "feat(ops): secrets rotation policy + rolling JWT rotation tested in staging (T1.5)"
```

---

## Task T1.6: Pen-test (scoped + executed)

**Effort:** ~5-7 days wall-clock (3rd party for ~half). **Branch:** `p8/t1.6-pentest-fixes`. **Type:** external engagement + finding fixes.

**Vendor decision:** Cobalt.io (modern PtaaS, ~$8-15k for first engagement) vs Bishop Fox / NCC Group (traditional firms, $20-40k+) vs HackerOne (bug-bounty model, no fixed cost). **Recommendation**: Cobalt.io for first-engagement; switch to traditional firm before SOC 2/ISO Type II audit.

**Files:**
- Create: `docs/iso27001/security-testing/pentest-2026-q2.md` — engagement summary + findings register
- Create: `docs/iso27001/security-testing/findings-register.md` — running list

**Step 1: Define scope (Rules of Engagement)**

In-scope:
- API auth flows (`/v1/auth/*`)
- Public endpoints (`/healthz`, anonymous routes)
- RLS bypass attempts (authenticated tester from tenant A trying to access tenant B data)
- OAuth callback flows (Xero, future Google/Microsoft)
- Webhook receivers (DocuSign, GitHub)
- Session/JWT handling

Out-of-scope:
- Third-party services (Anthropic, GitHub Actions infra)
- DDoS testing
- Social engineering
- Physical access

**Step 2: Engage vendor + sign agreement**

Block out 7-10 calendar days for vendor work. Ensure tester gets:
- Staging environment URL
- Test accounts (one per tenant role: admin, consultant, viewer)
- API documentation
- Architecture diagram
- A point-of-contact for clarifications

**Step 3: Receive interim + final reports**

Vendor typically provides interim findings as they go (so you can start fixing immediately) and a final report at engagement close.

**Step 4: Triage findings**

For each finding: severity (Critical/High/Medium/Low), affected component, recommendation. Categorize:
- Critical/High: must fix before customer launch (gate-blocking)
- Medium: fix within 30 days post-launch
- Low: log + roadmap; fix within 90 days OR document as accepted risk

**Step 5: Implement fixes**

Each fix gets its own commit on this branch. TDD where applicable: write a test that reproduces the finding, fix, verify test passes. For configuration fixes: document the change + verify in staging.

**Step 6: Request retest**

Vendor retests fixed items. Critical/High must come back zero before customer launch.

**Step 7: Document in `docs/iso27001/security-testing/pentest-2026-q2.md`**

```markdown
# Pen-test Q2 2026

**Vendor:** [Cobalt / Bishop Fox / etc.]
**Engagement period:** YYYY-MM-DD to YYYY-MM-DD
**Scope:** [Copied from RoE]
**Final report:** [Link to vendor portal or attached PDF]

## Summary

| Severity | Count (initial) | Count (after fixes) |
|----------|----------------|---------------------|
| Critical | N | 0 |
| High     | N | 0 |
| Medium   | N | <≤15 acceptable> |
| Low      | N | <documented in findings-register> |

## Findings (initial → final state)

### F-001 [Critical] [Name of finding]
- **Discovery:** [Tester description]
- **Fix:** [Commit hash / PR]
- **Retest:** PASS

[etc.]

## ISO Annex A.8.29 (Independent technical security testing) evidence
- This document + final vendor report serve as evidence of A.8.29 compliance
- Annual cadence: next pen-test scheduled for YYYY-MM-DD
```

**Step 8: Commit**

```bash
git add docs/iso27001/security-testing/pentest-2026-q2.md \
        docs/iso27001/security-testing/findings-register.md \
        [any code/config fixes]
git commit -m "feat(security): pen-test findings remediated; A.8.29 evidence captured (T1.6)"
```

---

## Task T1.7: Email transactional flows

**Effort:** ~2-3 days. **Branch:** `p8/t1.7-email-templates`. **Type:** code + config + content.

**Vendor decision:** Resend (recommended; ~$20/mo, modern API, strong deliverability) vs Postmark vs SendGrid vs SES. Resend integrates well with React Email for templating.

**Files:**
- Create: `packages/email/src/templates/signup-confirm.tsx` (or .html/.txt)
- Create: `packages/email/src/templates/password-reset.tsx`
- Create: `packages/email/src/templates/audit-complete.tsx`
- Create: `packages/email/src/templates/weekly-digest.tsx`
- Create: `packages/email/src/sender.ts`
- Test: `packages/email/src/sender.test.ts`

**Step 1: Set up Resend account + sender domain**

- Create Resend account
- Add sending domain (e.g., `mail.cpaplatform.com` or your apex)
- Set up DKIM, SPF, DMARC records — all three pass via Resend's verifier
- Capture API key as `RESEND_API_KEY`

**Step 2: Write 4 email templates**

Use plain HTML (or React Email if adopted). Each template needs:
- Plain-text fallback
- Mobile-responsive (no >600px wide)
- Brand-consistent header/footer
- Unsubscribe link (transactional emails are exempt from CAN-SPAM/CASL but still good practice)

**Step 3: Write `sender.ts`**

```ts
// packages/email/src/sender.ts
import { Resend } from 'resend';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export class EmailSender {
  private client: Resend;
  private fromAddress: string;

  constructor(apiKey: string, fromAddress: string) {
    this.client = new Resend(apiKey);
    this.fromAddress = fromAddress;
  }

  async send(input: SendEmailInput): Promise<{ id: string }> {
    const result = await this.client.emails.send({
      from: this.fromAddress,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo,
    });
    if (result.error) throw new Error(`email send failed: ${result.error.message}`);
    return { id: result.data!.id };
  }
}
```

**Step 4: Test deliverability across providers**

Send each template to test mailboxes on:
- Gmail
- Outlook.com
- Apple Mail (iCloud)
- A custom domain (your work domain)

For each: verify (a) delivered to inbox not spam, (b) renders correctly, (c) unsubscribe link works (or shows "transactional" note).

**Step 5: Write `sender.test.ts`** (mocks the Resend client)

Verify: subject/from/to populated correctly, HTML + text both included, errors propagate.

**Step 6: Wire into existing flows**

- Signup: call `sender.send` from the signup endpoint
- Password reset: from the password-reset endpoint
- Audit complete: from a worker job (after multi-cycle audit run finishes)
- Weekly digest: from a cron job

**Step 7: Commit**

```bash
git add packages/email/src/templates/ packages/email/src/sender.ts \
        packages/email/src/sender.test.ts \
        [route + job changes]
git commit -m "feat(email): transactional templates + Resend integration (signup/reset/audit/digest) (T1.7)"
```

---

## Task T1.8: Onboarding polish (high-touch first customer)

**Effort:** ~2-3 days. **Branch:** `p8/t1.8-onboarding`. **Type:** code + UX polish.

For first paying tenant, white-glove onboarding is acceptable. The goal is a *signup form that works*, not a self-service wizard. Bigger onboarding work lands in P9.

**Files:**
- Modify: `apps/web/src/app/signup/page.tsx`
- Modify: `apps/api/src/routes/tenants.ts` (or signup-related route)
- Test: `apps/api/src/routes/signup.test.ts`

**Step 1: Define the minimum viable onboarding flow**

```
[Customer fills signup form]
      ↓
[POST /v1/auth/signup creates: tenant + admin user + email verification token]
      ↓
[Email sent (T1.7)]
      ↓
[Customer clicks verification link → password setup]
      ↓
[Customer logs in → admin role + empty claimant queue]
      ↓
[Manual: you create their first claimant via admin tool, or they invite consultants]
```

**Step 2: Build the signup form**

Fields: firm name, slug, admin email, admin name, primary IDP (Microsoft / Google initially), accept terms checkbox, recaptcha (or h-captcha — privacy-friendlier).

Validation: server-side via Zod schemas (consistent with rest of platform).

**Step 3: Implement signup endpoint**

```ts
// apps/api/src/routes/auth.ts (signup branch)
app.post('/v1/auth/signup', async (req, reply) => {
  const input = signupInputSchema.parse(req.body);
  // Create tenant + admin user + verification token in one transaction
  const result = await sql.begin(async (tx) => {
    const tenant = await createTenant(tx, input);
    const user = await createAdminUser(tx, tenant.id, input);
    const token = await createVerificationToken(tx, user.id);
    return { tenant, user, token };
  });
  await emailSender.send({
    to: result.user.email,
    subject: 'Verify your email to activate your CPA Platform account',
    html: signupConfirmTemplate({ verificationUrl: `${BASE}/verify?token=${result.token.token}` }),
    text: signupConfirmTextTemplate(...),
  });
  return reply.code(201).send({ tenantId: result.tenant.id });
});
```

**Step 4: Write tests for the endpoint**

Cover: happy path, duplicate slug 409, invalid IDP 400, recaptcha rejected 403, email service failure → tx rolled back.

**Step 5: Verify e2e in staging**

Real signup → real email → click link → set password → log in. Works without your intervention.

**Step 6: Commit**

```bash
git add apps/web/src/app/signup/ apps/api/src/routes/auth.ts \
        apps/api/src/routes/signup.test.ts \
        packages/schemas/src/signup-input.ts
git commit -m "feat(web,api): minimum viable signup flow + email verification (T1.8)"
```

---

## Task T1.9: Runbooks

**Effort:** ~1-2 days; ongoing. **Branch:** `p8/t1.9-runbooks` (or rolling commits to docs branch). **Type:** documentation.

**Files:**
- Update/create: `docs/runbooks/on-call.md` (started in T1.2)
- Create: `docs/runbooks/first-incident.md`
- Update: `docs/runbooks/backup-restore.md` (created in T1.1)
- Create: `docs/runbooks/pentest-finding-response.md`
- Create: `docs/runbooks/INDEX.md` — catalog of all runbooks

**Step 1: Outline each runbook**

Standard structure:
- **Trigger** — when this runbook applies
- **Severity** — what's at stake
- **First response** — first 5 minutes of action
- **Escalation** — when to call backup
- **Resolution** — what "done" looks like
- **Post-incident** — log entry + ISO evidence (T2.13 incident-mgmt template)

**Step 2: Draft `first-incident.md`** — generic first-time-paging-yourself runbook

Cover: how to acknowledge a page, where to find dashboards, where to find logs, how to communicate with affected customer, when to escalate, post-incident steps.

**Step 3: Tabletop exercise per runbook**

Walk through each scenario in dry-run: simulate the alert, follow the runbook, time it, note friction points. Update runbook with learnings.

**Step 4: Commit**

```bash
git add docs/runbooks/
git commit -m "docs(runbooks): on-call + first-incident + backup-restore + pentest-response (T1.9)"
```

---

## 🚪 Customer-launch gate (end of week 4)

Before onboarding the first paying tenant, run this checklist. **All must be green.** Any red blocks customer launch.

| Item | Verification | Pass |
|------|--------------|------|
| T1.1 Backup + DR | Most recent restore drill within 7 days, completed within RTO | ☐ |
| T1.2 Monitoring | Synthetic error injection routes correctly to Sentry + page | ☐ |
| T1.3 RIF alerting | Test high-severity event pages within 60s | ☐ |
| T1.4 RLS audit | `pnpm --filter @cpa/db test -- --test-name-pattern="RLS coverage"` PASS | ☐ |
| T1.5 Secrets rotation | At least one staged rotation drill completed | ☐ |
| T1.6 Pen-test | Zero unfixed criticals; zero unfixed highs OR documented compensating control | ☐ |
| T1.7 Email | Each template delivers to Gmail + Outlook + Apple Mail with no spam-folder hits | ☐ |
| T1.8 Onboarding | Test signup → verification → first login completes without intervention | ☐ |
| T1.9 Runbooks | First-incident + on-call runbooks complete + tabletop-tested | ☐ |

**If any item is RED**: address before launch. Communicate any slippage to customer immediately.

**If all GREEN**: schedule customer kickoff call. Begin Track 2.

---

# Track 2 — ISO 27001:2022 prep (weeks 4-12)

All Track 2 outputs are markdown files committed to `docs/iso27001/`. Each task lists the ISO clause/control reference and a structure template.

**Sequencing within Track 2:**
- T2.1 (scope) → T2.2 (policy) → T2.3 (risk assessment) → T2.4 (SoA) — these are foundational ISMS docs in this order.
- T2.7-T2.14 (Annex A controls) can run mostly in parallel after T2.1-T2.4 land.
- T2.5 (internal audit) and T2.6 (mgmt review) happen last (week 11-12).

## Task T2.1: Scope statement + ISMS context

**Effort:** ~1-2 days. **Branch:** `p8/t2.1-isms-scope`. **ISO ref:** Chapter 4. **Type:** documentation.

**Files:**
- Create: `docs/iso27001/00-isms-scope.md`

**Step 1: Define ISMS scope**

In-scope:
- The CPA Platform application + supporting infrastructure (web, API, database, observability stack)
- Data: customer claimant data, narrative drafts, audit chains, RIF events
- People: founder, contractors, fractional CISO
- Suppliers in critical path: Anthropic, GitHub, hosting provider, email provider, monitoring providers

Out-of-scope (justified):
- Personal/marketing websites, internal-only tooling not touching customer data
- Customers' own infrastructure
- Third-party partner platforms

**Step 2: Identify interested parties**

Required by ISO Ch 4.2:
- Customers (CFO firms, claimants)
- Regulators (AusIndustry, ATO)
- Investors / partners (if applicable)
- Suppliers (Anthropic, GitHub, etc.)
- Employees / contractors (if applicable)

Document each party's relevant requirements/expectations.

**Step 3: Write `00-isms-scope.md`**

Sections: Purpose, Scope statement, Boundaries, Interested parties, Exclusions with justification, Document control (last reviewed, next review).

**Step 4: Commit**

```bash
git add docs/iso27001/00-isms-scope.md
git commit -m "docs(iso27001): ISMS scope statement + interested parties (T2.1, Ch 4)"
```

---

## Task T2.2: Information Security Policy + roles

**Effort:** ~1-2 days. **Branch:** `p8/t2.2-isms-policy`. **ISO ref:** Chapter 5. **Type:** documentation.

**Files:**
- Create: `docs/iso27001/01-information-security-policy.md`
- Create: `docs/iso27001/02-roles-and-responsibilities.md`

**Step 1: Draft top-level Information Security Policy**

Required sections (ISO 5.2):
- Purpose
- Commitment to information security (signed by top management — Aaron, as founder)
- Objectives (e.g., maintain customer data confidentiality, ensure availability ≥99.5%, etc.)
- Reference to subsidiary policies (cryptography, access control, etc. — these exist as separate docs)
- Review cadence (annual minimum)

**Step 2: Define roles + responsibilities**

For solo+AI build:
- **Founder (Aaron)**: Top management, ISMS owner, risk owner for most categories, primary on-call
- **Fractional CISO** (engaged for internal audit): Independent reviewer, advisor
- **Contractors/Claude Code/AI Agents**: Performers under instruction; no autonomous decision authority over security-critical changes

**Step 3: Commit**

```bash
git add docs/iso27001/01-information-security-policy.md \
        docs/iso27001/02-roles-and-responsibilities.md
git commit -m "docs(iso27001): InfoSec policy + roles & responsibilities (T2.2, Ch 5)"
```

---

## Task T2.3: Risk assessment + treatment plan

**Effort:** ~3-5 days. **Branch:** `p8/t2.3-risk-assessment`. **ISO ref:** Chapter 6.1. **Type:** documentation + analysis.

**Files:**
- Create: `docs/iso27001/03-risk-assessment-methodology.md`
- Create: `docs/iso27001/04-risk-register.md`
- Create: `docs/iso27001/05-risk-treatment-plan.md`

**Step 1: Define risk-assessment methodology**

Pick one (recommendation: simple qualitative):
- **Qualitative 5×5 matrix**: likelihood (Rare/Unlikely/Possible/Likely/Almost Certain) × impact (Negligible/Minor/Moderate/Major/Catastrophic) → risk rating
- **Quantitative**: $ exposure (more rigorous, more work)

Document methodology, scales, acceptance thresholds (e.g., "Low risks accepted; Medium require treatment; High/Catastrophic require immediate treatment").

**Step 2: Identify assets** (overlaps with T2.7)

For each asset, identify:
- Threats (what could go wrong)
- Vulnerabilities (what makes it possible)
- Existing controls (what we have)
- Residual risk (likelihood × impact after controls)

Use the assets identified in T2.7 (asset inventory). Cover at minimum:
- Customer data in DB
- Credentials in secrets manager
- Source code in GitHub
- Operational dashboards (Sentry, Grafana)
- Email infrastructure
- Backup data

**Step 3: Build risk register**

Table format. Each row: risk ID, asset, threat, vulnerability, likelihood, impact, rating, owner, treatment plan.

**Step 4: Build risk treatment plan**

For each risk above the acceptance threshold, choose:
- **Mitigate** (add/improve control) → who, when
- **Accept** → with documented rationale
- **Transfer** (insurance, supplier contracts)
- **Avoid** (stop the activity)

**Step 5: Commit**

```bash
git add docs/iso27001/03-risk-assessment-methodology.md \
        docs/iso27001/04-risk-register.md \
        docs/iso27001/05-risk-treatment-plan.md
git commit -m "docs(iso27001): risk assessment methodology + register + treatment plan (T2.3, Ch 6.1)"
```

---

## Task T2.4: Statement of Applicability (SoA)

**Effort:** ~3-5 days. **Branch:** `p8/t2.4-soa`. **ISO ref:** Chapter 6.1.3. **Type:** documentation.

The SoA is the central document an auditor opens. For every Annex A control (93 in ISO 27001:2022), the SoA states: applicable or not, justification, current implementation status, evidence link.

**Files:**
- Create: `docs/iso27001/06-statement-of-applicability.md`

**Step 1: Get ISO 27001:2022 Annex A control list**

Either purchase the standard from ISO/JTC1, or use the publicly-available catalog. Annex A has 93 controls across 4 themes: Organizational (37), People (8), Physical (14), Technological (34).

**Step 2: For each control, fill in:**

| Field | Value |
|-------|-------|
| Control ID | A.5.1, A.5.2, ... |
| Control name | (from standard) |
| Applicable? | Yes / No |
| Justification | If No: why not applicable; if Yes: why applicable (almost always "applicable") |
| Implementation status | Implemented / Partial / Planned / Not started |
| Evidence reference | Link to relevant doc, code, or runbook |
| Owner | Aaron (default) or named role |
| Review date | Last reviewed |

**Step 3: Most controls map to existing P8 work**

Examples:
- A.5.18 (Access rights) → `docs/iso27001/access-control/rls-coverage.md` (T1.4)
- A.5.24-27 (Incident management) → `docs/iso27001/11-incident-management.md` (T2.13)
- A.5.29 (BC during disruption) → `docs/runbooks/backup-restore.md` (T1.1) + T2.14
- A.8.8 (Vulnerability mgmt) → `.github/dependabot.yml` (existing) + supplier register (T2.12)
- A.8.13 (Information backup) → T1.1
- A.8.24 (Cryptography) → `docs/iso27001/cryptography/secrets-management.md` (T1.5) + T2.9
- A.8.29 (Security testing) → `docs/iso27001/security-testing/pentest-2026-q2.md` (T1.6)
- A.8.32 (Change management) → existing PR process + ADRs

**Step 4: For non-applicable controls, document rationale**

Example exclusions:
- A.7.* (People controls related to remote/ad hoc workers): May simplify if no employees
- A.7.4 (Physical security monitoring): N/A if no owned facilities

**Step 5: Commit**

```bash
git add docs/iso27001/06-statement-of-applicability.md
git commit -m "docs(iso27001): Statement of Applicability — 93 Annex A controls mapped (T2.4, Ch 6.1.3)"
```

---

## Task T2.5: Internal audit cycle

**Effort:** ~3-4 days. **Branch:** `p8/t2.5-internal-audit`. **ISO ref:** Chapter 9.2. **Type:** governance + external engagement.

ISO requires *independent* internal audit. As a solo founder, engage a fractional CISO (~$3-5k for one cycle) to perform this in week 11-12.

**Files:**
- Create: `docs/iso27001/12-internal-audit-program.md`
- Create: `docs/iso27001/audits/2026-Q3-internal-audit-report.md` (after engagement)

**Step 1: Define audit program**

Audit scope, frequency (annual minimum), method (interview + document review + sample testing), reporting format.

**Step 2: Engage fractional CISO**

Vendors: Vanta, Drata, Secureframe (compliance automation platforms with attached audit services), or independent consultants on Upwork / LinkedIn. Brief them on platform + ISMS docs + scope.

**Step 3: CISO performs audit (week 11-12)**

Walks through SoA, samples evidence per control, interviews you on processes, identifies non-conformities (NCs).

**Step 4: Receive audit report + remediation plan**

Categorize NCs:
- **Major**: Control completely missing/ineffective. Must remediate before stage-1 audit.
- **Minor**: Control exists but evidence weak / process gap. Remediate within 90 days.
- **Observations**: Improvement suggestions; not blocking.

**Step 5: Commit report + start remediation**

```bash
git add docs/iso27001/12-internal-audit-program.md \
        docs/iso27001/audits/2026-Q3-internal-audit-report.md
git commit -m "docs(iso27001): internal audit program + first cycle report (T2.5, Ch 9.2)"
```

---

## Task T2.6: Management review cadence

**Effort:** ~1 day. **Branch:** `p8/t2.6-mgmt-review`. **ISO ref:** Chapter 9.3. **Type:** governance.

**Files:**
- Create: `docs/iso27001/13-management-review-program.md`
- Create: `docs/iso27001/mgmt-reviews/2026-Q3-management-review.md` (week 12 minutes)

**Step 1: Define cadence + agenda**

ISO requires "planned intervals" — quarterly is standard. Agenda (per Ch 9.3.2) covers:
- Status of actions from previous reviews
- Changes in interested parties / external/internal issues
- Performance feedback (incidents, audit results, monitoring data)
- Risk assessment + treatment plan status
- Opportunities for continual improvement

**Step 2: Hold first management review (week 12)**

For solo founder: this is a documented self-review. Cover:
- Last quarter's incident log
- Audit findings (from T2.5)
- Risk register changes
- Performance against ISMS objectives

Output: minutes documenting decisions, action items, attendees.

**Step 3: Commit**

```bash
git add docs/iso27001/13-management-review-program.md \
        docs/iso27001/mgmt-reviews/2026-Q3-management-review.md
git commit -m "docs(iso27001): management review program + first cycle minutes (T2.6, Ch 9.3)"
```

---

## Task T2.7: Asset inventory + classification

**Effort:** ~2-3 days. **Branch:** `p8/t2.7-asset-inventory`. **ISO ref:** A.5.9, A.5.10. **Type:** documentation.

**Files:**
- Create: `docs/iso27001/asset-management/asset-inventory.md`
- Create: `docs/iso27001/asset-management/classification-scheme.md`

**Step 1: Build classification scheme**

Tiers: Public / Internal / Confidential / Restricted. Define handling rules per tier (encryption, access control, retention).

**Step 2: Inventory assets**

Categories:
- **Information assets**: customer data (Restricted), narrative drafts (Confidential), source code (Internal), public website content (Public)
- **Hardware**: development laptops, production servers/VMs (or cloud accounts)
- **Software**: managed dependencies, third-party SaaS
- **Services**: GitHub, Anthropic, Resend, hosting provider, monitoring providers
- **Documents**: contracts, policies, audit reports

For each: ID, owner, classification, location, retention, disposal method.

**Step 3: Commit**

```bash
git add docs/iso27001/asset-management/
git commit -m "docs(iso27001): asset inventory + classification scheme (T2.7, A.5.9-10)"
```

---

## Task T2.8: Access control review

**Effort:** ~2-3 days. **Branch:** `p8/t2.8-access-control`. **ISO ref:** A.5.15-A.5.18, A.8.2-A.8.3. **Type:** documentation + automation.

**Files:**
- Create: `docs/iso27001/access-control/iam-policy.md`
- Create: `docs/iso27001/access-control/access-review-procedure.md`
- Create: `tools/iso27001/access-review.sh` — quarterly access review SQL

**Step 1: Document IAM policy**

Cover:
- Principle of least privilege
- User registration/de-registration procedure
- Role definitions (admin / consultant / viewer for tenants; subject_tenant_user ACL)
- Privileged access (DB admin, infrastructure, secrets manager)
- MFA requirements (mandatory for admin roles)

**Step 2: Document access-review procedure**

Quarterly:
1. Generate report of all users + roles per tenant: `tools/iso27001/access-review.sh`
2. Tenant admin reviews their users
3. Founder reviews privileged accounts
4. Output: review log entry with date, reviewer, anomalies, actions

**Step 3: Implement access-review SQL**

```sql
-- tools/iso27001/access-review.sh
SELECT t.name AS firm, u.email, tu.role, tu.created_at, tu.deleted_at
  FROM tenant_user tu
  JOIN tenant t ON t.id = tu.tenant_id
  JOIN "user" u ON u.id = tu.user_id
 WHERE tu.deleted_at IS NULL
 ORDER BY t.name, tu.role DESC, u.email;
```

Plus orphan-user query (users in no tenants), inactive-user query (no login in 90 days).

**Step 4: Commit**

```bash
git add docs/iso27001/access-control/iam-policy.md \
        docs/iso27001/access-control/access-review-procedure.md \
        tools/iso27001/access-review.sh
git commit -m "docs(iso27001): IAM policy + access-review procedure + automation (T2.8, A.5.15-18)"
```

---

## Task T2.9: Cryptography policy

**Effort:** ~1-2 days. **Branch:** `p8/t2.9-crypto-policy`. **ISO ref:** A.8.24. **Type:** documentation.

**Files:**
- Create: `docs/iso27001/cryptography/cryptography-policy.md`

(Note: T1.5's `secrets-management.md` is already in `docs/iso27001/cryptography/` — this task adds the broader policy.)

**Step 1: Document cryptographic standards**

- **Encryption at rest**: All customer data in postgres uses pgcrypto / column-level encryption for sensitive fields (e.g., `oauth_token` already AES-256-GCM with `TOKEN_ENCRYPTION_KEY`); platform data uses provider-side encryption (cloud disk encryption).
- **Encryption in transit**: TLS 1.2+ everywhere. Postgres client uses `sslmode=require`. Public endpoints use Let's Encrypt or provider-managed certs.
- **Key management**: Lifecycle (generation, distribution, rotation, retirement), per T1.5's policy.
- **Hashing**: bcrypt (or argon2) for passwords; SHA-256 for content hashes (audit chain); not for password hashing.

**Step 2: Document approved algorithms + key lengths**

- AES-256 for symmetric encryption
- RSA-2048 or Ed25519 for asymmetric (e.g., GitHub App keys)
- bcrypt cost ≥12 OR argon2id for passwords
- TLS 1.2+ with modern cipher suites

**Step 3: Commit**

```bash
git add docs/iso27001/cryptography/cryptography-policy.md
git commit -m "docs(iso27001): cryptography policy + approved algorithms (T2.9, A.8.24)"
```

---

## Task T2.10: Operations security

**Effort:** ~3-4 days. **Branch:** `p8/t2.10-ops-security`. **ISO ref:** A.8.6-A.8.16. **Type:** documentation.

**Files:**
- Create: `docs/iso27001/operations/logging-policy.md`
- Create: `docs/iso27001/operations/change-management.md`
- Create: `docs/iso27001/operations/vulnerability-management.md`
- Create: `docs/iso27001/operations/malware-protection.md`

**Step 1: Logging policy** (A.8.15-16)

Cover:
- What's logged (auth events, errors, audit_log existing in DB, access attempts)
- Retention (Sentry: provider default; audit_log: 7 years; application logs: 90 days hot, 1 year cold)
- Access to logs (who can read; least-privilege)
- Tamper-resistance (audit_log is append-only via existing constraint, migration 0035)

**Step 2: Change management** (A.8.32)

Cover:
- All changes via PR with code review (existing process)
- Major changes need ADR (`docs/decisions/`)
- Production deploys via CI (no manual deploys)
- Rollback procedure documented

**Step 3: Vulnerability management** (A.8.8)

Cover:
- Dependabot for dependency vulns (existing — verify config)
- Quarterly review of open CVEs
- Critical CVE response: patch within 72h
- High: patch within 30 days
- Annual pen-test (T1.6)

**Step 4: Malware protection** (A.8.7)

Cover:
- No file uploads run in any executable context
- Server-side malware scanning for any uploaded files (use ClamAV or provider feature)
- Endpoint protection on dev machines (e.g., macOS XProtect, Windows Defender)

**Step 5: Commit**

```bash
git add docs/iso27001/operations/
git commit -m "docs(iso27001): operations security — logging, change mgmt, vuln, malware (T2.10, A.8.6-16)"
```

---

## Task T2.11: Secure SDLC

**Effort:** ~2-3 days. **Branch:** `p8/t2.11-secure-sdlc`. **ISO ref:** A.8.25-A.8.32. **Type:** documentation.

**Files:**
- Create: `docs/iso27001/sdlc/secure-development-policy.md`
- Create: `docs/iso27001/sdlc/code-review-evidence.md`
- Create: `docs/iso27001/sdlc/environment-isolation.md`

**Step 1: Secure development policy** (A.8.25)

Cover:
- TDD is the standard (existing convention)
- Security testing in test suites (RLS coverage from T1.4, auth flows, etc.)
- Secrets never in source (gitleaks pre-commit hook + audit)
- Dependencies pinned + scanned (existing pnpm-lock + Dependabot)

**Step 2: Code review evidence** (A.8.28)

Cover:
- All PRs require ≥1 review (Aaron + Claude self-review for solo+AI)
- Required CI checks before merge (existing)
- Document the code review process + checklist

**Step 3: Environment isolation** (A.8.31)

Cover:
- Production / staging / dev environments separate
- Production secrets distinct from dev/staging
- Dev/staging never connect to production data
- Test data is synthetic OR anonymized

**Step 4: Commit**

```bash
git add docs/iso27001/sdlc/
git commit -m "docs(iso27001): secure SDLC — dev policy, code review, env isolation (T2.11, A.8.25-32)"
```

---

## Task T2.12: Supplier risk register

**Effort:** ~2-3 days. **Branch:** `p8/t2.12-supplier-register`. **ISO ref:** A.5.19-A.5.22. **Type:** documentation.

**Files:**
- Create: `docs/iso27001/suppliers/supplier-register.md`
- Create: `docs/iso27001/suppliers/onboarding-procedure.md`

**Step 1: Identify suppliers in critical path**

For each: Anthropic, GitHub, hosting provider (AWS / Vercel / etc.), Sentry, PagerDuty, Resend, Cobalt (pen-test), pgBackRest infrastructure (S3/Azure/etc.), DocuSign (B5 webhook).

**Step 2: For each supplier, document:**

| Field | Value |
|-------|-------|
| Supplier | (name) |
| Service | (what they provide) |
| Data shared | (what flows to them) |
| Sensitivity | (Public / Internal / Confidential / Restricted) |
| Their certifications | (SOC 2 / ISO 27001 / etc. — verify on their trust center) |
| DPA / contract | (link or status) |
| Last reviewed | (date) |
| Risk rating | (Low / Medium / High) |

**Step 3: Onboarding procedure for new suppliers**

Cover: due diligence checklist, DPA execution, integration security review, ongoing monitoring.

**Step 4: Commit**

```bash
git add docs/iso27001/suppliers/
git commit -m "docs(iso27001): supplier register + onboarding procedure (T2.12, A.5.19-22)"
```

---

## Task T2.13: Incident management plan

**Effort:** ~2-3 days. **Branch:** `p8/t2.13-incident-mgmt`. **ISO ref:** A.5.24-A.5.27. **Type:** documentation.

(Note: extends T1.9 runbooks with the formal incident-management governance framework.)

**Files:**
- Create: `docs/iso27001/incidents/incident-management-plan.md`
- Create: `docs/iso27001/incidents/post-incident-review-template.md`
- Create: `docs/iso27001/incidents/communication-plan.md`
- Create: `docs/iso27001/incidents/incidents-log.md` (initially empty)

**Step 1: Incident management plan**

Cover:
- Incident classification (Sev 1-4 per organization standard)
- Roles during incident (incident commander, comms, technical lead — for solo, all = founder)
- Detection sources (Sentry, PagerDuty, customer-reported, supplier outage)
- Response phases: Detect → Contain → Eradicate → Recover → Post-incident
- Time targets per severity (Sev 1: ack 5 min, contain 30 min, etc.)

**Step 2: Post-incident review template**

For every incident: timeline, root cause, contributing factors, remediation, lessons learned. This is both improvement and ISO Annex A.5.27 evidence.

**Step 3: Communication plan**

Internal: who's notified per severity. External: customer notification thresholds (data breach: GDPR/Privacy Act 1988 cl 26WK has 72h target; service outage: notify within 4h if ≥1h impact).

**Step 4: Commit**

```bash
git add docs/iso27001/incidents/
git commit -m "docs(iso27001): incident management plan + post-incident review + comms (T2.13, A.5.24-27)"
```

---

## Task T2.14: Business continuity plan + tabletop

**Effort:** ~2-3 days. **Branch:** `p8/t2.14-bcp`. **ISO ref:** A.5.29-A.5.30. **Type:** documentation + exercise.

**Files:**
- Create: `docs/iso27001/business-continuity/bc-plan.md`
- Create: `docs/iso27001/business-continuity/tabletop-2026-Q3.md`

**Step 1: BC plan**

Cover:
- BC objectives (e.g., "platform fully operational within 4h of major incident")
- Disaster scenarios (region outage, database corruption, key personnel unavailable, supplier outage, ransomware)
- Per-scenario response procedures (links to relevant runbooks)
- Recovery priorities (auth and audit_log first; UI second; reporting third)
- Communication to customers
- Recovery validation criteria

**Step 2: Tabletop exercise**

Pick 1-2 scenarios, walk through response with whoever's involved (you + fractional CISO if possible). Time it. Identify gaps. Document.

**Step 3: Commit**

```bash
git add docs/iso27001/business-continuity/
git commit -m "docs(iso27001): BC plan + first tabletop exercise (T2.14, A.5.29-30)"
```

---

## 🎯 Phase-end audit-readiness check (end of week 12)

Walk through each item; require all green to declare P8 complete.

| Item | Verification |
|------|--------------|
| All Track 1 components shipped + customer launched | T1.1-T1.9 complete; first customer using platform |
| All Track 2 ISMS docs exist | `ls docs/iso27001/` shows: 00-isms-scope, 01-policy, 02-roles, 03-methodology, 04-register, 05-treatment, 06-soa, 11-incidents, 12-audit, 13-mgmt-review |
| All Track 2 control docs exist | Sub-folders: access-control/, asset-management/, business-continuity/, cryptography/, incidents/, mgmt-reviews/, operations/, sdlc/, security-testing/, suppliers/ |
| ≥30 days operational evidence accumulated | Daily/weekly artifacts (backups, vuln scans, Sentry digest reviews) have ≥30 days of entries |
| Internal audit complete | T2.5 audit report exists with NCs identified + remediation plan |
| Management review complete | T2.6 minutes exist |
| All NCs at least planned for remediation | No "unhandled" Major NCs |

If all green: P8 ships stage-1-audit-ready posture. The 3-month evidence-accumulation window starts.

If any red: gap remediation sprint between P8 and audit booking (per design doc error-handling #3).

---

## Estimates summary

| Track | Effort | Calendar |
|-------|--------|----------|
| Track 1 (T1.1-T1.9) | ~25 working days | weeks 1-4 |
| Track 2 (T2.1-T2.14) | ~32-40 working days | weeks 4-12 (overlaps last 8 weeks of P8) |
| Buffer for pen-test/DR/customer feedback | ~5 working days | absorbed |
| **Total** | **~62-70 working days** | **~12 weeks** |
| Cash: fractional CISO | $3-5k | week 11-12 |
| Cash: pen-test | $8-15k | week 3-4 |
| Cash: tooling subscriptions | ~$80-150/mo ongoing | from week 1 |

End of P8 implementation plan.
