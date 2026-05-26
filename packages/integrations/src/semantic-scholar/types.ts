/**
 * Wizard Step 2 Task 03 — Semantic Scholar integration: public types.
 *
 * Normalised result shape returned to callers. The Semantic Scholar
 * Academic Graph API exposes many fields, but this integration is
 * scoped to what the Wizard Step 2 prior-art search needs:
 *
 *   - `externalId`   stable identifier — DOI when present, otherwise the
 *                    Semantic Scholar `paperId`. Callers should treat the
 *                    string as opaque; do NOT parse it.
 *   - `title`        paper title (trimmed; never empty).
 *   - `abstract`     paper abstract or `null` when the API returns no abstract.
 *   - `publishedAt`  ISO-8601 date string `YYYY-01-01` derived from `year`,
 *                    or `null` when the API has no year for the record.
 *                    Day/month precision is not exposed by the search endpoint.
 *   - `url`          canonical Semantic Scholar URL for the paper.
 *   - `relevanceScore`
 *                    Optional, currently unset — reserved for future scoring
 *                    once we run our own reranker over results.
 *   - `citationCount`
 *                    Optional citation count if surfaced by the API.
 */
export interface SemanticScholarResult {
  externalId: string;
  title: string;
  abstract: string | null;
  publishedAt: string | null;
  url: string;
  relevanceScore?: number;
  citationCount?: number;
}

/**
 * Options accepted by `searchSemanticScholar`.
 *
 * `apiKey` is a function argument — NEVER read from `process.env` inside
 * this package. The caller (server-side route or scheduled job) is
 * responsible for sourcing the secret from its own env/secret store.
 *
 * `limit` defaults to 20 (max 100 per Semantic Scholar API).
 *
 * `signal` is an optional `AbortSignal` for cooperative cancellation.
 * Independent of the internal per-attempt timeout.
 *
 * `fetchImpl` is exposed primarily for testing — production callers
 * should leave it undefined to use `globalThis.fetch`.
 */
export interface SearchSemanticScholarOptions {
  apiKey?: string;
  limit?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Typed error thrown by `searchSemanticScholar`. The `kind` discriminator
 * lets callers branch on the failure class without parsing message strings.
 *
 *   - `network_error`  transport-level failure (DNS, connection reset,
 *                      timeout, retries exhausted on 5xx, abort).
 *   - `rate_limited`   HTTP 429 from upstream after honouring Retry-After.
 *   - `parse_error`    response body could not be decoded as the expected
 *                      JSON shape (missing fields, malformed JSON).
 *   - `auth_error`     HTTP 401/403 — the supplied API key was rejected or
 *                      missing for a key-required endpoint.
 *   - `bad_request`    HTTP 400 — query/limit invalid; not retryable.
 */
export type SemanticScholarErrorKind =
  | 'network_error'
  | 'rate_limited'
  | 'parse_error'
  | 'auth_error'
  | 'bad_request';

export class SemanticScholarError extends Error {
  readonly kind: SemanticScholarErrorKind;
  readonly status?: number;

  constructor(kind: SemanticScholarErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'SemanticScholarError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}
