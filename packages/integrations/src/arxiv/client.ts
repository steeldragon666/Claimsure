import { XMLParser } from 'fast-xml-parser';
import { ArxivError, type ArxivResult, type SearchArxivOptions } from './types.js';

/**
 * arXiv API export endpoint. Documented at:
 *   https://info.arxiv.org/help/api/user-manual.html
 *
 * NB: arXiv requires `http://export.arxiv.org` not the public
 * `arxiv.org` host - the export subdomain is the API surface.
 * Per arXiv's stated policy, no API key is supported and rate is
 * limited to one request per three seconds per IP.
 */
const DEFAULT_BASE_URL = 'http://export.arxiv.org/api/query';

/**
 * Default page size. Matches PubMed default. arXiv permits up to
 * 30,000 per response but performance degrades sharply above ~500.
 */
const DEFAULT_MAX_RESULTS = 20;

/**
 * Per-attempt timeout. arXiv occasionally stalls under load; we bound
 * each attempt at 30s so a single stuck request cannot hang the
 * wizard indefinitely. Matches the PubMed/IP Australia precedent.
 */
const PER_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Total fetch attempts (1 initial + 2 retries). Retries fire on
 * transient failures only: 429, 5xx, network errors, and per-attempt
 * timeouts. 4xx other than 429 short-circuits to `http_error`.
 */
const MAX_ATTEMPTS = 3;

/**
 * Exponential backoff schedule between attempts (ms).
 */
const BACKOFFS_MS = [500, 1000];

/**
 * fast-xml-parser instance. Chosen over xml2js because:
 *   1. It is already in the workspace lockfile (4.5.6) as a
 *      transitive dependency, so we incur no extra install footprint
 *      by declaring it as a direct dep here.
 *   2. Synchronous + zero deps, ~50KB - well-suited to a small
 *      Atom-feed parse on the API server hot path.
 *   3. xml2js requires async callbacks and pulls in `sax` as a hard
 *      dep, which adds boilerplate for what is otherwise a trivial
 *      walk of a known schema.
 *
 * Options:
 *   - `ignoreAttributes: false` so we can read `<link href="..."/>`.
 *   - `attributeNamePrefix: '@_'` keeps attribute keys distinct
 *     from element children when both exist on the same node.
 *   - Default `isArray` returns a singleton for elements that appear
 *     once; we normalise `<entry>` to always-array via `toArray()`.
 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // `<entry>` repeats; force always-array regardless of how many
  // results came back so the call site does not branch on
  // typeof entry === 'object' vs Array.
  isArray: (name) => name === 'entry' || name === 'link' || name === 'author',
});

/**
 * Search arXiv via the Atom-feed API.
 *
 * arXiv returns an Atom XML document with `<feed>` containing zero
 * or more `<entry>` elements. We parse with fast-xml-parser and
 * normalise each entry to the shared `ArxivResult` shape.
 *
 * Resilience:
 *   - Per-attempt 30s AbortController timeout.
 *   - 3 total attempts with 500ms / 1000ms exponential backoff.
 *   - Retries on 429, 5xx, network errors, and per-attempt timeouts.
 *   - 4xx other than 429 fails immediately with `code: 'http_error'`.
 *   - Caller's `opts.signal` short-circuits the loop and surfaces as
 *     `code: 'timeout'`.
 *
 * Throws `ArxivError` (see types.ts) with a discriminated `code`
 * field — mirrors the PubMed/IP Australia convention so callers can
 * branch on failure mode without parsing messages.
 *
 * Returns an empty array for queries that match zero papers (arXiv
 * returns an empty `<feed>`, which after parsing leaves `entry`
 * undefined - we coerce to `[]`).
 */
export async function searchArxiv(
  query: string,
  opts: SearchArxivOptions = {},
): Promise<ArxivResult[]> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;

  const url = new URL(baseUrl);
  url.searchParams.set('search_query', query);
  url.searchParams.set('max_results', String(maxResults));

  const res = await withRetry(() => arxivFetch(url, opts), opts.signal);
  const xml = await res.text();
  let parsed: ArxivFeedParsed;
  try {
    parsed = xmlParser.parse(xml) as ArxivFeedParsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ArxivError('parse_error', `arxiv: XML parse failed: ${msg}`);
  }
  const entries = parsed?.feed?.entry ?? [];
  return entries.map(toArxivResult);
}

/**
 * Run a single fetch attempt with a per-attempt 30s AbortController
 * timeout and the caller-supplied `opts.signal` propagated. Returns
 * the raw `Response` on success. On non-2xx, throws an `ArxivError`
 * with an appropriate `code` so `withRetry` can decide whether to
 * retry. On fetch/AbortError, throws `network_error` or `timeout`.
 *
 * Kept inline (not extracted to `runtime/`) to match the existing
 * convention — each integration's resilience helper lives next to
 * its client, even at the cost of some duplication across providers.
 */
