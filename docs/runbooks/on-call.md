# On-Call Runbook

**Last updated:** 2026-05-06

## Who's on-call

| Tier    | Contact                               | Method                      | Escalation after |
| ------- | ------------------------------------- | --------------------------- | ---------------- |
| Primary | Aaron (Founder)                       | PagerDuty page → SMS + push | —                |
| Backup  | [TBD — fractional CISO or contractor] | Email                       | 30 min no-ack    |

## Severity definitions

| Severity         | Description                                         | Response target           | Examples                                                   |
| ---------------- | --------------------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| Sev 1 (Critical) | Platform down or data breach confirmed              | Ack 5 min, contain 30 min | DB unreachable, auth bypass, data exfiltration             |
| Sev 2 (High)     | Major feature broken, affecting active users        | Ack 15 min, fix 4h        | Narrative generation failing, webhook processing stuck     |
| Sev 3 (Medium)   | Degraded performance or non-critical feature broken | Ack 1h, fix 24h           | Slow queries, RIF feed not polling, email delivery delayed |
| Sev 4 (Low)      | Cosmetic or low-impact issue                        | Next business day         | UI glitch, non-critical log noise                          |

## When you get paged

1. **Acknowledge the page** in PagerDuty (stops re-paging)
2. **Open dashboards:**
   - Sentry: check recent errors (sorted by frequency)
   - Grafana: check uptime probes (any red?)
   - Application logs: `heroku logs --tail` or equivalent
3. **Classify severity** using the table above
4. **Follow the relevant runbook** (see INDEX.md)
5. **Communicate** if customer-facing (see incident-management-plan.md for thresholds)

## During off-hours

- Sev 1: respond immediately (sleep interruption acceptable)
- Sev 2: respond within 15 min
- Sev 3-4: acknowledge, schedule for next business day

## Shift handoff (when team grows)

- Review open incidents
- Note any ongoing investigations
- Confirm monitoring dashboards are green
