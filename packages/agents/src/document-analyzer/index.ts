/**
 * Public surface of the document-analyzer module.
 *
 * Re-exports types + factory so consumers in `apps/api` can import via
 * the package boundary (`@cpa/agents`) rather than reaching into `src/`.
 * Mirrors the auto-allocator/index.ts pattern.
 */

export { makeDocumentAnalyzer } from './factory.js';
export type {
  AgentUsage,
  DocumentAnalyzer,
  DocumentAnalyzerInput,
  DocumentAnalyzerOutput,
  DocumentAnalyzerResult,
  ProposedActivityExtract,
  ProposedInvoiceExtract,
} from './types.js';
