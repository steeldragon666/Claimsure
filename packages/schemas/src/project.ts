import { z } from 'zod';
import { Iso8601, Uuid } from './primitives.js';

/**
 * Long-lived R&D undertaking grouping activities across one or more
 * fiscal-year claims. Mirrors the storage shape in
 * `packages/db/src/schema/project.ts` (per design doc §"Core tables").
 *
 * Snake_case JSON keys to match the rest of the wire format. Timestamps
 * are ISO-8601 with offset (audit-anchor convention).
 *
 * `archived_at` is the soft-delete marker — archived projects stay
 * queryable for prior-year claims but are filtered from default active
 * lists.
 */
export const Project = z.object({
  id: Uuid,
  tenant_id: Uuid,
  subject_tenant_id: Uuid,
  name: z.string().min(1).max(200),
  description: z.string().nullable(),
  started_at: Iso8601,
  ended_at: Iso8601.nullable(),
  archived_at: Iso8601.nullable(),
  created_at: Iso8601,
  updated_at: Iso8601,
});
export type Project = z.infer<typeof Project>;

/**
 * POST /v1/projects body. `description` and `ended_at` are optional —
 * a freshly-created project may have no end date and only a one-line
 * title until the consultant fleshes it out.
 *
 * `tenant_id` is derived from the session, not the body.
 *
 * `.refine()` rejects an inverted date range — `ended_at >= started_at`
 * when both are present. Mirrors the `createManualTimeEntryBody` pattern
 * (compares via `new Date()` to be safe across timezone offsets).
 */
export const CreateProjectBody = z
  .object({
    subject_tenant_id: Uuid,
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    started_at: Iso8601,
    ended_at: Iso8601.optional(),
  })
  .refine((b) => b.ended_at == null || new Date(b.started_at) <= new Date(b.ended_at), {
    message: 'ended_at must be on or after started_at',
    path: ['ended_at'],
  });
export type CreateProjectBody = z.infer<typeof CreateProjectBody>;

/**
 * PATCH /v1/projects/:id body — partial update.
 *
 * Identity / lifecycle markers (`subject_tenant_id`, `archived_at`,
 * `created_at`, `updated_at`) are NOT updatable through this body:
 *   - moving a project between claimants requires a separate flow
 *     (out of scope for P4),
 *   - archive uses DELETE /v1/projects/:id (sets `archived_at`),
 *   - timestamps are server-managed.
 *
 * `description` and `ended_at` accept null so the consultant can
 * explicitly clear them — the `.nullable().optional()` chain mirrors
 * `UpdateActivityBody`.
 *
 * `.strict()` rejects unknown keys with a 400 — protects against
 * silent typos like `{starts_at: ...}` (note the `s`).
 *
 * `.refine()` fires ONLY when both `started_at` and `ended_at` are
 * present in the patch — that's the simple cross-field case we can
 * validate without the existing row. The fuller cross-field check
 * (combining patch with the existing row when only one of the two is
 * being updated) lives in the route handler in `apps/api/src/routes/
 * projects.ts`.
 */
export const UpdateProjectBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    started_at: Iso8601.optional(),
    ended_at: Iso8601.nullable().optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.started_at === undefined ||
      b.ended_at === undefined ||
      b.ended_at === null ||
      new Date(b.started_at) <= new Date(b.ended_at),
    { message: 'ended_at must be on or after started_at', path: ['ended_at'] },
  );
export type UpdateProjectBody = z.infer<typeof UpdateProjectBody>;

/**
 * GET /v1/projects query.
 *
 * `subject_tenant_id` (optional): narrows further within a firm to
 *   projects belonging to one claimant. RLS already filters cross-firm
 *   rows so this is purely a within-firm narrowing.
 *
 * `status` (default `'active'`): which archive bucket to return.
 *   - `'active'` (default): only `archived_at IS NULL` — preserves
 *     backwards compatibility with callers that don't pass the param.
 *   - `'archived'`: only `archived_at IS NOT NULL` — for surfaces that
 *     surface a "View archived" affordance.
 *   - `'all'`: both — for admin / audit views that need full visibility.
 */
export const ListProjectsQuery = z.object({
  subject_tenant_id: Uuid.optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
});
export type ListProjectsQuery = z.infer<typeof ListProjectsQuery>;

/**
 * DELETE /v1/projects/:id is a soft-delete that sets `archived_at`.
 * The optional body lets a consultant attach a free-text rationale
 * that's persisted on the PROJECT_ARCHIVED event payload.
 */
export const ArchiveProjectBody = z
  .object({
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type ArchiveProjectBody = z.infer<typeof ArchiveProjectBody>;
