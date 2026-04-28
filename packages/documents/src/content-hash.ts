import crypto from 'node:crypto';

/**
 * Canonical JSON stringification for content hashing.
 *
 * Identical algorithm to `packages/db/src/chain.ts:canonicalJsonStringify`
 * (lines 23-35), but duplicated here intentionally: @cpa/documents is a
 * presentation-layer package and importing @cpa/db would pull drizzle +
 * postgres-js into the dependency graph for a 13-line algorithm.
 *
 * If you change the algorithm, change BOTH copies — the F6 chain hash
 * regression test in `packages/db/src/chain.test.ts` and the regression
 * anchor in `content-hash.test.ts` will both fire if the algorithms
 * drift, alerting reviewers to coordinate the change.
 *
 * Throws on non-finite numbers — these aren't representable in JSON and
 * would silently corrupt the hash.
 */
function canonicalJsonStringify(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(
      `canonicalJsonStringify: non-finite number (NaN/Infinity) is not JSON-representable; reject before hashing`,
    );
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k])).join(',') + '}'
  );
}

/**
 * Compute a SHA-256 content hash for document input data.
 *
 * Used by:
 * - Document footer rendering (so the printed PDF includes its own content
 *   hash, supporting reproducibility — same input → same hash → same PDF)
 * - Event chain entries (`DOCUMENT_GENERATED` event payload's
 *   `content_sha256` field — see @cpa/schemas/event:DocumentGeneratedPayload)
 *
 * Returns 64 lowercase hex characters.
 */
export function contentHash(input: unknown): string {
  return crypto.createHash('sha256').update(canonicalJsonStringify(input)).digest('hex');
}