async function arxivFetch(url: URL, opts: SearchArxivOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const perAttemptController = new AbortController();
  const timeoutId = setTimeout(() => perAttemptController.abort(), PER_ATTEMPT_TIMEOUT_MS);

  if (opts.signal?.aborted) {
    clearTimeout(timeoutId);
    throw new ArxivError('timeout', 'arxiv: aborted by caller');
  }

  const onCallerAbort = () => perAttemptController.abort();
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: perAttemptController.signal });
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new ArxivError('timeout', 'arxiv: aborted by caller');
    }
    if (perAttemptController.signal.aborted) {
      throw new ArxivError(
        'timeout',
        `arxiv: per-attempt timeout after ${PER_ATTEMPT_TIMEOUT_MS}ms`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ArxivError('network_error', `arxiv: network error: ${msg}`);
  } finally {
    clearTimeout(timeoutId);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      throw new ArxivError('rate_limited', `arxiv: 429 ${body}`, 429, body);
    }
    if (res.status >= 500) {
      throw new ArxivError('upstream_error', `arxiv: ${res.status} ${body}`, res.status, body);
    }
    throw new ArxivError('http_error', `arxiv: ${res.status} ${body}`, res.status, body);
  }

  return res;
}

/**
 * Retry wrapper that interprets `ArxivError.code` to decide
 * retryability. See pubmed/client.ts for the symmetric helper —
 * duplicated intentionally per the package's per-integration
 * self-contained convention.
 */
async function withRetry<T>(attempt: () => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (callerSignal?.aborted) throw err;
      if (!isRetryable(err) || i === MAX_ATTEMPTS - 1) throw err;
      const wait = BACKOFFS_MS[i] ?? BACKOFFS_MS[BACKOFFS_MS.length - 1] ?? 1000;
      await sleep(wait);
    }
  }
  throw lastError;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof ArxivError)) return false;
  return (
    err.code === 'rate_limited' ||
    err.code === 'upstream_error' ||
    err.code === 'network_error' ||
    err.code === 'timeout'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalise a single Atom entry to an ArxivResult.
 *
 * `<id>` arrives as `http://arxiv.org/abs/<id>v<n>` - we strip the
 * prefix and version suffix so callers get the canonical paper ID
 * (`2401.12345`) that links to the latest version.
 *
 * `<link rel="alternate">` is the HTML abstract page URL; we prefer
 * it over the raw `<id>` URL because it points to the rendered HTML
 * page users expect. Falls back to the canonical `/abs/<id>` URL if
 * the alternate link is missing.
 */
function toArxivResult(entry: ArxivEntry): ArxivResult {
  const rawId = typeof entry.id === 'string' ? entry.id : '';
  const externalId = normaliseArxivId(rawId);

  const links = entry.link ?? [];
  const alternate = links.find((l) => l['@_rel'] === 'alternate' || l['@_rel'] === undefined);
  const url = alternate?.['@_href'] ?? `http://arxiv.org/abs/${externalId}`;

  // Omit optional fields when absent rather than setting to undefined -
  // the package's tsconfig has `exactOptionalPropertyTypes: true`.
  const abstract = normaliseWhitespace(entry.summary);
  const result: ArxivResult = {
    externalId,
    title: normaliseWhitespace(entry.title),
    publishedAt: typeof entry.published === 'string' ? entry.published : '',
    url,
  };
  if (abstract) {
    result.abstract = abstract;
  }
  return result;
}

/**
 * Strip `http://arxiv.org/abs/` prefix and `vN` version suffix.
 * Conservative - if the URL does not match the expected shape we
 * return the raw `<id>` so the caller still has *something*
 * traceable rather than the empty string.
 */
function normaliseArxivId(rawId: string): string {
  const match = rawId.match(/\/abs\/([^/?#]+?)(?:v\d+)?$/);
  return match?.[1] ?? rawId;
}

/**
 * arXiv pads `<title>` and `<summary>` with newlines and indentation
 * for visual XML wrapping ("\n  This paper...\n  proposes...\n").
 * Collapse to single-spaced text so the UI does not render whitespace
 * artefacts.
 */
function normaliseWhitespace(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Parsed feed shape we depend on. Local types - documented at:
 *   https://info.arxiv.org/help/api/user-manual.html#3.3.1-the-search-query-interface
 *
 * Defined here rather than via `@types/atom` because:
 *   - No mature `@types` package exists for arXiv's Atom dialect.
 *   - We only read four fields per entry; a full Atom type would
 *     be far more surface than this client uses.
 */
type ArxivLink = {
  '@_href'?: string;
  '@_rel'?: string;
  '@_type'?: string;
};

type ArxivEntry = {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  link?: ArxivLink[];
};

type ArxivFeedParsed = {
  feed?: {
    entry?: ArxivEntry[];
  };
};
