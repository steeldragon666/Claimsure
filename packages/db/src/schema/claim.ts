import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { project } from './project.js';
import { subjectTenant } from './subject_tenant.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * R&DTI claim — one fiscal-year submission per `subject_tenant`. The
 * top-level container for the 7-stage Module 4 pipeline (engagement →
 * scoping → drafting → review → finalising → submitting → submitted),
 * per design doc §"Core tables".
 *
 * Uniqueness: `(subject_tenant_id, fiscal_year)` — each claimant gets
 * exactly one claim row per fiscal year. AusIndustry only accepts one
 * registration per entity per year, so this matches the regulator
 * model.
 *
 * `fiscal_year` follows Australian convention: `2025` = FY ending June
 * 2025 (i.e. 1 July 2024 – 30 June 2025).
 *
 * `stage` is the 7-stage pipeline state. Default `'engagement'` because
 * a freshly-created claim begins at the kickoff/scoping conversation.
 * F2 will add a CHECK constraint enforcing the valid enum values
 * server-side; we leave `stage` as plain `text` here so the migration
 * generator emits a vanilla TEXT column the F2 hand-authored block can
 * augment.
 *
 * `ausindustry_reference` carries the regulator-issued registration ID
 * once the claim is submitted (only known post-submission, hence
 * nullable). `submitted_at` / `submitted_by_user_id` mark the
 * submission event for audit trail.
 *
 * RLS-protected (F2 hand-authors): tenant_id =
 *   current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain).
 */

/**
 * Single source of truth for claim pipeline stages.
 *
 * Keep in sync with the `claim_stage_valid` CHECK constraint in
 * `migrations/0012_hard_titania.sql`. The Drizzle column type uses
 * `text({ enum: CLAIM_STAGES })` to narrow the TS type to this union,
 * so any divergence between this array and the SQL CHECK would surface
 * as a runtime constraint violation on insert/update.
 *
 * Consumers across the workspace (API routes, web components) should
 * import from this file rather than redeclare the list — duplicated
 * literal arrays drift silently and cannot be caught by the type
 * checker.
 */
export const CLAIM_STAGES = [
  'engagement',
  'activity_capture',
  'narrative_drafting',
  'expenditure_schedule',
  'review',
  'submitted',
  'audit_defence',
] as const;
export type ClaimStage = (typeof CLAIM_STAGES)[number];

/**
 * Wizard Step 1 engagement-status lifecycle (migration 0085). SOT for
 * the union — declared here (not engagement_letter.ts) because the
 * `engagement_status` column lives on `claim`; engagement_letter.ts
 * imports this constant rather than redeclaring it (avoids drift and a
 * duplicate barrel export).
 *
 * Keep in sync with the `engagement_status` CHECK constraint defined
 * in migration 0087 — divergence surfaces as a CHECK violation at
 * write time (see CLAIM_STAGES precedent above).
 *
 *   `pending_send` — letter not yet sent to claimant (default on insert)
 *   `sent`         — letter sent, awaiting signature
 *   `signed`       — claimant signed (counter-sign may still be pending)
 *   `declined`     — claimant declined; carries `declined_reason`
 *   `expired`      — no signature within the configured window
 */
export const ENGAGEMENT_STATUSES = [
  'pending_send',
  'sent',
  'signed',
  'declined',
  'expired',
] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export const claim = pgTable(
  'claim',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    subjectTenantId: uuid('subject_tenant_id')
      .notNull()
      .references(() => subjectTenant.id),
    // Denormalised FK to the project this claim covers (P5 Theme 1.1).
    // Nullable because pre-P5 claims may have no activities yet, in
    // which case there's no project to point at. Backfill in
    // 0019_claim_project_id.sql copies activity.project_id for claims
    // that already have activities; claims without activities stay NULL.
    // Identity uniqueness remains (subject_tenant_id, fiscal_year);
    // project_id is descriptive, not part of the claim's natural key.
    projectId: uuid('project_id').references(() => project.id),
    // Australian fiscal year: 2025 = FY ending June 2025.
    fiscalYear: integer('fiscal_year').notNull(),
    // 7-stage pipeline; CHECK constraint enumerating valid values is
    // hand-authored in 0012 (see DO-NOT-REGENERATE header in the .sql file).
    stage: text('stage', { enum: CLAIM_STAGES }).notNull().default('engagement'),
    ausindustryReference: text('ausindustry_reference'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedByUserId: uuid('submitted_by_user_id').references(() => user.id),
    // Wizard state (migration 0081). NULL = legacy claim (renders the
    // existing tabbed UI); non-null = new wizard claim. Shape validated
    // at application layer by Zod — no jsonb_check constraint. Entry
    // shape: { initialized_at: ISO, steps: { '1'..'5': null |
    // { agreed_at: ISO, agreed_by: <user_uuid> } } }. NO DEFAULT — the
    // null sentinel distinguishes legacy from wizard claims.
    workflowState: jsonb('workflow_state'),
    // Wizard Step 1 engagement-letter status (migration 0085). Drives
    // the wizard's first step gate. NOT NULL with default 'pending_send'
    // so existing claim rows backfill automatically. CHECK constraint
    // narrows to ENGAGEMENT_STATUSES — see the const JSDoc above.
    engagementStatus: text('engagement_status', { enum: ENGAGEMENT_STATUSES })
      .notNull()
      .default('pending_send'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    tenantIdx: index('claim_tenant_idx').on(t.tenantId),
    subjectTenantIdx: index('claim_subject_tenant_idx').on(t.subjectTenantId),
    projectIdx: index('claim_project_id_idx').on(t.projectId),
    subjectTenantFiscalYearUnique: uniqueIndex('claim_subject_tenant_fiscal_year_unique').on(
      t.subjectTenantId,
      t.fiscalYear,
    ),
  }),
);
