# RIF Historical Backfill Runbook

**Date:** 2026-05-06
**Task:** D.14 -- Historical backfill script (AAT/ART 2015+, ATO TAs 2018+)
**Owner:** Aaron
**Script:** `tools/scripts/backfill-regulatory-history.ts`

---

## Purpose

One-time historical backfill of regulatory events into the `regulatory_event` table. The daily scrape (D.9) only fetches recent items from live feeds. This script walks historical AustLII AAT/ART year-listing pages back to 2015 and processes the current ATO tax alerts RSS feed, inserting all R&DTI-relevant events that the daily cron would have missed.

## Prerequisites

1. **PostgreSQL running** on port 5433 (`pnpm db:up` from repo root).
2. **Environment variables loaded** -- the script reads `.env` via tsx `--env-file-if-exists`.
   - `DATABASE_URL` must point to the migration/privileged role (cpa).
   - `APP_DATABASE_URL` is not required (this script uses `privilegedSql` only).
3. **`regulatory_source` rows seeded** -- the script looks up sources by `parser_kind` (`austlii_html` and `rss`). If these rows do not exist, the script will log a warning and skip.
4. **(Optional) `ANTHROPIC_API_KEY`** set if using `--classify`.

## Commands

### Dry run (no DB writes, no HTTP fetches)

```bash
npx tsx tools/scripts/backfill-regulatory-history.ts --dry-run
```

Prints the list of URLs that would be fetched and the flags in effect. Useful for verifying configuration.

### Full backfill (AustLII + ATO)

```bash
npx tsx tools/scripts/backfill-regulatory-history.ts
```

Fetches all AustLII year pages from 2015 to the current year and the ATO RSS feed (filtering items from 2018+). Inserts events idempotently.

### AustLII only

```bash
npx tsx tools/scripts/backfill-regulatory-history.ts --austlii-only
```

### ATO only

```bash
npx tsx tools/scripts/backfill-regulatory-history.ts --ato-only
```

### Custom start year

```bash
npx tsx tools/scripts/backfill-regulatory-history.ts --from-year 2020
```

Overrides the default start year for whichever sources are being backfilled.

### Backfill + classify

```bash
npx tsx tools/scripts/backfill-regulatory-history.ts --classify --classify-limit 100
```

After inserting events, runs `classifyEvent()` on up to 100 newly inserted (unclassified) events via the Anthropic API. Requires `ANTHROPIC_API_KEY`.

## Expected Output

```
[backfill] Starting regulatory history backfill
[backfill] Flags: {"dryRun":false,"classify":false,"classifyLimit":50,...}
[backfill:austlii] Processing 12 year(s): 2015--2026
[backfill:austlii] Fetching https://www.austlii.edu.au/cgi-bin/viewdb/au/cases/cth/AATA/2015/
[backfill:austlii]   Parsed 3 R&DTI-relevant decision(s)
...
[backfill:ato] Fetching feed: https://www.ato.gov.au/rss/taxpayer-alerts.xml (filtering from 2018)
[backfill:ato]   Parsed 15 item(s), 12 after year filter

[backfill] Summary:
{
  "austlii_years_fetched": 12,
  "austlii_events_inserted": 47,
  "austlii_events_skipped": 0,
  "ato_feeds_fetched": 1,
  "ato_events_inserted": 12,
  "ato_events_skipped": 0,
  "classified": 0,
  "errors": []
}
```

Exit code 0 on success, 1 if any errors occurred (individual event errors are non-fatal but counted).

## Verifying Results

After running the backfill, query the database to confirm:

```sql
-- Count events by source
SELECT s.source_name, COUNT(e.id) AS event_count
FROM regulatory_event e
JOIN regulatory_source s ON s.id = e.source_id
GROUP BY s.source_name
ORDER BY s.source_name;

-- Count classified vs unclassified
SELECT
  COUNT(*) AS total,
  COUNT(classified_at) AS classified,
  COUNT(*) - COUNT(classified_at) AS unclassified
FROM regulatory_event;

-- Check oldest and newest events
SELECT source_id, MIN(published_at) AS earliest, MAX(published_at) AS latest
FROM regulatory_event
GROUP BY source_id;
```

## Idempotency Guarantee

The script uses `INSERT ... ON CONFLICT (source_id, external_id) DO NOTHING` for every event. Re-running the script will skip already-inserted events and only add genuinely new ones. It is completely safe to run multiple times.

## Troubleshooting

| Symptom                                                            | Cause                       | Fix                                                            |
| ------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------- |
| "No enabled regulatory_source with parser_kind=austlii_html found" | Missing seed data           | Run the D.9 migration or insert the source row manually        |
| HTTP 403 from AustLII                                              | Rate limiting or IP block   | Wait and retry, or reduce request frequency                    |
| HTTP 429 from ATO                                                  | Rate limiting               | Wait 60s and retry                                             |
| Classification errors                                              | Missing `ANTHROPIC_API_KEY` | Set the env var or remove `--classify` flag                    |
| Exit code 1 with partial results                                   | Some events failed          | Check the `errors` array in the summary output; safe to re-run |
