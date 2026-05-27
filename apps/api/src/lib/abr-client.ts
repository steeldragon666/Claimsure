/**
 * Australian Business Register (ABR) MatchingNames client.
 *
 * Endpoint: https://abr.business.gov.au/json/MatchingNames.aspx
 *   ?name=<urlencoded-firm-name>&maxResults=5&guid=<ABR_GUID>
 *
 * The GUID is free to register at https://abr.business.gov.au/Tools/AbrXmlSearch
 * and is bound to a particular subscriber. We treat it as an env var (ABR_GUID).
 * If unset, the ABR step is skipped entirely — the pipeline falls through to
 * the Claude evaluator with `abr_match: []`. We do NOT block signups on a
 * missing GUID; the ABR check is informational, not a hard gate.
 *
 * Failure modes (all return `{ matches: [], skipped: false, error: <msg> }`
 * so the caller can log the failure and continue with the empty match list):
 *   - Network error / timeout                     → error returned
 *   - Non-2xx HTTP status                          → error returned
 *   - Body that does not parse as JSON             → error returned
 *   - Body that does not match the expected shape → matches: []
 *
 * Why the wide error tolerance: this is a third-party government endpoint we
 * cannot guarantee. The pipeline's permissive-bias semantics treat an ABR
 * outage as "no information" — never as evidence to deny.
 */

const ABR_ENDPOINT = 'https://abr.business.gov.au/json/MatchingNames.aspx';
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_RESULTS = 5;

export type AbrMatch = {
  matched_name: string;
  abn: string | null;
  entity_type: string | null;
  abn_status: string | null;
  registration_state: string | null;
};

export type AbrLookupResult = {
  /** True iff the lookup was skipped because ABR_GUID was unset. */
  skipped: boolean;
  /** Top N parsed matches (may be empty). */
  matches: AbrMatch[];
  /** Raw response body (the entire parsed JSON payload), captured for audit. */
  raw: unknown;
  /** Non-null on failure — the caller logs this but continues. */
  error: string | null;
};

export interface AbrLookupOptions {
  guid?: string;
  timeoutMs?: number;
  maxResults?: number;
  /** Test seam — overrides global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * The ABR JSON response is wrapped in a "callback" prefix (their API is
 * historically JSONP). The MatchingNames JSON variant returns a plain
 * object on the JSON endpoint, but in practice some deployments still
 * wrap the payload. Strip a leading `callback(` and trailing `)` defensively
 * before parsing.
 */
function stripJsonpWrap(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('callback(') && trimmed.endsWith(')')) {
    return trimmed.slice('callback('.length, -1);
  }
  return trimmed;
}

function parseMatches(raw: unknown): AbrMatch[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const root = raw as Record<string, unknown>;
  // The MatchingNames JSON endpoint shape is:
  //   { Names: [{ Name, Abn, EntityType, AbnStatus, State, ... }] }
  // Field casing varies between deployment versions, so we look up both
  // PascalCase and camelCase keys defensively.
  const candidates = root['Names'] ?? root['names'] ?? root['matches'];
  if (!Array.isArray(candidates)) return [];
  const matches: AbrMatch[] = [];
  for (const entry of candidates) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = (e['Name'] ?? e['name'] ?? e['matched_name']) as string | undefined;
    if (typeof name !== 'string' || name.length === 0) continue;
    matches.push({
      matched_name: name,
      abn: typeof (e['Abn'] ?? e['abn']) === 'string' ? ((e['Abn'] ?? e['abn']) as string) : null,
      entity_type:
        typeof (e['EntityType'] ?? e['entityType'] ?? e['entity_type']) === 'string'
          ? ((e['EntityType'] ?? e['entityType'] ?? e['entity_type']) as string)
          : null,
      abn_status:
        typeof (e['AbnStatus'] ?? e['abnStatus'] ?? e['abn_status']) === 'string'
          ? ((e['AbnStatus'] ?? e['abnStatus'] ?? e['abn_status']) as string)
          : null,
      registration_state:
        typeof (e['State'] ?? e['state'] ?? e['registration_state']) === 'string'
          ? ((e['State'] ?? e['state'] ?? e['registration_state']) as string)
          : null,
    });
  }
  return matches;
}

/**
 * Look up an Australian Business Register match for the given firm name.
 *
 * Returns a well-shaped result in every code path — never throws. Callers
 * log `error` if non-null and proceed with `matches: []`.
 */
export async function lookupAbrMatchingNames(
  firmName: string,
  options: AbrLookupOptions = {},
): Promise<AbrLookupResult> {
  const guid = options.guid ?? process.env.ABR_GUID;
  if (!guid || guid.trim() === '') {
    return { skipped: true, matches: [], raw: null, error: null };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const url = `${ABR_ENDPOINT}?name=${encodeURIComponent(firmName)}&maxResults=${maxResults}&guid=${encodeURIComponent(guid)}`;

  // AbortController so the call always returns inside the latency budget.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, method: 'GET' });
    if (!res.ok) {
      return {
        skipped: false,
        matches: [],
        raw: null,
        error: `ABR returned HTTP ${res.status}`,
      };
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonpWrap(text));
    } catch (err) {
      return {
        skipped: false,
        matches: [],
        raw: text,
        error: `ABR body did not parse as JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      skipped: false,
      matches: parseMatches(parsed),
      raw: parsed,
      error: null,
    };
  } catch (err) {
    return {
      skipped: false,
      matches: [],
      raw: null,
      error: `ABR fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
