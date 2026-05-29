# Consultant Watch — Realtime News, Announcements, Facts, Insights & Processing

**Date:** 2026-05-29
**Status:** Design approved — ready to build
**Surface:** `/consultant/watch` → `apps/web/src/app/consultant/_components/watch-view.tsx`

## Problem

The consultant **Watch** page ("Daily signal scan") is the realtime news/announcement
page, but it renders entirely hardcoded `const SIGNALS` fixtures (zero hooks — the
unshipped "V1"). The user also wants the previously-present **facts + processing
information** and **recent news + insights** surfaced here.

## What already exists (reuse, don't rebuild)

- **Regulatory feed**: `regulatory_event` ⋈ `regulatory_source`, populated by the
  `rif-daily-scrape` pg-boss job. Columns include `classification_kind`,
  `classification_severity`, `classification_payload` (jsonb), `classified_at`,
  `raw_url`, `raw_title`; sources carry `last_polled_at` / `last_polled_status` /
  `fetch_interval_hours`.
- **Signals API**: `GET /v1/consultant/signals?window=24h|7d|30d` → `{src,tag,code,title,exposure,when}`.
  Consumed by the dashboard mini `WatchPanel` (`useConsultantSignals`).
- **Insights ("top facts") API**: `GET /v1/insights?scope=&subject_tenant_id=` →
  ranked insight cards (deterministic + generative) + `budget` + `generative_status`.
  Works firm-wide (no subject). Already powered by `insights-strip.tsx` (Tailwind) on
  the activities + claim-wizard pages — but that component is the standard app theme,
  not the consultant System A (dark/amber, token inline styles, no Tailwind).

## Design (three sections, System A styled, auto-refresh poll)

### 1. Insights / Top Facts  (the "facts and insights")
- Reuse `GET /v1/insights?scope=watch` (firm-wide, no subject).
- New consultant-styled component `watch-insights.tsx` (System A tokens) — rotating
  featured card (12s) + a row of insight chips; small footer line showing
  `generative_status` + budget ("free tier · A$X / A$50" / "billable") = the
  **processing information** for the AI layer.
- react-query `refetchInterval: 60_000`.

### 2. Pipeline / Processing  (the news **processing information**)
- NEW `GET /v1/consultant/watch/status` (session-required; regulatory data is global,
  not tenant-scoped): per source `{ source_name, last_polled_at, last_polled_status,
  enabled, fetch_interval_hours }` + totals `{ events_in_window, classified, pending,
  last_scan_at }`.
- Consultant-styled strip: each source with status dot (ok/failed/stale) + last-scan
  time; header line "N events · M classified · last scan HH:MM".
- react-query `refetchInterval: 45_000`.

### 3. Recent news & announcements  (the realtime feed)
- Extend `GET /v1/consultant/signals` **additively** (dashboard panel unaffected):
  add `severity`, `kind`, `summary` (from `classification_payload`), `url` (`raw_url`),
  full `published_at`, `classified` (bool).
- Rewrite the `watch-view.tsx` list off `useConsultantSignals` with a window selector
  (24h / 7d / 30d), per-item AI **summary (facts)**, severity + kind tags, exposure
  ("N claims"), ingested time, and a link to the source ruling/announcement.
- Loading + empty states (no fiction). react-query `refetchInterval: 45_000` +
  refetch-on-focus.

## API summary
| Endpoint | Change |
|----------|--------|
| `GET /v1/insights` | none (reuse) |
| `GET /v1/consultant/signals` | additive fields (severity/kind/summary/url/published_at/classified) |
| `GET /v1/consultant/watch/status` | NEW — source poll status + counts |

## Out of scope / follow-ups
- SSE push (chose auto-refresh poll instead).
- Seeding `regulatory_source` + running `rif-daily-scrape` on prod — the page is
  correct-but-empty until the scrape has run. Verify + seed/trigger after build.

## Verification
- API tests: signals additive fields; new watch/status (happy path + empty).
- `typecheck` (api + web) + targeted route tests green.
- Live dogfood at `/consultant/watch` once deployed.
