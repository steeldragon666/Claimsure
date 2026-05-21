/**
 * Pure URL-param parsers + serializer for /evidence.
 *
 * URL is the source of truth for filter state (shareable links,
 * back-button friendly). Mirrors the established pattern in
 * `apps/web/src/app/claims/[claim_id]/_lib/url-params.ts`.
 *
 *   ?kinds=HYPOTHESIS,OBSERVATION    (CSV of EvidenceFeedKind)
 *   ?claimant_ids=<uuid>,<uuid>      (CSV of UUIDs)
 *   ?since=2026-01-01T00:00:00Z      (ISO8601 lower bound)
 *   ?limit=25                         (1..200, default 50)
 *   ?cursor=<opaque>                  (base64url pagination token)
 */

import { EVIDENCE_FEED_KINDS, type EvidenceFeedKind } from '@cpa/schemas';

const KINDS_SET = new Set<string>(EVIDENCE_FEED_KINDS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_EVIDENCE_LIMIT = 50;

export interface EvidenceUrlParams {
  kinds?: EvidenceFeedKind[];
  claimant_ids?: string[];
  since?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Parse `?kinds=...` CSV. Strips invalid values; returns `undefined`
 * when nothing valid remains (= "show all kinds").
 */
export function parseEvidenceKinds(raw: string | null | undefined): EvidenceFeedKind[] | undefined {
  if (!raw) return undefined;
  const valid = raw.split(',').filter((k) => KINDS_SET.has(k)) as EvidenceFeedKind[];
  return valid.length > 0 ? valid : undefined;
}

/**
 * Parse `?claimant_ids=...` CSV. Strips non-UUID values; returns
 * `undefined` when nothing valid remains (= "show all claimants").
 */
export function parseClaimantIds(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  const valid = raw.split(',').filter((id) => UUID_RE.test(id));
  return valid.length > 0 ? valid : undefined;
}

/**
 * Parse `?limit=...`. Clamps to [1, 200]; returns DEFAULT_EVIDENCE_LIMIT
 * when absent or non-numeric.
 */
export function parseLimit(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_EVIDENCE_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_EVIDENCE_LIMIT;
  return Math.max(1, Math.min(200, Math.round(n)));
}

/**
 * Serialize evidence filter state back to a query string.
 * Omits keys that are undefined/empty/default so the URL stays clean.
 */
export function serializeEvidenceParams(params: Partial<EvidenceUrlParams>): string {
  const sp = new URLSearchParams();
  if (params.kinds && params.kinds.length > 0) {
    sp.set('kinds', params.kinds.join(','));
  }
  if (params.claimant_ids && params.claimant_ids.length > 0) {
    sp.set('claimant_ids', params.claimant_ids.join(','));
  }
  if (params.since) {
    sp.set('since', params.since);
  }
  if (params.limit !== undefined && params.limit !== DEFAULT_EVIDENCE_LIMIT) {
    sp.set('limit', String(params.limit));
  }
  if (params.cursor) {
    sp.set('cursor', params.cursor);
  }
  return sp.toString();
}
