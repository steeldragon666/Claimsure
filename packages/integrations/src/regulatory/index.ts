/**
 * P7 Theme D Task D.9 — Regulatory intelligence feed barrel export.
 *
 * Subpath: `@cpa/integrations/regulatory`
 */

// Register all connectors (side-effect imports)
import './connectors/index.js';

export type {
  ISourceConnector,
  RawRegulatoryEvent,
  RegulatorySourceRow,
} from './source-connector.js';
export { registerConnector, getConnector, registeredKinds } from './connector-factory.js';
export { classifyError } from './error-classifier.js';
export { runDailyScrape, type ScrapeResult } from './scrape-orchestrator.js';
export {
  dispatchClassifiedEvent,
  type DispatchInput,
  type DispatchResult,
} from './webhook-dispatch.js';
export { parseAustliiDecisions } from './connectors/austlii-html.js';
export { parseRssItems } from './connectors/ato-rss.js';
