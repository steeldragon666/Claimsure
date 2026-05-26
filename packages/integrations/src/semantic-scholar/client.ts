/**
 * Wizard Step 2 Task 03 — Semantic Scholar Academic Graph search client.
 *
 * Public surface: `searchSemanticScholar(query, opts?)`.
 *
 * Endpoint: https://api.semanticscholar.org/graph/v1/paper/search
 * Docs:     https://api.semanticscholar.org/api-docs/graph
 *
 * Architecture: no DB writes, no LLM calls. Per-attempt 15s timeout via
 * `AbortController`, exponential backoff on 5xx, Retry-After honoured on
 * 429, typed `SemanticScholarError` on failure. The API key is a
 * function argument so the package never touches `process.env`.
 *
 * Rate limit: 1 req/sec unauthenticated. The package does not enforce
 * client-side rate limiting — callers that batch searches should layer
 * their own throttle on top.
 */

import {
  SemanticScholarError,
  type SearchSemanticScholarOptions,
  type SemanticScholarResult,
} from './types.js';

const SEARCH_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/search';

/** Fields requested from the API. Keep in sync with `RawApiPaper`. */
const REQUESTED_FIELDS = ['externalIds', 'title', 'abstract', 'year', 'url', 'citationCount'].join(
  ',',
);

/** Default result limit when caller does not supply one. */
const DEFAULT_LIMIT = 20;

/** Hard upper bound enforced by Semantic Scholar's API. */
const MAX_LIMIT = 100;

/** Per-attempt fetch timeout. */
const FETCH_TIMEOUT_MS = 15_000;

/** Total fetch attempts: 1 initial + 2 retries. */
const MAX_ATTEMPTS = 3;

/** Base backoff in ms. Doubled per retry: 500, 1000, 2000. */
const BASE_BACKOFF_MS = 500;

/** Maximum Retry-After delay we will honour (seconds). */
const MAX_RETRY_AFTER_S = 30;

/**
 * Shape returned by `/graph/v1/paper/search`. Only the fields we request
 * appear; all are optional in the wire format even when requested
 * (Semantic Scholar omits unknown values rather than nulling them).
 */
interface RawApiPaper {
  paperId?: string;
  externalIds?: Record<string, string | number | null> | null;
  title?: string | null;
  abstract?: string | null;
  year?: number | null;
  url?: string | null;
  citationCount?: number | null;
}

interface RawApiResponse {
  total?: number;
  offset?: number;
  next?: number;
  data?: RawApiPaper[];
}

/**
 * Search the Semantic Scholar Academic Graph for papers matching `query`.
 *
 * @param query - Free-text search query. Trimmed; empty queries are rejected
 *                with a `bad_request` error before any network call.
 * @param opts  - Optional `apiKey`, `limit`, `signal`, `fetchImpl`.
 * @returns     Array of normalised {@link SemanticScholarResult}. Empty
 *              array when the API returns no matches.
 * @throws      {@link SemanticScholarError} on any non-2xx or transport failure.
 */
export async function searchSemanticScholar(
  query: string,
  opts: SearchSemanticScholarOptions = {},
): Promise<SemanticScholarResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new SemanticScholarError('bad_request', 'query must be a non-empty string');
  }

  const limit = clampLimit(opts.limit);
  const url = buildSearchUrl(trimmed, limit);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (opts.apiKey) {
    headers['x-api-key'] = opts.apiKey;
  }

  const body = await fetchWithRetry(fetchImpl, url, headers, opts.signal, !!opts.apiKey);

  let parsed: RawApiResponse;
  try {
    parsed = JSON.parse(body) as RawApiResponse;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SemanticScholarError('parse_error', `invalid JSON in response: ${detail}`);
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.data)) {
    // Empty `data` is allowed (no matches) — but a missing/non-array `data`
    // field on a 200 response means the API contract has shifted.
    throw new SemanticScholarError('parse_error', 'response missing `data` array');
  }

  return parsed.data.map(normalisePaper).filter((r): r is SemanticScholarResult => r !== null);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(raw) || raw < 1) {
    throw new SemanticScholarError('bad_request', 'limit must be a positive integer');
  }
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

function buildSearchUrl(query: string, limit: number): string {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    fields: REQUESTED_FIELDS,
  });
  return `${SEARCH_ENDPOINT}?${params.toString()}`;
}

/**
 * Issue the request with retries on 5xx and 429. Returns the response
 * body as a string on success; throws a typed `SemanticScholarError` on
 * any failure mode.
 *
 * `authProvided` lets us distinguish 401/403 messaging — a 401/403
 * without an API key is "key required", with a key it is "key rejected".
 */
