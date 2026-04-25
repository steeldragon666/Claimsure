import { z } from 'zod';

/**
 * UUID v4 only. Rejects v1 (which leaks MAC + timestamp), v3, v5,
 * nil, and max. We mint via `crypto.randomUUID()` (always v4), so
 * any non-v4 UUID arriving at our boundary is wrong by definition.
 */
export const Uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'must be a UUID v4',
  );
export type Uuid = z.infer<typeof Uuid>;

/**
 * 64 lowercase hex chars. Rejects (rather than normalises) uppercase
 * to force callers to canonicalise upstream — silent normalisation in
 * an audit-chain context can mask content-addressing bugs.
 */
export const Sha256Hash = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex chars');
export type Sha256Hash = z.infer<typeof Sha256Hash>;

/**
 * ISO-8601 datetime with required offset (`Z` or `±HH:MM`). Naive
 * datetimes are rejected — every audit-chain timestamp must be
 * timezone-anchored to be correctly orderable across regions.
 */
export const Iso8601 = z.string().datetime({ offset: true });
export type Iso8601 = z.infer<typeof Iso8601>;
