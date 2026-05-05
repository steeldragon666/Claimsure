/**
 * P7 Theme D Task D.14 — Historical backfill for regulatory events.
 *
 * One-shot CLI script that walks historical AustLII AAT/ART decisions
 * (2015 -- present) and ATO tax alerts (2018 -- present), then inserts
 * them into `regulatory_event` via the same parsers used by D.13
 * connectors. Safe to re-run (idempotent via ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   npx tsx tools/scripts/backfill-regulatory-history.ts [options]
 *
 * Options:
 *   --dry-run            Print what would be fetched without writing to DB
 *   --classify           Run AI classification on newly inserted events
 *   --classify-limit N   Max classification API calls (default: 50)
 *   --austlii-only       Only backfill AustLII AAT/ART decisions
 *   --ato-only           Only backfill ATO tax alerts
 *   --from-year YYYY     Override start year (default: 2015 for AustLII, 2018 for ATO)
 *
 * Architecture note: DB and connector imports are deferred to main()
 * via dynamic import so that the pure helper functions (parseFlags,
 * buildAustliiYearUrls) can be imported by the test suite without
 * triggering a Postgres connection or side-effect connector registrations.
 */

import type { RawRegulatoryEvent } from '@cpa/integrations/regulatory';

/* ------------------------------------------------------------------ */
/*  CLI argument parsing                                               */
/* ------------------------------------------------------------------ */

export interface BackfillFlags {
  dryRun: boolean;
  classify: boolean;
  classifyLimit: number;
  austliiOnly: boolean;
  atoOnly: boolean;
  fromYear: number | null;
}

export function parseFlags(argv: string[]): BackfillFlags {
  const flags: BackfillFlags = {
    dryRun: false,
    classify: false,
    classifyLimit: 50,
    austliiOnly: false,
    atoOnly: false,
    fromYear: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--classify') flags.classify = true;
    else if (arg === '--classify-limit') {
      const next = argv[++i];
      flags.classifyLimit = next ? parseInt(next, 10) : 50;
    } else if (arg === '--austlii-only') flags.austliiOnly = true;
    else if (arg === '--ato-only') flags.atoOnly = true;
    else if (arg === '--from-year') {
      const next = argv[++i];
      flags.fromYear = next ? parseInt(next, 10) : null;
    }
  }

  return flags;
}

/* ------------------------------------------------------------------ */
/*  URL generation                                                     */
/* ------------------------------------------------------------------ */

const AUSTLII_YEAR_BASE = 'https://www.austlii.edu.au/cgi-bin/viewdb/au/cases/cth/AATA';

/**
 * Build the list of AustLII year-index URLs to scrape.
 * Each year has a landing page listing all decisions for that year.
 */
export function buildAustliiYearUrls(fromYear: number, toYear: number): string[] {
  const urls: string[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    urls.push(`${AUSTLII_YEAR_BASE}/${year}/`);
  }
  return urls;
}

/* ------------------------------------------------------------------ */
/*  Summary statistics                                                 */
/* ------------------------------------------------------------------ */

export interface BackfillStats {
  austlii_years_fetched: number;
  austlii_events_inserted: number;
  austlii_events_skipped: number;
  ato_feeds_fetched: number;
  ato_events_inserted: number;
  ato_events_skipped: number;
  classified: number;
  errors: string[];
}

function emptyStats(): BackfillStats {
  return {
    austlii_years_fetched: 0,
    austlii_events_inserted: 0,
    austlii_events_skipped: 0,
    ato_feeds_fetched: 0,
    ato_events_inserted: 0,
    ato_events_skipped: 0,
    classified: 0,
    errors: [],
  };
}

/* ------------------------------------------------------------------ */
/*  Utility                                                            */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/*  Main — all DB-dependent logic lives here                           */
/* ------------------------------------------------------------------ */

const DEFAULT_AUSTLII_START = 2015;
const DEFAULT_ATO_START = 2018;

