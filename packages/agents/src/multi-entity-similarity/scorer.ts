import crypto from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { sql as defaultSql } from '@cpa/db/client';
import { getAnthropicClient } from '../runtime/anthropic-client.js';
import {
  SYSTEM_PROMPT,
  MultiEntitySimilarityScan,
} from './prompts/multi-entity-similarity@1.0.0.js';
import { loadHistoricalRejections, type HistoricalRejection } from './corpus-loader.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250514';
const MAX_TOKENS = 4096;
const P7_SIMILARITY_FLAG_THRESHOLD = 0.75;

export interface Activity {
  id: string;
  title: string;
  description: string | null;
  tenant_id: string;
}

/**
 * Minimal shape of a postgres-js tagged-template executor. The real `sql`
 * import from `@cpa/db/client` satisfies this; tests can pass a stub.
 */
export type SimilaritySqlExecutor = <T>(
  template: TemplateStringsArray,
  ...values: unknown[]
) => Promise<readonly T[]>;

export interface ScanInput {
  tenantId: string;
  subjectTenantId: string;
  anthropic?: Anthropic;
  model?: string;
  /** DI seam for the SQL client -- tests inject a stub executor. */
  executor?: SimilaritySqlExecutor;
}

export interface ScanResult {
  scan_id: string;
  pairs_scored: number;
  flagged_count: number;
  persisted_count: number;
}

/**
 * Generate all unique ordered pairs from a list of activities.
 * Ordering is enforced by UUID comparison (a.id < b.id).
 */
export function generateOrderedPairs(activities: Activity[]): { a: Activity; b: Activity }[] {
  const pairs: { a: Activity; b: Activity }[] = [];
  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      const [a, b] =
        activities[i]!.id < activities[j]!.id
          ? [activities[i]!, activities[j]!]
          : [activities[j]!, activities[i]!];
      pairs.push({ a, b });
    }
  }
  return pairs;
}

/**
 * Run a pairwise similarity scan across all activities for the given
 * subject entity group. Persists flagged pairs to multi_entity_similarity_score.
 */
export async function runPairwiseScan(input: ScanInput): Promise<ScanResult> {
  const {
    tenantId,
    subjectTenantId,
    model = DEFAULT_MODEL,
    executor = defaultSql as unknown as SimilaritySqlExecutor,
  } = input;
  const anthropic = input.anthropic ?? getAnthropicClient();
  const scanId = crypto.randomUUID();

  // 1. Load activities for the subject
  const activities = await executor<Activity>`
    SELECT a.id, a.title, nd.content AS description, a.tenant_id
    FROM activity a
    JOIN claim c ON c.id = a.claim_id
    LEFT JOIN narrative_draft nd ON nd.activity_id = a.id
    WHERE c.subject_tenant_id = ${subjectTenantId}
      AND a.tenant_id = ${tenantId}
  `;

  if (activities.length < 2) {
    return {
      scan_id: scanId,
      pairs_scored: 0,
      flagged_count: 0,
      persisted_count: 0,
    };
  }

  // 2. Load historical rejection corpus
  const rejections = await loadHistoricalRejections(tenantId, executor);

  // 3. Generate ordered pairs (a.id < b.id)
  const mutableActivities = [...activities];
  const activityPairs = generateOrderedPairs(mutableActivities);

  // 3b. Build combined pair list including historical rejection comparisons
  const allPairs: {
    a: Activity;
    b: Activity | null;
    rejectionEventId?: string;
  }[] = activityPairs.map((p) => ({ a: p.a, b: p.b }));

  for (const activity of mutableActivities) {
    for (const rejection of rejections) {
      allPairs.push({ a: activity, b: null, rejectionEventId: rejection.event_id });
    }
  }

  // 4. Call model with all pairs in a single prompt
  const userMessage = JSON.stringify(
    {
      scan_id: scanId,
      pairs: allPairs.map((p, idx) => ({
        index: idx,
        activity_a: {
          id: p.a.id,
          title: p.a.title,
          description: p.a.description,
        },
        activity_b: p.b ? { id: p.b.id, title: p.b.title, description: p.b.description } : null,
        historical_rejection: p.rejectionEventId
          ? rejections.find((r: HistoricalRejection) => r.event_id === p.rejectionEventId)
          : null,
      })),
      threshold: P7_SIMILARITY_FLAG_THRESHOLD,
    },
    null,
    2,
  );

  const response = await anthropic.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  // 5. Parse response
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return {
      scan_id: scanId,
      pairs_scored: allPairs.length,
      flagged_count: 0,
      persisted_count: 0,
    };
  }

  // Extract JSON from response text (may be wrapped in markdown code block)
  let jsonStr = textBlock.text;
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1]!;

  const parsed = MultiEntitySimilarityScan.safeParse(JSON.parse(jsonStr));
  if (!parsed.success) {
    return {
      scan_id: scanId,
      pairs_scored: allPairs.length,
      flagged_count: 0,
      persisted_count: 0,
    };
  }

  const scan = parsed.data;

  // 6. Persist flagged pairs above threshold
  let persisted = 0;
  for (const pair of scan.flagged_pairs) {
    if (pair.similarity_score >= P7_SIMILARITY_FLAG_THRESHOLD) {
      await executor`
        INSERT INTO multi_entity_similarity_score (
          id, tenant_id, activity_a_id, activity_b_id,
          similarity_score, similarity_kind
        )
        VALUES (
          ${crypto.randomUUID()}, ${tenantId},
          ${pair.activity_a_id}, ${pair.activity_b_id},
          ${pair.similarity_score}, ${pair.similarity_kind}
        )
        ON CONFLICT DO NOTHING
      `;
      persisted++;
    }
  }

  return {
    scan_id: scanId,
    pairs_scored: scan.pairs_scored,
    flagged_count: scan.flagged_pairs.length,
    persisted_count: persisted,
  };
}
