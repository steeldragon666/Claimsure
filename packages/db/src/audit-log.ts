import type { TransactionSql } from 'postgres';
import type { AuditKind, AuditPayload } from '@cpa/schemas';

/**
 * Writer helper for the firm-scoped `audit_log` table (P5 Task 2.3).
 *
 * Accepts the caller's `tx` (a `postgres.TransactionSql`) so the insert
 * participates in the same transaction as the surrounding business
 * logic. Pattern: the route handler opens `sql.begin`, sets the firm
 * GUC, runs the domain mutation, and emits the audit row in the same
 * `tx`. If the domain mutation rolls back, so does the audit row —
 * preventing the "audit says happened but DB says no" inconsistency.
 *
 * **Why pass `tx` instead of opening one here?** Two reasons:
 *
 *   1. Atomicity: the mutation + the audit emission must be one unit
 *      of work (see audit-log.test.ts "rollback nukes the row"). A
 *      helper that opens its own tx would commit the audit row
 *      independently, leaving stale audit history if the mutation
 *      fails after the audit succeeds.
 *
 *   2. RLS context: `app.current_firm_id` is set with `is_local=true`
 *      inside the caller's `sql.begin`. A nested `sql.begin` would
 *      inherit the GUC (postgres-js shares the connection), but the
 *      nesting would unwind before the outer commit, so the WITH CHECK
 *      on the policy could fire against an unset GUC if the connection
 *      pool re-orders. Single tx → single GUC scope → no race.
 *
 * **GUC requirement**: the caller MUST have set
 * `app.current_firm_id = ${firmId}` inside the same tx before calling
 * this helper, OR be running as the privileged role (RLS bypass). The
 * RLS policy USING + WITH CHECK clauses on audit_log enforce
 * firm_id = current_setting(...)::uuid; an INSERT with the wrong GUC
 * raises "row violates row-level security policy". Tests in
 * `apps/api/src/routes/audit-log.test.ts` cover both branches.
 *
 * **Payload encoding**: bind a JSON-text string with the SQL-side
 * double cast `::text::jsonb`. The writer is called from both
 * `sql.begin → tx` (route handler, cpa_app role — global `sql` was
 * passed through `drizzle(sql)` which overwrote `serializers[3802]`
 * with an identity passthrough) and `privilegedSql.begin → tx`
 * (writer unit tests — default `JSON.stringify` serializer). The
 * double cast pins the parameter wire type to TEXT (postgres oid 25),
 * whose serializer is consistent across both contexts (default
 * `'' + x` and drizzle identity both no-op on strings). Postgres
 * then casts text → jsonb on the server side, producing a proper
 * jsonb object regardless of which client opened the tx.
 *
 * Failure modes of the rejected alternatives (each tried on this
 * branch and observed in CI):
 *
 *   - `${object}` (bare) under sql/cpa_app: drizzle's identity passes
 *     the raw Object to `Buffer.byteLength`, Node 22 throws
 *     "Received an instance of Object" (CI 25166962997 / 25167769866).
 *   - `${JSON.stringify(payload)}::jsonb` under privilegedSql: the
 *     default JSON.stringify serializer runs on the already-JSON
 *     string, producing a jsonb SCALAR STRING that trips the
 *     `audit_log_payload_object` CHECK (CI 25160635668).
 *
 * @param opts.tx           caller's transaction client (`postgres.TransactionSql`)
 * @param opts.firmId       audit_log.firm_id (= consultant tenant id)
 * @param opts.kind         one of AUDIT_KINDS
 * @param opts.payload      the kind-specific payload (validated by Zod
 *                          at the wire boundary; this writer trusts it)
 * @param opts.actorUserId  the user who triggered the change, or null
 *                          for system-emitted rows
 * @returns the new row's id and DB-generated created_at
 */
export async function insertAuditLog(opts: {
  tx: TransactionSql;
  firmId: string;
  kind: AuditKind;
  payload: AuditPayload;
  actorUserId: string | null;
}): Promise<{ id: string; created_at: Date }> {
  // Pre-stringify and use the `::text::jsonb` double cast so the same
  // writer works under both `sql.begin → tx` (drizzle-mutated identity
  // serializer) and `privilegedSql.begin → tx` (default JSON.stringify
  // serializer). See JSDoc above for the rejected alternatives.
  const payloadJson = JSON.stringify(opts.payload);
  const rows = await opts.tx<{ id: string; created_at: Date }[]>`
    INSERT INTO audit_log (firm_id, kind, payload, actor_user_id)
    VALUES (${opts.firmId}, ${opts.kind}, ${payloadJson}::text::jsonb, ${opts.actorUserId})
    RETURNING id, created_at
  `;
  const row = rows[0];
  if (!row) {
    // Should be unreachable — RETURNING on a single-row INSERT always
    // emits a row when the insert succeeds. If we land here, the DB
    // dropped the RETURNING (driver bug, not a logical error).
    throw new Error('insertAuditLog: INSERT returned no row');
  }
  return row;
}
