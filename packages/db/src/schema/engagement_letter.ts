import { pgTable, text, timestamp, uuid, unique } from 'drizzle-orm/pg-core';
import { claim } from './claim.js';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * Per-claim engagement-letter instance (rendered markdown + signature
 * metadata + lifecycle timestamps). Sibling of the per-firm template
 * stored in `tenant.engagement_letter_template_md` — at "send" time the
 * application renders that template against the claim's variables and
 * snapshots the result into `rendered_markdown` so future template
 * edits cannot retroactively change what the claimant signed.
 *
 * Wizard Step 1 (see docs/plans/wizard-step-1/) — first in the
 * `claim.engagement_status` lifecycle: `pending_send → sent → signed`
 * (or `declined / expired`). The status column on `claim` is the gate
 * driving the wizard's first step; this table carries the underlying
 * evidence.
 *
 * **Uniqueness**: one row per claim, enforced by `one_letter_per_claim`
 * (`UNIQUE (claim_id)`). Re-sending after decline/expire updates the
 * existing row rather than inserting a sibling — keeps the audit trail
 * single-rowed and avoids ambiguity about "which letter is current".
 *
 * **send_token**: public, opaque token used by the web fallback at
 * `/engagement/[token]/sign` (mobile-first flow has the row id directly
 * via the authenticated session, so the token is only needed for the
 * email-link path). UNIQUE at the DB level; expires per
 * `send_token_expires_at`. The token is unguessable, scope-limited to
 * the single sign action, and rotates on resend.
 *
 * **pdf_evidence_id**: nullable FK to `evidence(id)` — the immutable
 * PDF rendered async via pg-boss immediately after sign (see design
 * doc Q6). NULL until the job completes. NOTE: the `evidence` table is
 * referenced in the design doc but does not yet exist in this
 * codebase; the FK in migration 0087 will not resolve until that
 * table is added in a preceding migration or the column is retargeted.
 *
 * **RLS** (hand-authored in migration 0087): tenant_id =
 *   current_setting('app.current_tenant_id', true)::uuid
 * Same fail-safe pattern as the rest of the tenant-scoped surface (an
 * unset GUC matches no rows). Positive control:
 * `apps/api/src/routes/engagement-letter.test.ts` mirrors the
 * audit-log.test.ts precedent.
 *
 * **Layering**: column shapes here mirror the SQL in migration 0087
 * verbatim — Drizzle is the read/write surface, the SQL is the SOT for
 * the storage schema. Any divergence (e.g. drift in column order or
 * nullability) surfaces as a runtime insert/select mismatch.
 *
 * Naming convention: camelCase TS / snake_case SQL (per existing
 * tenant / claim / audit_log precedent).
 */

// `ENGAGEMENT_STATUSES` / `EngagementStatus` are declared in `claim.ts`
// (where the `engagement_status` column lives). Import from
// `@cpa/db/schema` for the canonical surface — we deliberately do NOT
// re-export here to avoid duplicate barrel exports from `index.ts`'s
// `export *` aggregation.

export const engagementLetter = pgTable(
  'engagement_letter',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'restrict' }),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claim.id, { onDelete: 'cascade' }),
    renderedMarkdown: text('rendered_markdown').notNull(),
    templateVersion: text('template_version').notNull(),
    sendToken: text('send_token').unique(),
    sendTokenExpiresAt: timestamp('send_token_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentToClaimantAt: timestamp('sent_to_claimant_at', { withTimezone: true }),
    signedByClaimantAt: timestamp('signed_by_claimant_at', { withTimezone: true }),
    signedByClaimantName: text('signed_by_claimant_name'),
    // inet is stored as text on the Drizzle side — postgres-js encodes
    // strings directly into the inet column and `inet` casting on read
    // surfaces as text in JS. Validate format at the API layer.
    signedByClaimantIp: text('signed_by_claimant_ip'),
    signedByClaimantUa: text('signed_by_claimant_ua'),
    countersignedByUserId: uuid('countersigned_by_user_id').references(() => user.id),
    countersignedAt: timestamp('countersigned_at', { withTimezone: true }),
    // FK to evidence(id) at the SQL layer; no Drizzle `references()` here
    // because the `evidence` table is not modelled in @cpa/db yet (see
    // JSDoc above + migration 0087 NOTE).
    pdfEvidenceId: uuid('pdf_evidence_id'),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    declinedReason: text('declined_reason'),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    // Wizard Step 1 Task 04 (migration 0088) — idempotency bookmarks
    // for the daily engagement-reminder-tick pg-boss job. Set in the
    // same UPDATE…RETURNING that queues the email, so a same-day
    // re-run of the job filters the row out via `IS NULL` predicate.
    // 30-day auto-expire piggy-backs on `expired_at` + `engagement_status`
    // and needs no extra bookmark.
    remindedAt7d: timestamp('reminded_7d_at', { withTimezone: true }),
    remindedAt14d: timestamp('reminded_14d_at', { withTimezone: true }),
  },
  (t) => ({
    oneLetterPerClaim: unique('one_letter_per_claim').on(t.claimId),
  }),
);
