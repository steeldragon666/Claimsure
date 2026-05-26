/**
 * @cpa/integrations-ip-australia
 *
 * Thin client over IP Australia's public Trade Mark Search and Patent
 * Search APIs. Wizard Step 2 uses this package to surface relevant
 * registered IP for a draft R&D claim.
 *
 * Public surface:
 *
 *   searchIpAustralia(query, opts?) → Promise<IpAustraliaResult[]>
 *
 * The function never throws plain `Error` — all failures are wrapped
 * in `IpAustraliaError` with a discriminated `code`. The package never
 * reads environment variables or persists credentials; the caller
 * supplies a bearer token through `opts.bearerToken`.
 */

import { quickSearch } from './client.js';
import { normalizeQuickSearch } from './normalize.js';
import type { IpAustraliaResult, IpAustraliaSearchOptions } from './types.js';

export type {
  IpAustraliaDataset,
  IpAustraliaErrorCode,
  IpAustraliaResult,
  IpAustraliaSearchOptions,
} from './types.js';
export { IpAustraliaError } from './types.js';
export { defaultBaseUrl } from './client.js';

/**
 * Search IP Australia and return normalised results.
 *
 * @param query  free-text search query (non-empty)
 * @param opts   dataset selector, auth token, and resilience knobs
 * @throws       `IpAustraliaError` on auth/network/parse failure
 */
export async function searchIpAustralia(
  query: string,
  opts: IpAustraliaSearchOptions = {},
): Promise<IpAustraliaResult[]> {
  const dataset = opts.dataset ?? 'trademark';
  const raw = await quickSearch(query, opts);
  return normalizeQuickSearch(raw, dataset);
}
