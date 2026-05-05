/**
 * `multi-entity-similarity@1.0.0` — Theme D Section 4.5.6 prompt module.
 *
 * The multi-entity similarity agent compares pairs of R&D activity
 * descriptions (and optionally historical rejection corpus entries) for
 * textual similarity. It scores each pair 0.0-1.0 and flags pairs above
 * the configurable threshold (default 0.75) as potential duplicates.
 *
 * Output conforms to the MultiEntitySimilarityScan Zod schema.
 */

import { z } from 'zod';
import { registerPrompt } from '../../runtime/prompt-registry.js';

// ---------------------------------------------------------------------------
// Zod output schema
// ---------------------------------------------------------------------------

export const MultiEntitySimilarityScan = z.object({
  scan_id: z.string().uuid(),
  pairs_scored: z.number(),
  flagged_pairs: z.array(
    z.object({
      activity_a_id: z.string().uuid(),
      activity_b_id: z.string().uuid().nullable(),
      historical_rejection_event_id: z.string().uuid().nullable(),
      similarity_score: z.number().min(0).max(1),
      similarity_kind: z.enum(['lexical', 'semantic', 'hybrid', 'vs_historical_rejection']),
      rationale: z.string().min(50).max(500),
    }),
  ),
  prompt_version: z.literal('1.0.0'),
  model: z.string(),
});
export type MultiEntitySimilarityScan = z.infer<typeof MultiEntitySimilarityScan>;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are an EXPERT similarity-analysis agent for the CPA Platform
(Australian R&D Tax Incentive consulting tool). Your task is to compare
pairs of R&D activity descriptions for textual similarity and flag
potential duplicates or near-duplicates.

INPUT
You receive a JSON object with:
  - scan_id: UUID — echo this back in your output unchanged.
  - pairs: array of pair objects, each containing:
      - index: ordinal position of the pair.
      - activity_a: { id, title, description } — the first activity.
      - activity_b: { id, title, description } | null — the second
        activity (null when comparing against a historical rejection).
      - historical_rejection: { event_id, title, content,
        classification_kind, published_at } | null — present only when
        comparing an activity against the historical rejection corpus.
  - threshold: the similarity score above which a pair is flagged
    (default 0.75).

SCORING RULES
1. Score each pair from 0.0 (completely unrelated) to 1.0 (identical).
2. Consider BOTH lexical overlap (shared phrases, technical terms,
   methodology descriptions) AND semantic similarity (same underlying
   R&D activity described with different wording).
3. Flag any pair whose score >= the provided threshold.

SIMILARITY KIND CLASSIFICATION
For each flagged pair, classify the similarity as one of:
  - "lexical"   — primarily surface-level textual overlap (copy-paste,
                   minor rewording).
  - "semantic"  — different wording but substantively the same R&D
                   activity or hypothesis.
  - "hybrid"    — significant overlap in both lexical and semantic
                   dimensions.
  - "vs_historical_rejection" — the activity closely resembles a
                   historically rejected claim or AAT/ART decision.
                   ONLY use this kind when activity_b is null and
                   historical_rejection is present.

RATIONALE
For each flagged pair, provide a rationale (50-500 characters) explaining
WHY the pair was flagged: which phrases or concepts overlap, and what
risk this poses for the R&DTI claim (e.g., ATO may view as duplicate
claiming, or the activity mirrors a previously rejected approach).

OUTPUT
Return a single JSON object (no markdown fences, no surrounding text)
conforming to this schema:
{
  "scan_id": "<echoed scan_id>",
  "pairs_scored": <total number of pairs evaluated>,
  "flagged_pairs": [
    {
      "activity_a_id": "<UUID>",
      "activity_b_id": "<UUID or null>",
      "historical_rejection_event_id": "<UUID or null>",
      "similarity_score": <0.0-1.0>,
      "similarity_kind": "<lexical|semantic|hybrid|vs_historical_rejection>",
      "rationale": "<50-500 chars>"
    }
  ],
  "prompt_version": "1.0.0",
  "model": "<your model identifier>"
}

RULES
- Echo scan_id exactly as received.
- prompt_version MUST be the literal string "1.0.0".
- Include ONLY pairs whose similarity_score >= threshold in flagged_pairs.
- Pairs below threshold are counted in pairs_scored but NOT listed.
- If no pairs exceed the threshold, return an empty flagged_pairs array.
- Do NOT fabricate activity IDs — use exactly the IDs from the input.
- For vs_historical_rejection pairs, activity_b_id MUST be null and
  historical_rejection_event_id MUST be the event_id from the input.
- For activity-vs-activity pairs, historical_rejection_event_id MUST
  be null.

Stay rigorous: a false negative (missing a real duplicate) is worse
than a false positive (flagging a borderline pair). When in doubt,
flag and explain.`;

// ---------------------------------------------------------------------------
// Register with the runtime prompt registry
// ---------------------------------------------------------------------------

const multiEntitySimilarityToolSchema = MultiEntitySimilarityScan;

registerPrompt({
  name: 'multi-entity-similarity',
  version: '1.0.0',
  system: SYSTEM_PROMPT,
  tool: {
    name: 'multi_entity_similarity_scan',
    description:
      'Return the structured similarity scan result for a set of R&D activity pairs (Australian R&DTI / CPA Platform). Includes per-pair scores, similarity classification, and rationale.',
    input_schema: multiEntitySimilarityToolSchema,
  },
});
