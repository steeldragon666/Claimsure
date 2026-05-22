#!/usr/bin/env tsx
/**
 * Eval driver — classify every text-paste event in the bulk-claims
 * c0a2* tenant namespace through the currently-configured Classifier
 * (haiku if ANTHROPIC_API_KEY is set + CLASSIFIER_IMPL=haiku;
 * deterministic stub otherwise) and write the result into
 * `event.classification`.
 *
 *   pnpm exec tsx --env-file=../../.env eval-bulk-classify.ts [--concurrency=8]
 *
 * Why this exists rather than re-using reclassify-events.ts:
 *   - reclassify-events.ts is hard-coded to one tenant id; bulk eval
 *     needs all 10 c0a2* tenants in a single pass.
 *   - reclassify-events.ts also UPDATEs the `kind` column, which would
 *     break the chain hash on every touched event (kind is in the
 *     canonical bytes). For the eval we want to leave kind alone — the
 *     seed's heuristic kind is the chain anchor — and only populate the
 *     `classification` jsonb. The scorer reads classification->>'kind',
 *     not event.kind, so that's enough to grade Agent A against the
 *     rd_band_hint ground truth.
 *
 * After this script finishes, run `score-bulk-claims.ts` for the
 * per-claim + aggregate accuracy report.
 */
import { parseArgs } from 'node:util';
import { makeClassifier } from '@cpa/agents/classifier';
import { privilegedSql, sql } from '@cpa/db/client';

const { values } = parseArgs({
  options: {
    concurrency: { type: 'string', default: '8' },
    tenant: { type: 'string' }, // optional: scope to one tenant
  },
});
const CONCURRENCY = Math.max(1, Math.min(64, Number(values.concurrency ?? '8') || 8));
const TENANT_FILTER = values.tenant; // when set, only that tenant runs

interface EventRow {
  id: string;
  tenant_id: string;
  raw_text: string;
}

async function loadEvents(): Promise<EventRow[]> {
  if (TENANT_FILTER) {
    return await privilegedSql<EventRow[]>`
      SELECT id::text, tenant_id::text, payload->>'raw_text' AS raw_text
      FROM event
      WHERE tenant_id = ${TENANT_FILTER}
        AND payload ? 'raw_text'
        AND payload->>'raw_text' IS NOT NULL
        AND classification IS NULL
    `;
  }
  return await privilegedSql<EventRow[]>`
    SELECT id::text, tenant_id::text, payload->>'raw_text' AS raw_text
    FROM event
    WHERE tenant_id::text LIKE '00000000-0000-4000-8000-c0a2%'
      AND payload ? 'raw_text'
      AND payload->>'raw_text' IS NOT NULL
      AND classification IS NULL
  `;
}

async function processOne(
  classifier: ReturnType<typeof makeClassifier>,
  ev: EventRow,
): Promise<{ id: string; kind: string } | { id: string; err: string }> {
  try {
    const result = await classifier.classify({ raw_text: ev.raw_text });
    await privilegedSql`
      UPDATE event
         SET classification = ${JSON.stringify(result)}::text::jsonb
       WHERE id = ${ev.id}
    `;
    return { id: ev.id, kind: result.kind };
  } catch (err) {
    return {
      id: ev.id,
      err: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
    };
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  onResult: (r: R, i: number) => void,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i]!;
      const r = await fn(item, i);
      onResult(r, i);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const impl = process.env['CLASSIFIER_IMPL'] ?? 'stub';
  const keySet = Boolean(process.env['ANTHROPIC_API_KEY']);
  process.stdout.write(
    `Eval classifier: impl=${impl}  ANTHROPIC_API_KEY=${keySet ? 'set' : 'unset'}  concurrency=${CONCURRENCY}\n`,
  );
  if (TENANT_FILTER) process.stdout.write(`Tenant filter: ${TENANT_FILTER}\n`);

  const classifier = makeClassifier();
  const events = await loadEvents();
  process.stdout.write(`Found ${events.length} unclassified text events\n\n`);
  if (events.length === 0) {
    process.stdout.write(
      'Nothing to do. (If a prior run already classified everything, run the seed first to reset.)\n',
    );
    return;
  }

  const t0 = Date.now();
  const kindTally: Record<string, number> = {};
  let okCount = 0;
  let errCount = 0;
  let lastReport = Date.now();

  await runWithConcurrency(
    events,
    CONCURRENCY,
    (ev) => processOne(classifier, ev),
    (r) => {
      if ('err' in r) {
        errCount += 1;
        process.stderr.write(`  ERR ${r.id.slice(0, 8)}  ${r.err}\n`);
      } else {
        okCount += 1;
        kindTally[r.kind] = (kindTally[r.kind] ?? 0) + 1;
      }
      // Progress every 1s
      if (Date.now() - lastReport > 1000) {
        const done = okCount + errCount;
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = ((events.length - done) / Math.max(rate, 0.01)).toFixed(0);
        process.stdout.write(
          `  progress ${done}/${events.length}  ok=${okCount}  err=${errCount}  ${rate.toFixed(1)}/s  eta ${eta}s\n`,
        );
        lastReport = Date.now();
      }
    },
  );

  const elapsed = (Date.now() - t0) / 1000;
  process.stdout.write(
    `\nDone in ${elapsed.toFixed(1)}s · ${okCount} classified · ${errCount} errors\n`,
  );
  const kinds = Object.entries(kindTally).sort((a, b) => b[1] - a[1]);
  process.stdout.write('Kind distribution:\n');
  for (const [k, v] of kinds) {
    process.stdout.write(`  ${k.padEnd(28)} ${v}\n`);
  }
}

main()
  .then(async () => {
    await sql.end();
    await privilegedSql.end();
    process.exit(0);
  })
  .catch(async (err) => {
    process.stderr.write(
      `FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    try {
      await sql.end();
      await privilegedSql.end();
    } catch {
      // best-effort
    }
    process.exit(2);
  });
