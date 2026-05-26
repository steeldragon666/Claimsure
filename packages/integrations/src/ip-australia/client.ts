/**
 * IP Australia Search API client.
 *
 * ## Chosen endpoint
 *
 * Trade marks (default):
 *   `POST https://production.api.ipaustralia.gov.au/public/australian-trade-mark-search-api/v1/search/quick`
 *
 * Patents:
 *   `POST https://production.api.ipaustralia.gov.au/public/australian-patent-search-api/v1/search/quick`
 *
 * ## Reasoning
 *
 * IP Australia publish a small family of REST APIs through their developer
 * portal (https://portal.api.ipaustralia.gov.au/). The two relevant for
 * our wizard step are the Australian Trade Mark Search API and the
 * Australian Patent Search API. Both expose a `/search/quick` POST
 * endpoint that accepts a free-text `query` plus optional filters/sort,
 * and returns JSON. The schema is documented at:
 *
 *   https://descriptions.api.gov.au/ipaustralia/trademark-search/iptms.html
 *
 * Authentication is OAuth2 client-credentials: callers exchange an API
 * key + secret at the External Token API for a short-lived bearer
 * token, then pass it on every request. This package treats the token
 * as an injected dependency (see `IpAustraliaSearchOptions.bearerToken`)
 * — it does NOT read env vars, mint tokens, or cache credentials. That
 * keeps secret handling out of this layer.
 *
 * Both endpoints are preferred over the older IP Government Open Data
 * (IPGOD) bulk CSV dumps because:
 *   1. IPGOD is a yearly snapshot — unsuitable for a live wizard.
 *   2. The REST APIs return per-record metadata in a stable JSON shape.
 *   3. The same code path works for both trade marks and patents with
 *      only a base-URL swap.
 *
 * ## Resilience
 *
 * - 30s timeout per attempt via AbortController.
 * - 2 retries (3 total attempts) with exponential backoff
 *   (1s, 2s) on network errors, 5xx, and 429.
 * - 4xx other than 429 → not retried (deterministic failures).
 * - All errors are thrown as typed `IpAustraliaError` with a `code`
 *   field so callers can branch without string-matching messages.
 */

import {
  IpAustraliaError,
  type IpAustraliaDataset,
  type IpAustraliaSearchOptions,
} from './types.js';

/** Default production base URL for the Trade Mark Search API. */
const TRADEMARK_BASE_URL =
  'https://production.api.ipaustralia.gov.au/public/australian-trade-mark-search-api/v1';

/** Default production base URL for the Patent Search API. */
const PATENT_BASE_URL =
  'https://production.api.ipaustralia.gov.au/public/australian-patent-search-api/v1';

/** Quick-search path, shared by both APIs. */
const QUICK_SEARCH_PATH = '/search/quick';

/** Default per-attempt timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default number of retry attempts (in addition to the initial attempt). */
const DEFAULT_MAX_RETRIES = 2;

/** Base backoff in ms; doubles each retry: 1000, 2000. */
const BASE_BACKOFF_MS = 1_000;

/** Identifies this client to the upstream API. */
const USER_AGENT = 'cpa-platform/integrations-ip-australia (+https://claimsure.com.au/contact)';

/**
 * Resolve the default production base URL for the requested dataset.
 */
export function defaultBaseUrl(dataset: IpAustraliaDataset): string {
  return dataset === 'patent' ? PATENT_BASE_URL : TRADEMARK_BASE_URL;
}

/**
 * Raw shape passed to the upstream `/search/quick` endpoint.
 * Documented at https://descriptions.api.gov.au/ipaustralia/trademark-search/iptms.html.
 *
 * Only `query` is universally required; the rest are forwarded if the
 * caller supplies them.
 */
interface QuickSearchRequestBody {
  query: string;
  changedSinceDate?: string;
}

/**
 * Execute a `/search/quick` POST against the chosen IP Australia API
 * and return the parsed JSON body. Throws `IpAustraliaError` on any
 * failure that survives the retry policy.
 *
 * The return type is `unknown` because IP Australia do not publish a
 * machine-readable response schema; normalisation happens in
 * `normalize.ts` which tolerates field-level shape drift.
 */
export async function quickSearch(
  query: string,
  options: IpAustraliaSearchOptions = {},
): Promise<unknown> {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new IpAustraliaError('bad_request', 'query must be a non-empty string');
  }

  const dataset: IpAustraliaDataset = options.dataset ?? 'trademark';
  const baseUrl = options.baseUrl ?? defaultBaseUrl(dataset);
  const url = `${baseUrl}${QUICK_SEARCH_PATH}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const body: QuickSearchRequestBody = { query };
  if (options.changedSinceDate !== undefined) {
    body.changedSinceDate = options.changedSinceDate;
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (options.bearerToken !== undefined && options.bearerToken !== '') {
    headers.Authorization = `Bearer ${options.bearerToken}`;
  }

  const totalAttempts = maxRetries + 1;
  let lastError: IpAustraliaError | undefined;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const aborted = controller.signal.aborted;
      const code = aborted ? 'timeout' : 'network_error';
      const msg =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'fetch failed';
      lastError = new IpAustraliaError(
        code,
        `${aborted ? 'timed out' : 'network error'} on attempt ${attempt}/${totalAttempts}: ${msg}`,
        { attempts: attempt, cause: err },
      );
      if (attempt < totalAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }
    clearTimeout(timeoutId);

    // Success path
    if (response.ok) {
      try {
        return await response.json();
      } catch (err) {
        throw new IpAustraliaError('parse_error', 'upstream returned malformed JSON', {
          status: response.status,
          attempts: attempt,
          cause: err,
        });
      }
    }

    // Auth failures — not retryable
    if (response.status === 401 || response.status === 403) {
      throw new IpAustraliaError(
        'auth_error',
        `IP Australia rejected credentials (HTTP ${response.status})`,
        { status: response.status, attempts: attempt },
      );
    }

    // 404 — endpoint missing or record set empty; not retryable
    if (response.status === 404) {
      throw new IpAustraliaError('not_found', `endpoint not found (HTTP 404): ${url}`, {
        status: response.status,
        attempts: attempt,
      });
    }

    // 429 — rate limited; retry with backoff
    if (response.status === 429) {
      lastError = new IpAustraliaError(
        'rate_limited',
        `rate limited by IP Australia on attempt ${attempt}/${totalAttempts}`,
        { status: response.status, attempts: attempt },
      );
      if (attempt < totalAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    // 4xx other than the above — not retryable
    if (response.status >= 400 && response.status < 500) {
      throw new IpAustraliaError(
        'bad_request',
        `IP Australia rejected request (HTTP ${response.status})`,
        { status: response.status, attempts: attempt },
      );
    }

    // 5xx — retry with backoff
    if (response.status >= 500) {
      lastError = new IpAustraliaError(
        'upstream_error',
        `IP Australia returned HTTP ${response.status} on attempt ${attempt}/${totalAttempts}`,
        { status: response.status, attempts: attempt },
      );
      if (attempt < totalAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    // 3xx or other unexpected — shouldn't happen with POST; treat as upstream error
    throw new IpAustraliaError(
      'upstream_error',
      `unexpected HTTP status ${response.status} from ${url}`,
      { status: response.status, attempts: attempt },
    );
  }

  // Unreachable — the loop either returns or throws on every attempt —
  // but TypeScript's control-flow analysis can't see that.
  throw lastError ?? new IpAustraliaError('upstream_error', 'exhausted retries with no response');
}

function backoffMs(attempt: number): number {
  // attempt is 1-indexed; first retry waits BASE_BACKOFF_MS, second waits 2x.
  return BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
