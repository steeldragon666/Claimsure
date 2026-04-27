import { z } from 'zod';
import { Iso8601, Uuid } from './primitives.js';

/**
 * Time-entry source enum (T-B22).
 *
 * Mirrors `TIME_ENTRY_SOURCES` in @cpa/db/schema/time_entry.ts — the
 * canonical list lives DB-side (CHECK constraint), this enum is the
 * API contract. Keep both in sync; a PR that adds a source must touch
 * both.
 *
 * 'manual' — captured by the employee on the mobile app.
 * Everything else — pulled from the named payroll provider.
 */
export const timeEntrySource = z.enum([
  'manual',
  'employment_hero',
  'keypay',
  'deputy',
  'xero_payroll',
]);
export type TimeEntrySource = z.infer<typeof timeEntrySource>;

/**
 * Public shape of a `time_entry` row over the API.
 *
 * Mirrors the DB schema in @cpa/db/schema/time_entry.ts. Timestamps
 * are ISO-8601 with offset (matches the audit-anchor convention).
 *
 * `apportionment_pct` is the consultant-set R&D fraction (0-100).
 * Stored as NUMERIC(5,2) DB-side; surfaced as `number` over the wire
 * (postgres-js coerces NUMERIC to string by default — the route
 * handler does the Number(...) coercion before responding).
 *
 * `flagged_at` is set by the payroll-sync conflict-resolution path
 * (T-B21) when a manual entry overlaps a payroll-pulled period.
 * Cleared by the consultant via POST /v1/time-entries/:id/clear-flag
 * once the conflict is reviewed.
 */
export const timeEntry = z.object({
  id: Uuid,
  tenant_id: Uuid,
  subject_tenant_id: Uuid,
  employee_id: Uuid,
  source: timeEntrySource,
  external_id: z.string().nullable(),
  started_at: Iso8601,
  ended_at: Iso8601,
  duration_minutes: z.number().int(),
  is_rd: z.boolean(),
  apportionment_pct: z.number().nullable(),
  apportioned_by_user_id: Uuid.nullable(),
  apportioned_at: Iso8601.nullable(),
  notes: z.string().nullable(),
  flagged_at: Iso8601.nullable(),
  created_at: Iso8601,
});
export type TimeEntry = z.infer<typeof timeEntry>;

/**
 * POST /v1/time-entries body — manual entry capture from the mobile
 * app.
 *
 * `employee_id` is NOT in the body; it's derived from the mobile JWT's
 * `sub` claim so an employee can only create entries for themselves.
 *
 * The `refine` enforces non-zero positive duration — the duration
 * itself is computed server-side from started_at/ended_at, so we just
 * reject the trivially-invalid case where the bounds are equal or
 * inverted.
 */
export const createManualTimeEntryBody = z
  .object({
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }),
    is_rd: z.boolean().default(true),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => new Date(v.ended_at) > new Date(v.started_at), {
    message: 'ended_at must be after started_at',
  });
export type CreateManualTimeEntryBody = z.infer<typeof createManualTimeEntryBody>;

/**
 * PATCH /v1/time-entries/:id/apportionment body.
 *
 * The consultant supplies the R&D percentage (0-100). The route
 * handler stamps `apportioned_by_user_id` and `apportioned_at` from
 * the session — they aren't in the body so the consultant can't spoof
 * who reviewed the entry.
 */
export const apportionmentBody = z.object({
  apportionment_pct: z.number().min(0).max(100),
});
export type ApportionmentBody = z.infer<typeof apportionmentBody>;

/**
 * GET /v1/time-entries query — list filter.
 *
 * `subject_tenant_id` is required — every read is scoped to a single
 * claimant. `from`/`to` are inclusive date strings (YYYY-MM-DD); the
 * route translates them to timestamptz bounds. `include_flagged`
 * defaults to false to match the apportionment-workbench "needs
 * review" toggle: callers that explicitly want the flagged rows
 * (workbench triage view) opt in.
 *
 * `z.coerce.boolean()` on `include_flagged` accepts both the JSON
 * boolean (`true`) and the URL-string ('true'/'false') — the API is
 * called both from server-side (Next.js fetch) and from the URL bar
 * during debugging.
 */
export const listTimeEntriesQuery = z.object({
  subject_tenant_id: Uuid,
  employee_id: Uuid.optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  include_flagged: z.coerce.boolean().default(false),
});
export type ListTimeEntriesQuery = z.infer<typeof listTimeEntriesQuery>;
