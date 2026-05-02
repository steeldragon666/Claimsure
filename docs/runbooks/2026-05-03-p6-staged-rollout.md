# P6 Staged Rollout Runbook

**Status:** Pending — none of the three phases has been executed yet.
**Owner:** Aaron (`aaron@carbonproject.com.au`).
**Plan source:** `docs/plans/2026-05-01-p6-implementation.md` Theme 8 (Tasks 8.1, 8.2, 8.3).
**Design source:** `docs/plans/2026-05-01-p6-design.md` §6 ("Phase 1 rollout: dogfood firm only. Phase 2: 3 friendly customer firms. Phase 3: all firms after a week of clean telemetry.").

---

## Pre-flight (do once, before Phase 1)

- [ ] Confirm Themes 0–7 PRs are all merged into `main`:
  - PR #14 (foundation): merge SHA `e3ade56`
  - PR #15 (Agent A): merge SHA `aceee1f`
  - PR #16 (Agent B): merge SHA `5e9d1c8`
  - PR #17 (Agent C): merge SHA `b0aa4fa`
  - PR #18 (mapping_rule backfill): merge SHA `eed4af9`
  - PR #19 (eval framework): pending
- [ ] Add the `EVAL_ANTHROPIC_API_KEY` GitHub secret so the eval workflow can run.
- [ ] Provision the production `ANTHROPIC_API_KEY` in the deployment platform (Fly / Vercel — wherever apps/api is hosted).
- [ ] Identify the dogfood firm's `tenant_id`. This is the firm's row in the `tenant` table — copy its UUID. Store somewhere persistent (1Password / team doc) since you'll reference it for the next 2+ weeks.
- [ ] Identify the 3 friendly customer firms (Phase 2 scope). Same — copy their `tenant_id`s. Coordinate with them so they know they're getting the agents and to direct any AI-classification feedback back through their account manager.
- [ ] Set up the Grafana dashboards / Slack alerts that will gate phase transitions. Suggested:
  - **Cost panel** — `sum(cpa_cost_usd) by (cpa_agent_name)` per 24h, alert at $50/day per agent.
  - **Error rate panel** — `count(span.status=ERROR) / count(span.status=OK)` per agent per 1h, alert at 5%.
  - **Validation downgrade panel** (Agent C only) — `sum(narrative_drafted.validation_downgraded_count)` over the daily windows; investigate any non-zero days.
  - **Idempotent-skip rate** — `sum(skipped_idempotent) / sum(classified)` per Agent A — should hover near zero on first runs but climb on retries.
- [ ] Alert chain: Slack `#p6-rollout` channel with the above panels' alerts wired in.

---

## Phase 1 — Dogfood firm only

**Effort:** ~30 min config + 1 week soak.
**Success criterion:** zero error-budget burn over the soak window; cost stays under $20/day total across all three agents; no consultant complaints about wrong classifications that warrant rolling back.

### Step 1.1 — Set production env vars

In the deployment platform (Fly/Vercel/etc.), set:

```
P6_AGENT_A_ENABLED=true
P6_AGENT_B_ENABLED=true
P6_AGENT_C_ENABLED=true
P6_AGENT_C_STREAMING_ENABLED=true
P6_AGENT_TENANT_ALLOWLIST=<dogfood-tenant-id>     # <-- exactly one UUID
ANTHROPIC_API_KEY=<production key>
EXPENDITURE_CLASSIFIER_IMPL=haiku
ACTIVITY_REGISTER_SYNTHESIZER_IMPL=sonnet
```

The allowlist with a single tenant means: every other firm sees `isTenantAllowed(...)` return false and the shim short-circuits. Agents A/B/C are effectively disabled for everyone except dogfood.

Verify per-tenant gating with:

```sql
SELECT tenant_id, COUNT(*) AS classify_events
  FROM event WHERE kind = 'EXPENDITURE_CLASSIFIED'
   AND captured_at > now() - interval '1 hour'
GROUP BY tenant_id;
```

After 1 hour of dogfood-firm activity, this should show only the dogfood `tenant_id`.

### Step 1.2 — Deploy

Trigger the deployment pipeline (or `gstack ship`). Watch the runtime-logs for the first 5 minutes for:
- `[expenditure-classify]` lines — should show batch counts > 0 if dogfood ingests Xero data
- `[activity-register-synthesize]` lines — fires when a consultant clicks "Synthesize register"
- `narrative-drafter` SSE traffic — fires when a consultant clicks "Draft narrative"
- Anthropic 5xx / rate-limit errors — should be near-zero

### Step 1.3 — Soak

Leave the config alone for 1 week (target: until `now() + 7 days`).

Mid-soak checks (daily):
- [ ] Check the Grafana cost panel each morning — alert at $50/day total.
- [ ] Check the validation-downgrade panel — should be 0 most days.
- [ ] Ask the dogfood consultant team for a thumbs-up / specific complaints. Solicit; don't wait for them to come to you.
- [ ] Spot-check one of each agent's outputs:
  - Agent A: `SELECT payload FROM event WHERE kind='EXPENDITURE_CLASSIFIED' ORDER BY captured_at DESC LIMIT 5;` — does `decision` look reasonable for the vendor names?
  - Agent B: pick a project that synthesized; does the proposed activity register match what a consultant would draft?
  - Agent C: pick an activity that drafted; do the claim segments cite real events from the activity's clustered_event_ids?

### Step 1.4 — Phase-1 exit gate

After 7 days of clean telemetry:
- [ ] Cost burn ≤ $20/day total over the window
- [ ] Validation downgrade count = 0 (or has a documented explanation per occurrence)
- [ ] Error rate < 1% across all three agents
- [ ] No consultant rollback request

