# First Incident Runbook

**Purpose:** Guide for the very first time you're handling a production incident. If you've never been paged before, start here.

**Last updated:** 2026-05-06

## Don't panic

Incidents are normal. The platform has monitoring, backups, and audit trails specifically for this situation. Your job is to follow the process, not to heroically fix everything in 5 minutes.

## Step-by-step

### 1. Acknowledge the page (0-2 min)

Open PagerDuty (mobile app or web). Hit "Acknowledge". This stops the escalation timer and tells the system you're on it.

### 2. Orient yourself (2-5 min)

Open these tabs:

- **Sentry** → filter by "last 15 minutes" → look for new errors or error spikes
- **Grafana** → synthetic probe dashboard → are probes green or red?
- **API logs** → look for 500 errors, connection timeouts, or crash traces

Ask: "Is the platform up?" If all probes are red → database or infrastructure issue. If only some endpoints fail → application-level bug.

### 3. Classify and communicate (5-10 min)

Use the severity table in `on-call.md`. If it's Sev 1 or Sev 2:

- Start an incident log (even a text file or Slack thread)
- Note: time, symptom, severity, first hypothesis

If customers are affected: notify them. Simple message:

> "We're aware of [symptom] and are investigating. We'll update within [30 min / 1h]."

### 4. Investigate and contain (10-30 min)

Common first-response actions:

- **DB unreachable**: Check hosting provider status page → restart DB if applicable → verify connection strings
- **500 errors on specific endpoint**: Read the Sentry stack trace → identify the failing line → check recent deploys
- **Auth failures**: Check JWT secret env vars → check session signing → verify IdP status
- **Data integrity alert**: Run hash-chain verification → check audit_log for recent anomalies

### 5. Fix or mitigate

- If you can fix it: fix, test, deploy
- If you can't fix it quickly: mitigate (disable the broken feature, redirect traffic, put up maintenance page)
- If you're stuck: escalate to backup contact

### 6. Resolve and document

1. Confirm the fix is live and monitoring shows green
2. Resolve the PagerDuty incident
3. Write a post-incident review (template in `docs/iso27001/incidents/post-incident-review-template.md`)
4. Update the incidents log (`docs/iso27001/incidents/incidents-log.md`)

## Remember

- It's OK to take your time. A methodical 30-minute investigation beats a panicked 5-minute guess.
- Document as you go. Future-you will thank present-you.
- Every incident is a learning opportunity, not a failure.
