import {
  PubMedError,
  type ESearchResponse,
  type ESummaryRecord,
  type ESummaryResponse,
  type PubMedResult,
  type SearchPubMedOptions,
} from './types.js';

/**
 * NCBI E-utilities base URL. Per NCBI's usage guidelines we hit the
 * `eutils.ncbi.nlm.nih.gov` host directly (no api gateway) and use
 * `retmode=json` to avoid the legacy XML serialisation.
 */
const DEFAULT_BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/**
 * Default page size. NCBI's hard ceiling is 10,000 but in practice
 * the ESummary GET URL hits a ~2KB limit well before that. 20 matches
 * the arXiv default and is the sweet spot for the wizard step 2
 * search-results UI.
 */
const DEFAULT_MAX_RESULTS = 20;

/**
 * Public PubMed article URL pattern. We construct this rather than
 * reading it from ESummary because ESummary only returns the PMID,
 * not a canonical URL, and `pubmed.ncbi.nlm.nih.gov/<pmid>/` is the
 * documented permalink shape.
 */
const PUBMED_ARTICLE_URL = (pmid: string) => `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

/**
 * Per-attempt timeout. NCBI's E-utilities sometimes stall for tens of
 * seconds before responding; we bound each attempt at 30s so a single
 * stuck request cannot hang the wizard indefinitely. Matches the IP
 * Australia precedent.
 */
const PER_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Total fetch attempts (1 initial + 2 retries). Retries fire on
 * transient failures only: 429, 5xx, network errors, and per-attempt
 * timeouts. 4xx other than 429 short-circuits to a `http_error`.
 */
const MAX_ATTEMPTS = 3;

/**
 * Exponential backoff schedule between attempts (ms). After attempt N
 * fails we wait `BACKOFFS_MS[N-1]` before attempt N+1. Index 2 is
 * unused (3 attempts → 2 inter-attempt waits) but kept for clarity.
 */
const BACKOFFS_MS = [500, 1000];

/**
 * Search PubMed via the two-step E-utilities flow.
 *
 *   1. ESearch  - db=pubmed&term=<q>&retmode=json returns a list of
 *      PMIDs ranked by relevance.
 *   2. ESummary - db=pubmed&id=<csv>&retmode=json returns title plus
 *      publication date for each PMID. (Abstracts require EFetch,
 *      which returns XML; we deliberately do not call EFetch here -
 *      the step 2 search UI shows titles + dates, and abstracts are
 *      loaded lazily by a follow-up endpoint outside this package's
 *      scope. The PubMedResult.abstract field is therefore always
 *      `undefined` from this client today, but is part of the
 *      normalized shape so future EFetch integration can populate
 *      it without breaking callers.)
 *
 * Rate limits: 3 req/sec without `apiKey`, 10 req/sec with one. The
 * package itself does not throttle - callers wrap in
 * `runtime/rate-limit` if they batch many queries.
 *
 * Resilience:
 *   - Per-attempt 30s AbortController timeout.
 *   - 3 total attempts with 500ms / 1000ms exponential backoff.
 *   - Retries on 429, 5xx, network errors, and per-attempt timeouts.
 *   - 4xx other than 429 fails immediately with `code: 'http_error'`.
 *   - Caller's `opts.signal` short-circuits the loop and surfaces as
 *     `code: 'timeout'`.
 *
 * Throws `PubMedError` (see types.ts) with a discriminated `code`
 * field so callers can branch on failure mode without parsing
 * messages — the same `code` shape the IP Australia client (PR #84)
 * established.
 *
 * Returns an empty array when the query has zero hits (ESearch
 * returns `idlist: []`, and we short-circuit before ESummary so we
 * do not issue a no-op ESummary call with an empty `id` param -
 * which NCBI returns a 400 for).
 */
export async function searchPubMed(
  query: string,
  opts: SearchPubMedOptions = {},
): Promise<PubMedResult[]> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const retmax = opts.maxResults ?? DEFAULT_MAX_RESULTS;

  // Step 1 - ESearch
  const esearchUrl = new URL(`${baseUrl}/esearch.fcgi`);
  esearchUrl.searchParams.set('db', 'pubmed');
  esearchUrl.searchParams.set('term', query);
  esearchUrl.searchParams.set('retmode', 'json');
  esearchUrl.searchParams.set('retmax', String(retmax));
  if (opts.apiKey) {
    esearchUrl.searchParams.set('api_key', opts.apiKey);
  }

  const esearchRes = await withRetry(() => pubmedFetch(esearchUrl, opts), opts.signal);
  const esearch = await parseJson<ESearchResponse>(esearchRes);
  const pmids = esearch.esearchresult?.idlist ?? [];
  if (pmids.length === 0) {
    return [];
  }

  // Step 2 - ESummary (csv of pmids)
  const esummaryUrl = new URL(`${baseUrl}/esummary.fcgi`);
  esummaryUrl.searchParams.set('db', 'pubmed');
  esummaryUrl.searchParams.set('id', pmids.join(','));
  esummaryUrl.searchParams.set('retmode', 'json');
  if (opts.apiKey) {
    esummaryUrl.searchParams.set('api_key', opts.apiKey);
  }

  const esummaryRes = await withRetry(() => pubmedFetch(esummaryUrl, opts), opts.signal);
  const esummary = await parseJson<ESummaryResponse>(esummaryRes);

  // Preserve ESearch's relevance ordering rather than walking
  // result.uids - ESummary occasionally re-orders by PMID-ascending,
  // which silently destroys the relevance ranking the user expects.
  return pmids
    .map((pmid) => esummary.result?.[pmid])
    .filter((r): r is ESummaryRecord => isESummaryRecord(r))
    .map(toPubMedResult);
}

/**
 * Run a single fetch attempt with a per-attempt 30s AbortController
 * timeout and the caller-supplied `opts.signal` propagated. Returns
 * the raw `Response` on success. On non-2xx, throws a `PubMedError`
 * with an appropriate `code` so `withRetry` can decide whether to
 * retry. On fetch/AbortError, throws `network_error` or `timeout`.
 *
 * Kept inline (not extracted to `runtime/`) to match the existing
 * convention — each integration's resilience helper lives next to
 * its client, even at the cost of some duplication across providers.
 */
async function pubmedFetch(url: URL, opts: SearchPubMedOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const perAttemptController = new AbortController();
  const timeoutId = setTimeout(() => perAttemptController.abort(), PER_ATTEMPT_TIMEOUT_MS);

  // If the caller-supplied signal is already aborted, surface that as
  // a timeout before issuing any fetch — saves a useless round-trip.
  if (opts.signal?.aborted) {
    clearTimeout(timeoutId);
    throw new PubMedError('timeout', 'pubmed: aborted by caller');
  }

  // Propagate caller-abort by triggering the per-attempt controller.
  const onCallerAbort = () => perAttemptController.abort();
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: perAttemptController.signal });
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new PubMedError('timeout', 'pubmed: aborted by caller');
    }
    if (perAttemptController.signal.aborted) {
      throw new PubMedError(
        'timeout',
        `pubmed: per-attempt timeout after ${PER_ATTEMPT_TIMEOUT_MS}ms`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new PubMedError('network_error', `pubmed: network error: ${msg}`);
  } finally {
    clearTimeout(timeoutId);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      throw new PubMedError('rate_limited', `pubmed: 429 ${body}`, 429, body);
    }
    if (res.status >= 500) {
      throw new PubMedError('upstream_error', `pubmed: ${res.status} ${body}`, res.status, body);
    }
    throw new PubMedError('http_error', `pubmed: ${res.status} ${body}`, res.status, body);
  }

  return res;
}

/**
 * Retry wrapper that interprets `PubMedError.code` to decide
 * retryability. Retries: `rate_limited`, `upstream_error`,
 * `network_error`, `timeout` (per-attempt, NOT caller-abort).
 * Caller-abort short-circuits because the per-attempt controller
 * was tripped by the caller's signal, which remains aborted across
 * subsequent attempts (so retrying would just throw timeout again).
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
  if (!(err instanceof PubMedError)) return false;
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

async function parseJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PubMedError('parse_error', `pubmed: JSON parse failed: ${msg}`);
  }
}

function isESummaryRecord(r: ESummaryRecord | string[] | undefined): r is ESummaryRecord {
  return typeof r === 'object' && r !== null && !Array.isArray(r) && typeof r.uid === 'string';
}

function toPubMedResult(rec: ESummaryRecord): PubMedResult {
  // Omit `abstract` and `relevanceScore` rather than setting them to
  // undefined - the package's tsconfig sets
  // `exactOptionalPropertyTypes: true`, which distinguishes "property
  // absent" from "property present, value undefined".
  return {
    externalId: rec.uid,
    title: rec.title ?? '',
    publishedAt: parsePubMedDate(rec.sortpubdate ?? rec.pubdate),
    url: PUBMED_ARTICLE_URL(rec.uid),
  };
}

/**
 * Parse PubMed's date strings into ISO-8601.
 *
 * `sortpubdate` arrives as "YYYY/MM/DD HH:MM" - replace `/` with `-`,
 * drop the time, and emit an ISO date.
 *
 * `pubdate` is the free-form display string: "2024 Jan 15", "2024 Jan",
 * "2024", "2024 Spring". Strategy: parse year (required); parse
 * month name if present; parse day if present; otherwise default
 * month=01 / day=01. Unrecognised input -> empty string so callers
 * can render "Unknown" rather than crash on `new Date('')`.
 */
export function parsePubMedDate(input: string | undefined): string {
  if (!input) return '';

  // sortpubdate: YYYY/MM/DD ...
  const sortMatch = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(input);
  if (sortMatch) {
    return `${sortMatch[1]}-${sortMatch[2]}-${sortMatch[3]}`;
  }

  // pubdate: "YYYY [Mon [DD]]" or "YYYY Season" - extract year first
  const yearMatch = /^(\d{4})/.exec(input);
  if (!yearMatch) return '';
  const year = yearMatch[1];

  const monthMap: Record<string, string> = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12',
  };
  const monMatch = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.exec(input);
  const monthKey = monMatch?.[1];
  const month = monthKey ? (monthMap[monthKey] ?? '01') : '01';

  const dayMatch = /\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/.exec(input);
  const day = dayMatch?.[1] ? dayMatch[1].padStart(2, '0') : '01';

  return `${year}-${month}-${day}`;
}
