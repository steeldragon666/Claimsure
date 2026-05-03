import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';
import { user } from './user.js';

/**
 * Firm-scoped audit log (P5 Theme 2 keystone).
 *
 * Persists lifecycle events that don't belong on the per-subject_tenant
 * `event` chain — initially the B9 mapping-rule lifecycle
 * (CREATED/UPDATED/ARCHIVED). The `event` table requires a NOT NULL
 * `subject_tenant_id`, but mapping rules are firm-scoped (no subject
 * tenant to anchor on); this table fills that gap.
 *
 * **No hash chain in v1.** Locked decision (design doc §2.1): "no
 * claimant evidence is silently mutated" is the chain's value prop, and
 * firm-scoped audit doesn't meet that bar. Adding a chain later is a
 * column add + backfill — reversible.
 *
 * **Naming**: in this codebase, `firm_id` IS a `tenant.id`. The FK
 * references `tenant(id)` directly. The GUC `app.current_firm_id`
 * carries the same uuid as `app.current_tenant_id`; both are set in
 * parallel by the auth layer (see `packages/auth/src/session.ts`).
 * Two GUCs (not one) so future phases can introduce a "platform admin
 * acting as firm X" stance where the two diverge.
 *
 * **RLS**: hand-authored in 0022_audit_log_table.sql. The policy is
 *   firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::uuid
 * — NULLIF wraps current_setting so an unset GUC fails-safe to "deny
 * everything" (see 0003_nullif_unset_guc.sql commentary). Positive
 * control: `apps/api/src/routes/audit-log.test.ts` asserts FIRM_A
 * sessions cannot read FIRM_B rows.
 *
 * **Layering note (mirrors mapping_rule.ts §"Layering"):** `@cpa/db`
 * cannot import runtime values from `@cpa/schemas` for column shapes —
 * the dual-SOT pattern keeps the storage model and the wire-format
 * schemas independent (see `event.ts` JSDoc). The `payload` jsonb type
 * is annotated locally below; the canonical Zod schema lives in
 * `@cpa/schemas/audit` (Task 2.2). They must stay in sync — a Zod-
 * accepted-but-storage-rejected shape would surface as a
 * jsonb_typeof CHECK violation at write time.
 *
 * Naming convention: camelCase TS / snake_case SQL (per existing
 * tenant / event / mapping_rule precedent).
 */

/**
 * Local payload-shape annotation. Mirrors the Zod payload schemas in
 * `@cpa/schemas/audit` (`MappingRuleCreatedPayload`,
 * `MappingRuleUpdatedPayload`, `MappingRuleArchivedPayload`). Drift
 * between this list and the Zod schemas surfaces at the API boundary —
 * `insertAuditLog` accepts `AuditPayload` from `@cpa/schemas/audit`.
 *
 * Discriminator-less here (the kind column above carries the tag): we
 * union the three payload shapes so drizzle's `$type<>()` annotation
 * narrows reads to the right keys per kind. Adding a new audit kind
 * means appending here AND in the Zod sibling schema.
 */
export type AuditLogPayloadShape =
  | {
      // MAPPING_RULE_CREATED
      mapping_rule_id: string;
      name: string;
      priority: number;
      conditions: unknown;
      action: unknown;
    }
  | {
      // MAPPING_RULE_UPDATED
      mapping_rule_id: string;
      fields_changed: Record<string, { from: unknown; to: unknown }>;
    }
  | {
      // MAPPING_RULE_ARCHIVED
      mapping_rule_id: string;
      archived_by_user_id: string;
      reason?: string;
    }
  | {
      // HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION (P7 Theme A Task A.1).
      // Written by the application layer after catching the
      // check_violation raised by the immutability trigger.
      activity_id: string;
      old_hypothesis_formed_at: string; // ISO 8601 timestamp
      new_hypothesis_formed_at: string; // ISO 8601 timestamp
      attempted_by_user_id?: string;
    };

/**
 * Audit-log kind discriminator. Mirrors `AUDIT_KINDS` in
 * `@cpa/schemas/audit` (the wire-format SOT). The DB column carries no
 * CHECK constraint enumerating these values — the `audit_log_kind_nonempty`
 * CHECK is the only structural gate (kind <> ''); kind validity is
 * enforced at the API layer via the AuditKind type / AUDIT_KINDS Zod
 * enum. Future audit kinds add here, in the Zod enum, and in any
 * insert paths that now narrow against the union.
 */
export const AUDIT_KINDS = [
  'MAPPING_RULE_CREATED',
  'MAPPING_RULE_UPDATED',
  'MAPPING_RULE_ARCHIVED',
  // P7 Theme A Task A.1 (Q-Fix5=A locked decision). Mirror of the
  // `@cpa/schemas/audit.ts` enum + the `audit_log_kind_check` SQL CHECK
  // added in migration 0037 — the three sites must stay in set-membership
  // lock-step (declaration order is NOT enforced; the parity test uses
  // sorted-array equality and `pg_get_constraintdef` does not preserve
  // the original IN-list ordering anyway).
  // See the THREE-WAY PARITY note in the JSDoc above.
  'HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => tenant.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: AUDIT_KINDS }).notNull(),
    payload: jsonb('payload').$type<AuditLogPayloadShape>().notNull(),
    actorUserId: uuid('actor_user_id').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('audit_log_firm_idx').on(t.firmId, t.createdAt.desc()),
    kindIdx: index('audit_log_kind_idx').on(t.firmId, t.kind, t.createdAt.desc()),
  }),
);
