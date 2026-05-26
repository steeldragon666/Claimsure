/**
 * Normalized PubMed search result.
 *
 * Same shape (externalId / title / abstract / publishedAt / url /
 * relevanceScore) as the arXiv result type — the wizard step 2 search
 * UI merges results across providers, so callers want a single
 * normalized record they can render without per-provider branching.
 *
 * `externalId` is the PubMed PMID as a string (PubMed IDs are
 * numeric, but we keep them as strings so identifiers from different
 * providers can share a column without type confusion).
 *
 * `abstract` is `undefined` when ESummary did not return one. The
 * ESummary endpoint occasionally returns records without abstracts
 * (e.g. very old MEDLINE entries) — surface as `undefined` rather
 * than the empty string so downstream code can distinguish.
 *
 * `publishedAt` is an ISO-8601 date string parsed from PubMed's
 * `pubdate` (e.g. "2024 Jan 15", "2024 Jan", "2024"). We normalise to
 * UTC midnight on day 1 if month/day are missing.
 *
 * `relevanceScore` is `undefined` — ESearch returns results ordered
 * by relevance but does not expose a numeric score. We keep the
 * field on the type so the arXiv normaliser (which also has no score)
 * and any future scoring provider share the same shape.
 */
export type PubMedResult = {
  externalId: string;
  title: string;
  abstract?: string;
  publishedAt: string;
  url: string;
  relevanceScore?: number;
};

/**
 * Caller-supplied options for `searchPubMed`.
 *
 * `apiKey` is optional. Without a key, NCBI E-utilities limits each
 * IP to 3 requests/sec; with a key, 10/sec. Pass via function arg —
 * never read process.env inside the package (consistent with the
 * Deepgram client and the rest of integrations/).
 *
 * `maxResults` caps the number of PMIDs requested from ESearch (and
 * therefore the number of summaries fetched). Defaults to 20 to
 * match the arXiv default and keep the ESummary URL well under the
 * 2KB limit NCBI enforces on GET parameters.
 *
 * `baseUrl` overrides the E-utilities root for tests (nock).
 *
 * `signal` is an optional caller-supplied AbortSignal. When the caller
 * aborts, the in-flight retry loop is short-circuited and a
 * `PubMedError` with `code: 'timeout'` is thrown — matching the
 * convention of the sibling IP Australia client.
 *
 * `fetchImpl` overrides the global `fetch` for tests that exercise the
 * retry/timeout logic directly without nock (e.g. simulating a hung
 * upstream). Defaults to `globalThis.fetch`.
 */
export type SearchPubMedOptions = {
  apiKey?: string;
  maxResults?: number;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
};

/**
 * Discriminator for `PubMedError.code`.
 *
 * Matches the IP Australia (PR #84) precedent — same `code` field
 * shape so the API route layer can branch uniformly across providers.
 *
 * - `http_error`:     non-2xx, non-retryable (4xx other than 429).
 * - `rate_limited`:   429 — retried; surfaces this only if all
 *                     attempts return 429.
 * - `upstream_error`: 5xx — retried; surfaces this only if all
 *                     attempts return 5xx.
 * - `network_error`:  `fetch` threw (e.g. DNS, connection reset);
 *                     retried; surfaces this only if every attempt
 *                     threw.
 * - `timeout`:        per-attempt AbortController fired OR caller's
 *                     `opts.signal` aborted.
 * - `parse_error`:    JSON parse failed.
 */
export type PubMedErrorCode =
  | 'http_error'
  | 'rate_limited'
  | 'upstream_error'
  | 'network_error'
  | 'timeout'
  | 'parse_error';

/**
 * Typed error class thrown by `searchPubMed`. Callers can branch on
 * `code` without string-matching messages.
 */
export class PubMedError extends Error {
  public readonly code: PubMedErrorCode;
  public readonly statusCode: number | undefined;
  public readonly body: string | undefined;

  constructor(code: PubMedErrorCode, message: string, statusCode?: number, body?: string) {
    super(message);
    this.name = 'PubMedError';
    this.code = code;
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Subset of the ESearch JSON response we actually read.
 * Documented at:
 *   https://www.ncbi.nlm.nih.gov/books/NBK25500/
 *
 * Typed locally rather than via an SDK — the official Bio.Entrez
 * client is Python-only and the existing JS NPM wrappers are
 * abandoned. We only touch `esearchresult.idlist` and
 * `result[pmid].{title,pubdate}` so duplicating the slice keeps the
 * dependency footprint minimal (mirrors the Deepgram approach).
 */
export type ESearchResponse = {
  esearchresult: {
    idlist: string[];
    count?: string;
  };
};

/**
 * Subset of the ESummary v2.0 JSON response. NCBI returns
 * `result.uids` plus a per-PMID record under `result[pmid]`.
 *
 * `sortpubdate` is preferred over `pubdate` when present because it
 * is the parsed, machine-comparable date NCBI uses for ordering
 * (format "YYYY/MM/DD HH:MM"). We fall back to `pubdate` (free-form
 * "2024 Jan 15") when sortpubdate is absent.
 */
export type ESummaryRecord = {
  uid: string;
  title?: string;
  pubdate?: string;
  sortpubdate?: string;
};

export type ESummaryResponse = {
  result: {
    uids: string[];
    [pmid: string]: ESummaryRecord | string[];
  };
};
