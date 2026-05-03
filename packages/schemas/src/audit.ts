import { z } from 'zod';
import { Uuid } from './primitives.js';

/**
 * Firm-scoped audit-log kinds (P5 Theme 2 Task 2.2).
 *
 * The three MAPPING_RULE_* kinds were originally reserved in
 * `evidenceKind` (B9), but they don't belong on the per-subject_tenant
 * `event` chain — mapping rules are firm-scoped (no subject_tenant to
 * anchor on). Task 2.2 moves them to this audit-log enum and the
 * companion `audit_log` table (Task 2.1).
 *
 * KEEP IN SYNC WITH:
 *   1. `AUDIT_KINDS` const in `@cpa/db/schema/audit_log.ts`
 *   2. `AuditLogPayloadShape` union in the same file
 *   3. `event_kind_valid` CHECK in
 *      `migrations/0023_remove_mapping_rule_from_event_kinds.sql`
 *      (which now EXCLUDES the three values)
 */
export const AUDIT_KINDS = [
  'MAPPING_RULE_CREATED',
  'MAPPING_RULE_UPDATED',
  'MAPPING_RULE_ARCHIVED',
  // P7 Theme A Task A.1 (Q-Fix5=A locked decision). Emitted by the
  // application layer when the BEFORE UPDATE trigger
  // `activity_hypothesis_formed_at_immutable` raises check_violation
  // (see migration 0037). The trigger itself does NOT INSERT to
  // audit_log (Q-Fix4=B); the wrapping API layer catches the
  // exception, rolls back its parent tx, then writes this audit row in
  // a separate tx so the violation has a durable record.
  'HYPOTHESIS_FORMED_AT_IMMUTABILITY_VIOLATION',
] as const;

/**
 * Zod-runtime version of {@link AUDIT_KINDS}. Use this for body parsing
 * / wire validation; use the const array above for type-narrowing
 * (`AuditKind`) and exhaustive-switch lookups.
 */
export const auditKind = z.enum(AUDIT_KINDS);
export type AuditKind = z.infer<typeof auditKind>;

// ---------------------------------------------------------------------------
// Payload schemas — one per audit kind. Mirror the previous shapes that
// lived in `event.ts` (MappingRuleCreatedPayload / Updated / Archived) so
// the wire format is unchanged from B9; only the table they land in moved.
// Names are suffixed with `AuditPayload` to make their target table
// explicit at the import site (vs. the deprecated `*Payload` names that
// implied the event table).
// ---------------------------------------------------------------------------

/**
 * MAPPING_RULE_CREATED — emitted when a new mapping_rule row is inserted
 * via POST /v1/mapping-rules (T-B9 + P5 Task 2.4). Carries the
 * denormalised rule body so downstream readers don't need to re-fetch
 * (mirrors the ACTIVITY_CREATED pattern).
 *
 * `conditions` and `action` are typed as `unknown` here to avoid pulling
 * B8's discriminated unions across the schemas / integrations boundary —
 * the wire format is whatever B8's runtime accepts, and the API layer
 * has already validated against B8's runtime before emitting. Readers
 * that care about the shape narrow against B8's `RuleCondition[]` /
 * `RuleAction` types.
 */
export const MappingRuleCreatedAuditPayload = z.object({
  mapping_rule_id: Uuid,
  name: z.string(),
  priority: z.number().int().nonnegative(),
  conditions: z.unknown(),
  action: z.unknown(),
});
export type MappingRuleCreatedAuditPayload = z.infer<typeof MappingRuleCreatedAuditPayload>;

/**
 * MAPPING_RULE_UPDATED — emitted on PATCH /v1/mapping-rules/:id. Same
 * `fields_changed` shape as ACTIVITY_UPDATED so consumers can render
 * field-level diffs uniformly.
 */
export const MappingRuleUpdatedAuditPayload = z.object({
  mapping_rule_id: Uuid,
  fields_changed: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
});
export type MappingRuleUpdatedAuditPayload = z.infer<typeof MappingRuleUpdatedAuditPayload>;

/**
 * MAPPING_RULE_ARCHIVED — emitted on DELETE /v1/mapping-rules/:id. The
 * route uses soft-delete (sets `enabled = false`) so the row stays
 * queryable for audit; this event flags the lifecycle transition.
 * `reason` is optional free-text.
 */
export const MappingRuleArchivedAuditPayload = z.object({
  mapping_rule_id: Uuid,
  archived_by_user_id: Uuid,
  reason: z.string().optional(),
});
export type MappingRuleArchivedAuditPayload = z.infer<typeof MappingRuleArchivedAuditPayload>;

/**
 * Discriminated-by-kind union of every audit payload. Useful for the
 * `insertAuditLog` writer (Task 2.3) which needs to narrow against the
 * kind/payload pair at the call site.
 *
 * Pattern: `Extract<AuditPayload, { __kind: 'MAPPING_RULE_CREATED' }>`
 * is awkward because the runtime payloads don't carry a kind field
 * (the kind is a sibling column in `audit_log`). Instead, callers pass
 * `kind` and `payload` separately and TS narrows at the call site via
 * the writer's overloads (or uses the union below as a type-only
 * upper bound). This matches the `evidenceKind` / `payload: unknown`
 * shape in event.ts.
 */
export type AuditPayload =
  | MappingRuleCreatedAuditPayload
  | MappingRuleUpdatedAuditPayload
  | MappingRuleArchivedAuditPayload;

/**
 * Wire-format shape of an audit_log row, returned by future
 * GET /v1/audit-log endpoints (out of scope for P5; the schema is
 * declared here so consumers can validate when those land).
 *
 * Snake_case JSON to match the existing event-row wire format.
 */
export const auditLogRow = z.object({
  id: Uuid,
  firm_id: Uuid,
  kind: auditKind,
  payload: z.unknown(),
  actor_user_id: Uuid.nullable(),
  created_at: z.coerce.date(),
});
export type AuditLogRow = z.infer<typeof auditLogRow>;