async function fetchWithRetry(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  callerSignal: AbortSignal | undefined,
  authProvided: boolean,
): Promise<string> {
  let lastError: SemanticScholarError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        throw new SemanticScholarError('network_error', 'request aborted by caller');
      }
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = callerSignal?.aborted === true;
      lastError = new SemanticScholarError(
        'network_error',
        aborted
          ? 'request aborted by caller'
          : `fetch failed on attempt ${attempt}/${MAX_ATTEMPTS}: ${msg}`,
      );
      if (aborted || attempt >= MAX_ATTEMPTS) {
        throw lastError;
      }
      await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
      continue;
    } finally {
      clearTimeout(timeoutId);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }

    if (response.ok) {
      return await response.text();
    }

    // 429 — honour Retry-After then retry.
    if (response.status === 429) {
      const wait = parseRetryAfter(response.headers.get('Retry-After'));
      lastError = new SemanticScholarError(
        'rate_limited',
        `HTTP 429 from Semantic Scholar (Retry-After: ${wait}s)`,
        429,
      );
      if (attempt >= MAX_ATTEMPTS) throw lastError;
      await sleep(wait * 1_000);
      continue;
    }

    // 401/403 — auth failure. Not retryable.
    if (response.status === 401 || response.status === 403) {
      throw new SemanticScholarError(
        'auth_error',
        authProvided
          ? `HTTP ${response.status} from Semantic Scholar — API key rejected`
          : `HTTP ${response.status} from Semantic Scholar — API key required for this endpoint`,
        response.status,
      );
    }

    // 400 — bad request (query syntax, invalid limit). Not retryable.
    if (response.status === 400) {
      throw new SemanticScholarError(
        'bad_request',
        `HTTP 400 from Semantic Scholar — query rejected`,
        400,
      );
    }

    // 5xx — transient; retry with backoff.
    if (response.status >= 500) {
      lastError = new SemanticScholarError(
        'network_error',
        `HTTP ${response.status} from Semantic Scholar on attempt ${attempt}/${MAX_ATTEMPTS}`,
        response.status,
      );
      if (attempt >= MAX_ATTEMPTS) throw lastError;
      await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
      continue;
    }

    // Other 4xx — not retryable. Surface as network_error with status for
    // operator triage (covers 404, 410, 422 etc. that the docs do not
    // explicitly document but the API may emit).
    throw new SemanticScholarError(
      'network_error',
      `HTTP ${response.status} from Semantic Scholar — not retryable`,
      response.status,
    );
  }

  // Unreachable — every loop iteration either returns or throws — but
  // TypeScript's control-flow analysis cannot prove that.
  throw lastError ?? new SemanticScholarError('network_error', 'retries exhausted');
}

/** Parse Retry-After header (seconds or HTTP-date). Clamped to MAX_RETRY_AFTER_S. */
function parseRetryAfter(header: string | null): number {
  if (!header) return Math.ceil(BASE_BACKOFF_MS / 1_000);
  const asInt = parseInt(header, 10);
  if (!Number.isNaN(asInt) && asInt > 0) return Math.min(asInt, MAX_RETRY_AFTER_S);
  const asDate = new Date(header);
  if (!Number.isNaN(asDate.getTime())) {
    const diffSeconds = Math.ceil((asDate.getTime() - Date.now()) / 1_000);
    return Math.min(Math.max(1, diffSeconds), MAX_RETRY_AFTER_S);
  }
  return Math.ceil(BASE_BACKOFF_MS / 1_000);
}

/**
 * Convert a raw API record into our normalised shape. Returns `null` for
 * records missing both an identifier and a title — these are unusable
 * search results and there is no value in surfacing them to callers.
 */
function normalisePaper(raw: RawApiPaper): SemanticScholarResult | null {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;

  const externalId = pickExternalId(raw);
  if (!externalId) return null;

  const abstract =
    typeof raw.abstract === 'string' && raw.abstract.trim().length > 0 ? raw.abstract.trim() : null;

  const publishedAt =
    typeof raw.year === 'number' && Number.isFinite(raw.year) && raw.year > 0
      ? `${raw.year}-01-01`
      : null;

  const url =
    typeof raw.url === 'string' && raw.url.length > 0
      ? raw.url
      : `https://www.semanticscholar.org/paper/${encodeURIComponent(externalId)}`;

  const result: SemanticScholarResult = {
    externalId,
    title,
    abstract,
    publishedAt,
    url,
  };

  if (typeof raw.citationCount === 'number' && Number.isFinite(raw.citationCount)) {
    result.citationCount = raw.citationCount;
  }

  return result;
}

/**
 * Prefer DOI as the external identifier — it is the cross-publisher
 * stable id callers will recognise. Fall back to `paperId` only when DOI
 * is absent.
 */
function pickExternalId(raw: RawApiPaper): string | null {
  const ids = raw.externalIds;
  if (ids && typeof ids === 'object') {
    const doi = ids['DOI'];
    if (typeof doi === 'string' && doi.length > 0) return `DOI:${doi}`;
  }
  if (typeof raw.paperId === 'string' && raw.paperId.length > 0) {
    return raw.paperId;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
