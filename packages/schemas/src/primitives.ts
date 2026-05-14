import { z } from 'zod';

/**
 * Any RFC 9562 UUID format (v1, v3, v4, v5, v7, nil, max). We mint new
 * UUIDs via `crypto.randomUUID()` (always v4), but seed data, test
 * fixtures, and dev databases legitimately carry non-v4 IDs (e.g. the
 * deterministic `00000000-0000-0000-0000-00000000000N` pattern used for
 * the platform's seed user and demo tenants). The v4-only regex
 * previously here rejected those at the API boundary — every wizard
 * `agreed_by` field on a seed-user-driven claim failed schema
 * validation, surfacing as `not_a_wizard_claim` (false negative).
 *
 * Security implication: v1 UUIDs encode a MAC address + timestamp, so
 * accepting them at the boundary in principle leaks server-side info
 * if the caller is allowed to supply user IDs. In this codebase user
 * IDs are server-minted (never accepted from the client wire), so the
 * concern is theoretical. If a future codepath ACCEPTS a user-supplied
 * UUID, that route should layer an `id.startsWith('...-4...-')` check
 * on top.
 */
export const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a UUID');
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
