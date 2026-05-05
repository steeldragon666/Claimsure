/**
 * `@cpa/agents/regulatory-classifier` barrel.
 *
 * Re-exports the classifier function, input/output types, prompt module,
 * and Zod output schema. The side-effect import at the bottom registers
 * `regulatory-classify@1.0.0` in the runtime prompt registry.
 */

export { classifyEvent, type ClassifyOptions } from './classifier.js';
export type { ClassifyEventInput, RegulatoryClassificationType } from './types.js';
export {
  RegulatoryClassification,
  SYSTEM_PROMPT as REGULATORY_CLASSIFY_SYSTEM_PROMPT,
} from './prompts/regulatory-classify@1.0.0.js';

// Side-effect import: registers `regulatory-classify@1.0.0` in the
// runtime prompt registry. Mirrors the pattern in
// `multi-entity-similarity/index.ts` and `suggestion-evaluator/index.ts`.
import './prompts/regulatory-classify@1.0.0.js';
