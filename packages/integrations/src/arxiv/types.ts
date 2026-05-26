/**
 * Normalized arXiv search result.
 *
 * Shape mirrors PubMedResult so the wizard step 2 search UI can
 * merge results across providers without per-provider branching.
 *
 * `externalId` is the arXiv paper ID stripped of the `http://arxiv.org/abs/`
 * prefix and version suffix - e.g. "2401.12345" rather than
 * "http://arxiv.org/abs/2401.12345v2". The stable identifier
 * shared across paper versions; UI can link to /abs/<id> to get
 * the latest version.
 *
 * `abstract` always present from arXiv (the Atom `<summary>` element
 * is required by arXiv's API). Whitespace-normalised - arXiv pads
 * abstracts with newlines/spaces for visual wrap in their XML.
 *
 * `publishedAt` is the arXiv `<published>` ISO-8601 timestamp
 * (already in that format from the upstream Atom feed - we pass it
 * through verbatim).
 *
 * `relevanceScore` is `undefined` - the arXiv API does not return
 * a score; results are ordered by the requested `sortBy` (default
 * relevance) but no numeric ranking is exposed.
 */
export type ArxivResult = {
  externalId: string;
  title: string;
  abstract?: string;
  publishedAt: string;
  url: string;
  relevanceScore?: number;
};

/**
 * Caller-supplied options for `searchArxiv`.
 *
 * arXiv has no API key concept - rate is enforced by IP and capped
 * at 1 req per 3 seconds. The package itself does not throttle;
 * callers wrap in `runtime/rate-limit` if they batch many queries.
 *
 * `maxResults` defaults to 20 to match the PubMed default. The
 * upstream cap is 30,000 per request but realistic usage is page-
 * sized.
 *
 * `baseUrl` overrides the API root for tests (nock).
 *
 * `signal` is an optional caller-supplied AbortSignal. When the caller
 * aborts, the in-flight retry loop is short-circuited and an
 * `ArxivError` with `code: 'timeout'` is thrown.
 *
 * `fetchImpl` overrides the global `fetch` for tests that exercise the
 * retry/timeout logic directly without nock. Defaults to
 * `globalThis.fetch`.
 */
export type SearchArxivOptions = {
  maxResults?: number;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
};

/**
 * Discriminator for `ArxivError.code`. Mirrors the PubMed and IP
 * Australia (PR #84) error-code shape so the API route layer can
 * branch uniformly across providers.
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
 * - `parse_error`:    XML parse failed.
 */
export type ArxivErrorCode =
  | 'http_error'
  | 'rate_limited'
  | 'upstream_error'
  | 'network_error'
  | 'timeout'
  | 'parse_error';

/**
 * Typed error class thrown by `searchArxiv`. Callers can branch on
 * `code` without string-matching messages.
 */
export class ArxivError extends Error {
  public readonly code: ArxivErrorCode;
  public readonly statusCode: number | undefined;
  public readonly body: string | undefined;

  constructor(code: ArxivErrorCode, message: string, statusCode?: number, body?: string) {
    super(message);
    this.name = 'ArxivError';
    this.code = code;
    this.statusCode = statusCode;
    this.body = body;
  }
}
