#!/usr/bin/env tsx
/**
 * One-off script: re-classify all events for a tenant through the
 * currently-configured classifier (haiku, in dev with key set).
 *
 * Use case: events created when CLASSIFIER_IMPL=stub get tagged as
 * SUPPORTING/0.5. Once the real Haiku classifier is wired up, this
 * script back-fills them with real classifications.
 *
 * Reads CLASSIFIER_IMPL + ANTHROPIC_API_KEY from .env (force-loaded
 * by ../../apps/api/src/force-env.ts at the API layer; this script
 * uses Node's --env-file-if-exists which has the same shell-leak
 * problem, so we replicate the override-from-file logic inline).
 *
 * Usage:
 *   pnpm exec tsx --env-file-if-exists=../../.env reclassify-events.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeClassifier } from '@cpa/agents/classifier';
import { privilegedSql } from '@cpa/db/client';

// Force-load .env (override any shell-leaked empty values)
for (const p of [path.resolve(process.cwd(), '../../.env'), path.resolve(process.cwd(), '.env')]) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  break;
}

const TARGET_TENANT_ID = '00000000-0000-0000-0000-000000000010';

interface EventRow {
  id: string;
  payload: { raw_text?: string; source?: string };
  current_kind: string;
  current_confidence: number | null;
}

async function main(): Promise<void> {
  const classifier = makeClassifier();

  console.log(`Classifier: ${process.env['CLASSIFIER_IMPL'] ?? 'stub'}`);
  console.log(`Anthropic key set: ${process.env['ANTHROPIC_API_KEY'] ? 'yes' : 'no'}`);
  console.log('');

  const events = await privilegedSql<EventRow[]>`
    SELECT
      id,
      payload,
      kind AS current_kind,
      (classification->>'confidence')::float AS current_confidence
    FROM event
    WHERE tenant_id = ${TARGET_TENANT_ID}
      AND override_of_event_id IS NULL
      AND payload->>'raw_text' IS NOT NULL
    ORDER BY captured_at DESC
  `;

  console.log(`Found ${events.length} classifiable events for tenant ${TARGET_TENANT_ID}`);
  console.log('');

  let okCount = 0;
  let unchangedCount = 0;
  let errCount = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    const rawText = ev.payload.raw_text ?? '';
    if (!rawText) continue;

    const before = `${ev.current_kind}/${ev.current_confidence ?? '–'}`;
    process.stdout.write(`[${i + 1}/${events.length}] ${ev.id.slice(0, 8)}  was: ${before}  →  `);

    try {
      // ClassifierInput is intentionally minimal — just `raw_text`. The
      // event's captured_at lives in the chain row, not the classifier
      // payload; passing it here would be ignored and now fails strict
      // type-checking (the property was removed from ClassifierInput).
      const result = await classifier.classify({ raw_text: rawText });
      // result is the canonical Classification shape: { kind, confidence, rationale, ... }
      const after = `${result.kind}/${result.confidence.toFixed(2)}`;
      const changed =
        result.kind !== ev.current_kind ||
        Math.abs((result.confidence ?? 0) - (ev.current_confidence ?? 0)) > 0.01;

      if (changed) {
        await privilegedSql`
          UPDATE event
             SET kind = ${result.kind},
                 classification = ${privilegedSql.json(result)}
           WHERE id = ${ev.id}
        `;
        process.stdout.write(`now: ${after}  ✓\n`);
        okCount++;
      } else {
        process.stdout.write(`unchanged\n`);
        unchangedCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`ERROR: ${msg.slice(0, 80)}\n`);
      errCount++;
    }
  }

  console.log('');
  console.log(`Reclassified: ${okCount}, unchanged: ${unchangedCount}, errors: ${errCount}`);

  await privilegedSql.end();
  process.exit(errCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
