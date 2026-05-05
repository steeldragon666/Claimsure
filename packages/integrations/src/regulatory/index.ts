/**
 * P7 Theme D Task D.9 — Regulatory intelligence feed barrel export.
 *
 * Subpath: `@cpa/integrations/regulatory`
 */
export type {
  ISourceConnector,
  RawRegulatoryEvent,
  RegulatorySourceRow,
} from './source-connector.js';
export { registerConnector, getConnector, registeredKinds } from './connector-factory.js';
export { classifyError } from './error-classifier.js';
export { runDailyScrape, type ScrapeResult } from './scrape-orchestrator.js';