async function main(): Promise<void> {
  // Lazy imports: only resolved when the script is actually executed as CLI
  const crypto = await import('node:crypto');
  const { privilegedSql } = await import('@cpa/db/client');
  const { parseAustliiDecisions, parseRssItems } = await import('@cpa/integrations/regulatory');

  const flags = parseFlags(process.argv.slice(2));

  console.log('[backfill] Starting regulatory history backfill');
  console.log(`[backfill] Flags: ${JSON.stringify(flags)}`);

  /* ---- DB helpers ------------------------------------------------ */

  async function lookupSource(
    parserKind: string,
  ): Promise<{ id: string; source_url: string; source_name: string } | null> {
    const rows = await privilegedSql<{ id: string; source_url: string; source_name: string }[]>`
      SELECT id, source_url, source_name
      FROM regulatory_source
      WHERE parser_kind = ${parserKind} AND enabled = true
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async function insertEvent(
    sourceId: string,
    evt: RawRegulatoryEvent,
  ): Promise<{ inserted: boolean; id: string }> {
    const rows = await privilegedSql<{ id: string }[]>`
      INSERT INTO regulatory_event (id, source_id, external_id, raw_title, raw_content, published_at, raw_url)
      VALUES (
        ${crypto.randomUUID()}, ${sourceId}, ${evt.external_id},
        ${evt.raw_title}, ${evt.raw_content}, ${evt.published_at},
        ${evt.source_url ?? ''}
      )
      ON CONFLICT (source_id, external_id) DO NOTHING
      RETURNING id
    `;
    if (rows.length > 0) return { inserted: true, id: rows[0]!.id };

    // Already existed -- fetch id for optional classification
    const existing = await privilegedSql<{ id: string }[]>`
      SELECT id FROM regulatory_event
      WHERE source_id = ${sourceId} AND external_id = ${evt.external_id}
    `;
    return { inserted: false, id: existing[0]!.id };
  }

  /* ---- AustLII backfill ----------------------------------------- */

  async function backfillAustlii(stats: BackfillStats): Promise<string[]> {
    const source = await lookupSource('austlii_html');
    if (!source) {
      const msg =
        'No enabled regulatory_source with parser_kind=austlii_html found. Skipping AustLII.';
      console.warn(`[backfill] ${msg}`);
      stats.errors.push(msg);
      return [];
    }

    const fromYear = flags.fromYear ?? DEFAULT_AUSTLII_START;
    const toYear = new Date().getUTCFullYear();
    const urls = buildAustliiYearUrls(fromYear, toYear);
    const newEventIds: string[] = [];

    console.log(`[backfill:austlii] Processing ${urls.length} year(s): ${fromYear}--${toYear}`);

    for (const url of urls) {
      try {
        console.log(`[backfill:austlii] Fetching ${url}`);

        if (flags.dryRun) {
          console.log(`[backfill:austlii]   (dry-run) Would fetch ${url}`);
          stats.austlii_years_fetched++;
          continue;
        }

        const response = await globalThis.fetch(url, {
          headers: { 'User-Agent': 'CPA-Platform-RIF/1.0 (backfill)' },
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const msg = `AustLII HTTP ${response.status} for ${url}`;
          console.warn(`[backfill:austlii]   ${msg}`);
          stats.errors.push(msg);
          continue;
        }

        const html = await response.text();
        const events = parseAustliiDecisions(html, url);
        console.log(`[backfill:austlii]   Parsed ${events.length} R&DTI-relevant decision(s)`);

        for (const evt of events) {
          try {
            const { inserted, id } = await insertEvent(source.id, evt);
            if (inserted) {
              stats.austlii_events_inserted++;
              newEventIds.push(id);
            } else {
              stats.austlii_events_skipped++;
            }
          } catch (err) {
            const msg = `Insert error for ${evt.external_id}: ${err instanceof Error ? err.message : String(err)}`;
            console.warn(`[backfill:austlii]   ${msg}`);
            stats.errors.push(msg);
          }
        }

        stats.austlii_years_fetched++;

        // Respect rate limits -- brief pause between year pages
        await sleep(1_000);
      } catch (err) {
        const msg = `Fetch error for ${url}: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`[backfill:austlii]   ${msg}`);
        stats.errors.push(msg);
      }
    }

    return newEventIds;
  }

  /* ---- ATO tax alerts backfill ---------------------------------- */

  async function backfillAto(stats: BackfillStats): Promise<string[]> {
    const source = await lookupSource('rss');
    if (!source) {
      const msg = 'No enabled regulatory_source with parser_kind=rss found. Skipping ATO.';
      console.warn(`[backfill] ${msg}`);
      stats.errors.push(msg);
      return [];
    }

    const feedUrl = source.source_url;
    const fromYear = flags.fromYear ?? DEFAULT_ATO_START;
    const newEventIds: string[] = [];

    console.log(`[backfill:ato] Fetching feed: ${feedUrl} (filtering from ${fromYear})`);

    if (flags.dryRun) {
      console.log(`[backfill:ato]   (dry-run) Would fetch ${feedUrl}`);
      stats.ato_feeds_fetched++;
      return [];
    }

    try {
      const response = await globalThis.fetch(feedUrl, {
        headers: { 'User-Agent': 'CPA-Platform-RIF/1.0 (backfill)' },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const msg = `ATO RSS HTTP ${response.status} for ${feedUrl}`;
        console.warn(`[backfill:ato]   ${msg}`);
        stats.errors.push(msg);
        return [];
      }

      const xml = await response.text();
      const events = parseRssItems(xml, feedUrl);

      // Filter events to only include items from the target start year onwards
      const filtered = events.filter((evt) => {
        try {
          const year = new Date(evt.published_at).getUTCFullYear();
          return year >= fromYear;
        } catch {
          return true; // Include if date parsing fails
        }
      });

      console.log(
        `[backfill:ato]   Parsed ${events.length} item(s), ${filtered.length} after year filter`,
      );

      for (const evt of filtered) {
        try {
          const { inserted, id } = await insertEvent(source.id, evt);
          if (inserted) {
            stats.ato_events_inserted++;
            newEventIds.push(id);
          } else {
            stats.ato_events_skipped++;
          }
        } catch (err) {
          const msg = `Insert error for ${evt.external_id}: ${err instanceof Error ? err.message : String(err)}`;
          console.warn(`[backfill:ato]   ${msg}`);
          stats.errors.push(msg);
        }
      }

      stats.ato_feeds_fetched++;
    } catch (err) {
      const msg = `Fetch error for ${feedUrl}: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[backfill:ato]   ${msg}`);
      stats.errors.push(msg);
    }

    return newEventIds;
  }

  /* ---- Optional classification pass ----------------------------- */

  async function classifyNewEvents(
    eventIds: string[],
    limit: number,
    stats: BackfillStats,
  ): Promise<void> {
    if (eventIds.length === 0) {
      console.log('[backfill:classify] No new events to classify.');
      return;
    }

    // Lazy-import to avoid pulling Anthropic SDK unless --classify is used
    const { classifyEvent } = await import('@cpa/agents/regulatory-classifier');

    const toClassify = eventIds.slice(0, limit);
    console.log(`[backfill:classify] Classifying ${toClassify.length} event(s) (limit: ${limit})`);

    for (const eventId of toClassify) {
      try {
        const rows = await privilegedSql<
          {
            id: string;
            raw_title: string;
            raw_content: string;
            source_name: string;
            raw_url: string;
          }[]
        >`
          SELECT e.id, e.raw_title, e.raw_content, s.source_name, e.raw_url
          FROM regulatory_event e
          JOIN regulatory_source s ON s.id = e.source_id
          WHERE e.id = ${eventId} AND e.classified_at IS NULL
        `;

        if (rows.length === 0) continue;
        const row = rows[0]!;

        const classification = await classifyEvent({
          event_id: row.id,
          raw_title: row.raw_title,
          raw_content: row.raw_content,
          source_name: row.source_name,
          source_url: row.raw_url,
        });

        if (classification) {
          await privilegedSql`
            UPDATE regulatory_event
            SET classification = ${JSON.stringify(classification)}::text::jsonb,
                classified_at = NOW()
            WHERE id = ${eventId}
          `;
          stats.classified++;
          console.log(
            `[backfill:classify]   Classified ${eventId}: ${classification.classification_kind}`,
          );
        }

        // Rate-limit: pause between API calls
        await sleep(500);
      } catch (err) {
        const msg = `Classification error for ${eventId}: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`[backfill:classify]   ${msg}`);
        stats.errors.push(msg);
      }
    }
  }

  /* ---- Orchestration -------------------------------------------- */

  const stats = emptyStats();
  const newEventIds: string[] = [];

  if (!flags.atoOnly) {
    const ids = await backfillAustlii(stats);
    newEventIds.push(...ids);
  }

  if (!flags.austliiOnly) {
    const ids = await backfillAto(stats);
    newEventIds.push(...ids);
  }

  if (flags.classify && !flags.dryRun) {
    await classifyNewEvents(newEventIds, flags.classifyLimit, stats);
  }

  console.log('\n[backfill] Summary:');
  console.log(JSON.stringify(stats, null, 2));

  // Clean up DB connections
  await privilegedSql.end();

  const exitCode = stats.errors.length > 0 ? 1 : 0;
  process.exit(exitCode);
}

/* ------------------------------------------------------------------ */
/*  Entry point guard — only runs when executed directly as CLI         */
/* ------------------------------------------------------------------ */

// Detect whether this module is the entry point. When imported by the
// test file, process.argv[1] will point at the test runner, not this
// file. The import.meta.url check is the standard ESM equivalent of
// `require.main === module`.
const isDirectRun =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectRun) {
  void main();
}
