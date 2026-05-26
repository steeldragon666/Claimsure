/**
 * Wizard Step 2 Task 03 — Semantic Scholar integration barrel.
 *
 * Subpath: `@cpa/integrations/semantic-scholar`.
 *
 * Public surface:
 *   - {@link searchSemanticScholar}         search by free-text query.
 *   - {@link SemanticScholarResult}         normalised result shape.
 *   - {@link SemanticScholarError}          typed error class.
 *   - {@link SemanticScholarErrorKind}      discriminator union.
 *   - {@link SearchSemanticScholarOptions}  call-site options.
 */
export { searchSemanticScholar } from './client.js';
export {
  SemanticScholarError,
  type SemanticScholarResult,
  type SemanticScholarErrorKind,
  type SearchSemanticScholarOptions,
} from './types.js';
