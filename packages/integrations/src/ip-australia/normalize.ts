/**
 * Normalise raw IP Australia `/search/quick` payloads into
 * `IpAustraliaResult[]`.
 *
 * IP Australia do not publish a machine-readable response schema for
 * the trade-mark or patent quick-search endpoints. Through portal
 * documentation and observed traffic, the typical shape is:
 *
 *   {
 *     "results": [
 *       {
 *         "tradeMarkNumber"?: number | string,
 *         "patentNumber"?:    number | string,
 *         "words"?:           string,           // trade-mark word mark
 *         "title"?:           string,           // patent invention title
 *         "summary"?:         string,
 *         "abstract"?:        string,
 *         "applicationDate"?: string,           // ISO-ish
 *         "filingDate"?:      string,
 *         "lodgementDate"?:   string,
 *         "score"?:           number            // relevance, 0..1 or 0..100
 *       }
 *     ],
 *     "totalResults"?: number
 *   }
 *
 * Some deployments wrap the array in `data.records` instead of
 * `results`. To stay resilient we probe a small set of candidate
 * field names rather than committing to one schema; if upstream
 * tightens its contract we can drop the alternatives.
 */

import type { IpAustraliaDataset, IpAustraliaResult } from './types.js';

/** Public portal URL roots — used to build deep links. */
const TRADEMARK_PORTAL = 'https://search.ipaustralia.gov.au/trademarks/search/view';
const PATENT_PORTAL = 'https://search.ipaustralia.gov.au/patents/search/view';

/**
 * Convert an unknown upstream payload into a normalised result list.
 * Records that don't carry at least an identifier and a title are
 * skipped (rather than throwing) so a single malformed row can't
 * tank the whole search.
 */
export function normalizeQuickSearch(
  payload: unknown,
  dataset: IpAustraliaDataset,
): IpAustraliaResult[] {
  const rows = extractRows(payload);
  const out: IpAustraliaResult[] = [];

  for (const row of rows) {
    const normalized = normalizeRow(row, dataset);
    if (normalized !== null) out.push(normalized);
  }

  return out;
}

/**
 * Find the array of records inside an upstream payload. Tolerates the
 * three wrappers we've seen in practice: `results`, `data.records`,
 * and a bare array.
 */
function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isObject(payload)) return [];

  const directResults = payload.results;
  if (Array.isArray(directResults)) return directResults;

  const data = payload.data;
  if (isObject(data) && Array.isArray(data.records)) return data.records;
  if (isObject(data) && Array.isArray(data.results)) return data.results;

  const records = payload.records;
  if (Array.isArray(records)) return records;

  return [];
}

function normalizeRow(row: unknown, dataset: IpAustraliaDataset): IpAustraliaResult | null {
  if (!isObject(row)) return null;

  const externalId = pickString(row, [
    'tradeMarkNumber',
    'trademarkNumber',
    'patentNumber',
    'applicationNumber',
    'number',
    'id',
  ]);
  if (externalId === null) return null;

  const title = pickString(row, ['words', 'title', 'inventionTitle', 'name']) ?? '';
  if (title.length === 0) return null;

  const abstract = pickString(row, ['abstract', 'summary', 'description']) ?? '';

  const publishedAtRaw = pickString(row, [
    'applicationDate',
    'filingDate',
    'lodgementDate',
    'publishedDate',
    'datePublished',
  ]);
  const publishedAt = toIsoTimestamp(publishedAtRaw);

  const url = buildRecordUrl(dataset, externalId);

  const result: IpAustraliaResult = {
    externalId,
    title,
    abstract,
    publishedAt,
    url,
  };

  const score = pickNumber(row, ['score', 'relevanceScore', 'rank']);
  if (score !== null) {
    result.relevanceScore = normalizeScore(score);
  }

  return result;
}

function buildRecordUrl(dataset: IpAustraliaDataset, externalId: string): string {
  const root = dataset === 'patent' ? PATENT_PORTAL : TRADEMARK_PORTAL;
  return `${root}/${encodeURIComponent(externalId)}`;
}

/**
 * Coerce a heterogeneous date value into an ISO-8601 timestamp.
 * Returns `null` when the input is missing or unparsable rather than
 * fabricating a "now" timestamp.
 */
function toIsoTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = new Date(trimmed);
  const time = parsed.getTime();
  if (isNaN(time)) return null;
  return parsed.toISOString();
}

/**
 * Clamp a relevance score into the 0..1 range. Some IP search APIs
 * return 0..100, others 0..1; we accept both and normalise.
 */
function normalizeScore(score: number): number {
  if (!isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 1 && score <= 100) return score / 100;
  if (score > 1) return 1;
  return score;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && isFinite(value)) return String(value);
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      if (isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