If any gate fails: do NOT proceed to Phase 2. Triage in Slack `#p6-rollout`. Common rollback levers:
- Disable a single agent: set `P6_AGENT_X_ENABLED=false`, redeploy.
- Disable streaming only: `P6_AGENT_C_STREAMING_ENABLED=false` falls Agent C back to non-streaming response.
- Full kill switch: empty `P6_AGENT_TENANT_ALLOWLIST` AND set all `_ENABLED=false`.

If all gates pass: proceed to Phase 2.

---

## Phase 2 — Friendly firms (3 added)

**Effort:** ~30 min config + 1 week soak.
**Success criterion:** same as Phase 1, scaled — cost stays under $80/day total (assume each firm classifies similar volume to dogfood), error rate < 1%, no rollback requests from any of the 4 firms in scope.

### Step 2.1 — Add tenant IDs to allowlist

```
P6_AGENT_TENANT_ALLOWLIST=<dogfood>,<friendly-1>,<friendly-2>,<friendly-3>
```

CSV format. The shim's `parseAllowlist` trims whitespace and drops empty entries. Order doesn't matter.

Deploy. Verify with the same SQL as Phase 1, expecting 4 distinct `tenant_id`s after a few hours.

### Step 2.2 — Communicate to friendly firms

Send each friendly firm's primary contact a short heads-up:

> Hi <name> — we've enabled our new AI co-author features for your firm. You'll see (a) classification badges on Xero-imported expenditures, (b) a "Synthesize register" button on each project's activity register, and (c) a "Draft narrative" button on each activity's narrative section. You can ignore them entirely if you prefer; everything is reviewable and overridable. We're collecting feedback for the next week — direct anything to <support email>.

### Step 2.3 — Soak

Same daily checks as Phase 1. Watch especially for:
- Cross-firm cost variance (one firm consuming 5× another's classifier budget likely indicates a runaway loop or unexpected data shape — investigate).
- Per-firm validation-downgrade rate — if a firm's data systematically triggers downgrades, the prompt may need to adapt to their domain language.

### Step 2.4 — Phase-2 exit gate

Same gates as Phase 1, scaled. If clean for 7 days, proceed to Phase 3.

---

## Phase 3 — All firms

**Effort:** ~30 min config. No soak required (after this, the agents are simply on for everyone).
**Success criterion:** the agents stay on indefinitely; the rate-limit token bucket protects against runaway-loop classes; per-tenant Anthropic spend is monitored continuously.

### Step 3.1 — Empty the allowlist

```
P6_AGENT_TENANT_ALLOWLIST=
```

(Empty string. The shim treats unset OR empty as "all tenants allowed".)

Deploy. Verify with the Phase-1 SQL — after a few hours the distinct `tenant_id` count should be the population of active firms.

### Step 3.2 — Watch for runaway-loop signals

The rate-limit token bucket caps each `(tenant_id, agent)` pair at 100 calls/min by default (env-overridable via `P6_AGENT_RATE_LIMIT_PER_MIN`). A firm that hits this ceiling generates `RateLimitExceededError` in the logs — alert if any tenant exceeds the threshold for >5 consecutive minutes; that's a runaway loop, not a workload pattern.

### Step 3.3 — Day-1 expectations

- Cost: ~$0.10 per 1000-expenditure claim (Haiku) + ~$0.30 per project synthesis (Sonnet) + ~$0.50 per activity narrative draft (Sonnet streaming). For a typical month with N firms, M projects/firm, K expenditures/firm, narrative drafts on V activities: total cost ≈ N × ($0.30 × M + $0.50 × V) + ($0.10 / 1000) × Σ(K).
- Validation-downgrade should remain near-zero. If it spikes, investigate the prompt — the model may have drifted on a vocabulary it learned from one firm's idioms.

### Step 3.4 — Phase-3 done

No exit gate — Phase 3 is the steady state. After 1 week of clean Phase 3 telemetry, proceed to **Theme 9 (P6 retrospective)** — see `docs/retros/2026-05-DD-p6-retro.md`.

---

## Rollback levers (any time)

| Severity | Lever | Effect |
| --- | --- | --- |
| Per-agent regression | `P6_AGENT_<X>_ENABLED=false` | That agent silently no-ops; existing data unaffected |
| Per-tenant regression | Remove tenant from `P6_AGENT_TENANT_ALLOWLIST` | That tenant stops getting fresh classifications/syntheses; existing rows untouched |
| Streaming-only issue | `P6_AGENT_C_STREAMING_ENABLED=false` | Agent C falls back to non-streaming response; SSE endpoint still works but completes only on `done` |
| Rate-limit too tight | Bump `P6_AGENT_RATE_LIMIT_PER_MIN` (default 100) | Wider burst capacity per (tenant, agent) |
| Full kill switch | All `P6_AGENT_*_ENABLED=false` + empty allowlist | All three agents disabled platform-wide |

The shim's gating is the single source of truth for these levers — it lives in `apps/api/src/lib/enqueue-{classify,synthesize}.ts` and the route-level `503` checks. No DB migration required for rollback.

---

## Post-rollout monitoring (ongoing)

After Phase 3 lands, set up:

- **Weekly cost report** — aggregate `cpa_cost_usd` by tenant, by agent, by week. Send to `#p6-rollout` Slack channel automatically.
- **Daily validation-downgrade scan** — alert if any single day across all agents has > 5 downgrades.
- **Monthly prompt-version audit** — anyone bumping a prompt's `@version` triggers the eval CI workflow (`agent-eval.yml`); prompt PRs can't merge if eval regresses by > 10% (manual gate until Task 7.2's golden datasets are curated).

These are not part of P6 itself — they're the operational sustaining work that P6's telemetry instrumentation enables.
