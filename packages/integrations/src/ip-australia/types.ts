/**
 * Public types for @cpa/integrations-ip-australia.
 *
 * The package exposes a single high-level call: `searchIpAustralia(query, opts?)`
 * which returns a list of normalised IP records. Internally it can hit
 * either the Trade Mark Search API or the Patent Search API; both produce
 * the same normalised shape.
 */

/**
 * Which IP Australia dataset to query.
 *
 * - `trademark` (default): Australian Trade Mark Search API
 * - `patent`:              Australian Patent Search API
 */
export type IpAustraliaDataset = 'trademark' | 'patent';

/**
 * Options accepted by `searchIpAustralia`.
 *
 * Authentication is the caller's responsibility — IP Australia's APIs
 * require an OAuth2 bearer token obtained from their External Token API.
 * Tokens are short-lived and tenant-scoped; this package deliberately
 * does NOT cache, mint, or read credentials from the environment.
 */
export interface IpAustraliaSearchOptions {
  /**
   * Which dataset to query. Defaults to `'trademark'`.
   */
  dataset?: IpAustraliaDataset;

  /**
   * OAuth2 bearer token (without the `Bearer ` prefix).
   *
   * Required for production use. If omitted, the request is sent without
   * an Authorization header — useful only for fixture/mock testing.
   */
  bearerToken?: string;

  /**
   * Override the base URL (e.g. to target the test environment or a
   * local mock). Defaults to the production base URL for the chosen
   * dataset. Should NOT include the endpoint path or trailing slash.
   */
  baseUrl?: string;

  /**
   * Per-request timeout in milliseconds. Defaults to 30_000 (30s).
   */
  timeoutMs?: number;

  /**
   * Maximum number of retry attempts on transient failure
   * (network errors, 5xx, 429). Defaults to 2 retries
   * (3 total attempts).
   */
  maxRetries?: number;

  /**
   * Filter trade marks/patents updated since this ISO-8601 date.
   * Passed through as `changedSinceDate` in the request body.
   */
  changedSinceDate?: string;

  /**
   * Optional `fetch` override for tests. Defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Normalised IP Australia search result.
 *
 * Field semantics:
 * - `externalId`:   stable upstream identifier (trade mark number or
 *                   patent number).
 * - `title`:        short, human-readable label. For trade marks this
 *                   is the word mark; for patents it is the invention
 *                   title.
 * - `abstract`:     longer descriptive text where available. Empty
 *                   string if upstream does not provide one for the
 *                   given record.
 * - `publishedAt`:  ISO-8601 timestamp of the application/filing date,
 *                   or `null` if not parsable.
 * - `url`:          deep link to the public record on the IP Australia
 *                   search portal.
 * - `relevanceScore`: optional 0..1 score if the upstream response
 *                   includes a ranking signal.
 */
export interface IpAustraliaResult {
  externalId: string;
  title: string;
  abstract: string;
  publishedAt: string | null;
  url: string;
  relevanceScore?: number;
}

/**
 * Discriminated error union surfaced by `searchIpAustralia`. All thrown
 * errors are instances of `IpAustraliaError` with a `code` field; callers
 * can branch on `code` without string-matching messages.
 */
export type IpAustraliaErrorCode =
  | 'auth_error' //  401 / 403 — bad or missing token
  | 'rate_limited' //  429
  | 'bad_request' //  400 / 422
  | 'not_found' //  404
  | 'upstream_error' //  5xx after retries
  | 'network_error' //  fetch threw or aborted
  | 'timeout' //  per-attempt AbortController fired
  | 'parse_error'; //  upstream returned malformed JSON

export class IpAustraliaError extends Error {
  public readonly code: IpAustraliaErrorCode;
  public readonly status: number | undefined;
  public readonly attempts: number;

  constructor(
    code: IpAustraliaErrorCode,
    message: string,
    options: { status?: number; attempts?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'IpAustraliaError';
    this.code = code;
    this.status = options.status;
    this.attempts = options.attempts ?? 1;
  }
}
