/**
 * `@cpa/agents/multi-entity-similarity` barrel.
 *
 * Re-exports the pairwise similarity scanner, corpus loader, prompt module,
 * and Zod output schema. The side-effect import at the bottom registers
 * `multi-entity-similarity@1.0.0` in the runtime prompt registry.
 */

export {
  runPairwiseScan,
  generateOrderedPairs,
  type ScanInput,
  type ScanResult,
  type Activity,
} from './scorer.js';
export { loadHistoricalRejections, type HistoricalRejection } from './corpus-loader.js';
export {
  MultiEntitySimilarityScan,
  SYSTEM_PROMPT as MULTI_ENTITY_SIMILARITY_SYSTEM_PROMPT,
} from './prompts/multi-entity-similarity@1.0.0.js';

// Side-effect import: registers `multi-entity-similarity@1.0.0` in the
// runtime prompt registry. Mirrors the pattern in
// `suggestion-evaluator/index.ts` and `multi-cycle/index.ts`.
import './prompts/multi-entity-similarity@1.0.0.js';
