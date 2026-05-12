import { z } from 'zod';
import { Iso8601, Uuid } from './primitives.js';
import { DeliveryKindEnum } from './billing.js';

/**
 * Single source of truth for claim pipeline stages over the wire.
 *
 * Dual SOT pattern: `@cpa/schemas` (Zod, wire format) and `@cpa/db`
 * (Drizzle, storage) are intentionally independent SOTs — `@cpa/db`
 * depends on `@cpa/schemas` (one-way), so importing `CLAIM_STAGES` from
 * `@cpa/db/schema` here would invert the layering and pull storage
 * internals into the wire contract. The two lists must therefore be
 * kept in sync by hand.
 *
 * KEEP IN SYNC WITH:
 *   1. `CLAIM_STAGES` in `@cpa/db/schema/claim.ts`
 *   2. The `claim_stage_valid` CHECK in `migrations/0012_hard_titania.sql`
 *
 * Order matches `@cpa/db` byte-for-byte.
 */
export const CLAIM_STAGES_LITERAL = [
  'engagement',
  'activity_capture',
  'narrative_drafting',
  'expenditure_schedule',
  'review',
  'submitted',
  'audit_defence',
] as const;
export const ClaimStage = z.enum(CLAIM_STAGES_LITERAL);
export type ClaimStage = z.infer<typeof ClaimStage>;

/**
 * Public shape of a `claim` row over the API.
 *
 * `fiscal_year` follows Australian convention: `2025` = FY ending June
 * 2025 (1 July 2024 – 30 June 2025).
 *
 * `ausindustry_reference` carries the regulator-issued registration ID
 * (only known post-submission, hence nullable). `submitted_at` /
 * `submitted_by_user_id` mark the submission event for audit trail.
 */
export const Claim = z.object({
  id: Uuid,
  tenant_id: Uuid,
  subject_tenant_id: Uuid,
  fiscal_year: z.number().int(),
  stage: ClaimStage,
  delivery_kind: DeliveryKindEnum.nullable(),
  ausindustry_reference: z.string().nullable(),
  submitted_at: Iso8601.nullable(),
  submitted_by_user_id: Uuid.nullable(),
  created_at: Iso8601,
  updated_at: Iso8601,
  is_wizard_claim: z.boolean(),
});
export type Claim = z.infer<typeof Claim>;

/**
 * POST /v1/claims body. `stage` defaults to `'engagement'` server-side;
 * callers that want to seed a claim mid-pipeline (e.g. importing a
 * partially-completed prior-year submission) can supply it explicitly.
 *
 * `ausindustry_reference` is generally null at create time — populated
 * post-submission via the regulator integration.
 *
 * `tenant_id` is derived from the session, not the body.
 */
export const CreateClaimBody = z.object({
  subject_tenant_id: Uuid,
  fiscal_year: z.number().int(),
  stage: ClaimStage.optional(),
  ausindustry_reference: z.string().min(1).max(200).optional(),
});
export type CreateClaimBody = z.infer<typeof CreateClaimBody>;

/**
 * PATCH /v1/claims/:id/stage body. Used to advance the claim through
 * the 7-stage pipeline. The route handler validates the source stage
 * and emits a `CLAIM_STAGE_ADVANCED` event.
 */
export const UpdateClaimStageBody = z.object({
  to_stage: ClaimStage,
});
export type UpdateClaimStageBody = z.infer<typeof UpdateClaimStageBody>;

/**
 * PATCH /v1/claims/:id body — submission-related partial update.
 *
 * `ausindustry_reference` is the regulator-issued registration ID,
 * populated post-submission (the regulator returns it once the lodgment
 * is accepted). The route handler enforces stage === 'submitted' before
 * allowing the column to be set.
 *
 * `submitted_at` is auto-stamped by the stage advance to 'submitted',
 * but the client may override it (e.g. to record an actual lodgment
 * time that differs from the in-app stage transition).
 *
 * `.strict()` rejects unknown keys with a 400 — protects against
 * silent typos like `{ausi_reference: ...}`.
 */
export const UpdateClaimBody = z
  .object({
    ausindustry_reference: z.string().min(1).max(200).optional(),
    submitted_at: Iso8601.optional(),
  })
  .strict();
export type UpdateClaimBody = z.infer<typeof UpdateClaimBody>;

/**
 * GET /v1/claims query — pipeline filter.
 *
 * `subject_tenant_id` narrows to one claimant; `stage` narrows to one
 * pipeline stage; `assignee` narrows to claims assigned to one user
 * (TODO: `claim_assignee` table doesn't exist yet, so the param is
 * accepted but currently a no-op — wire-up in a later swimlane).
 * `fiscal_year` narrows to one Australian FY (e.g. 2025 = FY ending
 * June 2025).
 *
 * RLS already filters cross-firm rows; these filters narrow further
 * within a firm.
 */
export const ListClaimsQuery = z.object({
  subject_tenant_id: Uuid.optional(),
  stage: ClaimStage.optional(),
  assignee: Uuid.optional(),
  fiscal_year: z.coerce.number().int().optional(),
  // P5 swimlane D Task 4.2: narrow to claims rolling up a single
  // project. Uses the denormalised claim.project_id FK landed by P5
  // swimlane A Task 1.1.
  project_id: Uuid.optional(),
});
export type ListClaimsQuery = z.infer<typeof ListClaimsQuery>;
