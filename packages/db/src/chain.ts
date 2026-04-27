import crypto from 'node:crypto';
import { privilegedSql, sql } from './client.js';

export type EventForHashing = {
  subject_tenant_id: string;
  kind: string;
  payload: unknown;
  classification: unknown;
  captured_at: Date;
  // EITHER captured_by_user_id (consultant capture) OR
  // captured_by_employee_id (mobile-employee capture); exactly one
  // populated, enforced by the DB CHECK in migration 0011. The
  // canonicaliser preserves backward compat for P2 events (which
  // were always user_id) by conditionally OMITTING captured_by_employee_id
  // when null/undefined — see canonicaliseEvent below.
  captured_by_user_id: string | null;
  captured_by_employee_id?: string | null;
  override_of_event_id: string | null;
  override_new_kind: string | null;
  override_reason: string | null;
};

function canonicalJsonStringify(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(
      `canonicalJsonStringify: non-finite number (NaN/Infinity) is not JSON-representable; reject before hashing`,
    );
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k])).join(',') + '}'
  );
}

export function canonicaliseEvent(e: EventForHashing): string {
  // captured_by_employee_id is conditionally included only when non-null
  // so existing P2 events (which never had this field) produce the
  // identical canonical bytes — and therefore the same SHA-256 hash —
  // they had pre-migration. New mobile events (employee_id set,
  // user_id null) get a different canonical shape; no collision.
  return canonicalJsonStringify({
    subject_tenant_id: e.subject_tenant_id,
    kind: e.kind,
    payload: e.payload,
    classification: e.classification,
    captured_at: e.captured_at.toISOString(),
    captured_by_user_id: e.captured_by_user_id,
    ...(e.captured_by_employee_id != null
      ? { captured_by_employee_id: e.captured_by_employee_id }
      : {}),
    override_of_event_id: e.override_of_event_id ?? null,
    override_new_kind: e.override_new_kind ?? null,
    override_reason: e.override_reason ?? null,
  });
}

export function hashEvent(prevHash: string | null, e: EventForHashing): string {
  const buf = (prevHash ?? '') + canonicaliseEvent(e);
  return crypto.createHash('sha256').update(buf, 'utf8').digest('hex');
}

export type InsertEventInput = EventForHashing & {
  tenant_id: string;
  project_id?: string | null;
  milestone_id?: string | null;
  idempotency_key?: string | null;
};

export type InsertedEvent = {
  id: string;
  prev_hash: string | null;
  hash: string;
};

/**
 * Inserts an event with deterministic hash-chain extension.
 * Holds a per-subject_tenant transaction-scoped advisory lock so concurrent
 * inserts against the same chain serialise (concurrent inserts against
 * different chains do NOT block each other).
 */
export async function insertEventWithChain(input: InsertEventInput): Promise<InsertedEvent> {
  return await sql.begin(async (tx) => {
    // Set the request-scoped tenant context (already set by middleware in API path,
    // but explicit here makes this fn callable from tools/scripts without a request).
    await tx`SELECT set_config('app.current_tenant_id', ${input.tenant_id}, true)`;
    // Per-claimant chain lock (hashtext gives a stable bigint for a string).
    await tx`SELECT pg_advisory_xact_lock(hashtext('event_chain_' || ${input.subject_tenant_id}::text)::bigint)`;
    const prevRows = await tx<{ hash: string }[]>`
      SELECT hash FROM event
      WHERE subject_tenant_id = ${input.subject_tenant_id}
      ORDER BY captured_at DESC, received_at DESC, id DESC
      LIMIT 1
    `;
    const prevHash = prevRows[0]?.hash ?? null;
    const newHash = hashEvent(prevHash, input);
    const id = crypto.randomUUID();
    // captured_at is bound as an ISO string + ::timestamptz cast rather than
    // a raw Date. postgres-js v3.4.9 + Node 22 (CI) fails to serialise a Date
    // parameter on the prepared-statement Bind path — `Buffer.byteLength` in
    // newer Node refuses non-string/Buffer args, and the `serializers[1184]`
    // toISOString conversion isn't running before the bind for reasons we
    // didn't fully untangle. Stringifying upfront is the same pattern we use
    // for jsonb params (JSON.stringify + ::jsonb) — explicit serialisation +
    // explicit DB-side cast.
    const capturedAtIso = input.captured_at.toISOString();
    await tx`
      INSERT INTO event (
        id, tenant_id, subject_tenant_id, project_id, milestone_id, kind,
        payload, classification,
        override_of_event_id, override_new_kind, override_reason,
        prev_hash, hash, idempotency_key,
        captured_at, captured_by_user_id, captured_by_employee_id
      ) VALUES (
        ${id}, ${input.tenant_id}, ${input.subject_tenant_id},
        ${input.project_id ?? null}, ${input.milestone_id ?? null}, ${input.kind},
        ${JSON.stringify(input.payload)}::jsonb, ${input.classification === null ? null : JSON.stringify(input.classification)}::jsonb,
        ${input.override_of_event_id ?? null},
        ${input.override_new_kind ?? null},
        ${input.override_reason ?? null},
        ${prevHash}, ${newHash}, ${input.idempotency_key ?? null},
        ${capturedAtIso}::timestamptz,
        ${input.captured_by_user_id ?? null},
        ${input.captured_by_employee_id ?? null}
      )
    `;
    return { id, prev_hash: prevHash, hash: newHash };
  });
}

export type ChainStatus = {
  verified: boolean;
  head_hash: string | null;
  event_count: number;
  first_break_at: number | null;
};

export async function verifyChain(subjectTenantId: string): Promise<ChainStatus> {
  // Read via privilegedSql (cpa, RLS-bypass) because verifyChain is a
  // read-only audit function — the API layer that calls it has already
  // checked tenant access. Using sql (cpa_app) here would require us to
  // know the tenant_id and set the GUC; postgres-js's pooled connection
  // would also surface the empty-string GUC quirk if a prior call left
  // the connection "touched" but without a current tenant.
  const rows = await privilegedSql<
    (EventForHashing & {
      id: string;
      prev_hash: string | null;
      hash: string;
      received_at: Date;
    })[]
  >`
    SELECT
      id, subject_tenant_id, kind, payload, classification,
      captured_at, captured_by_user_id, captured_by_employee_id, received_at,
      override_of_event_id, override_new_kind, override_reason,
      prev_hash, hash
    FROM event
    WHERE subject_tenant_id = ${subjectTenantId}
    ORDER BY captured_at, received_at, id
  `;
  let prev: string | null = null;
  let head: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i]!;
    // Pass captured_by_employee_id through so the canonicaliser's
    // conditional include path stays consistent on re-hash; existing
    // P2 events have null here, so the include branch doesn't fire
    // and they hash identically to pre-migration values.
    // `?? null` because exactOptionalPropertyTypes makes the optional
    // `string | null` field reject `undefined` despite the SELECT
    // typing — postgres-js delivers the column as null for non-mobile rows.
    const expected = hashEvent(prev, {
      subject_tenant_id: e.subject_tenant_id,
      kind: e.kind,
      payload: e.payload,
      classification: e.classification,
      captured_at: new Date(e.captured_at),
      captured_by_user_id: e.captured_by_user_id,
      captured_by_employee_id: e.captured_by_employee_id ?? null,
      override_of_event_id: e.override_of_event_id,
      override_new_kind: e.override_new_kind,
      override_reason: e.override_reason,
    });
    if (e.prev_hash !== prev || e.hash !== expected) {
      return { verified: false, head_hash: head, event_count: rows.length, first_break_at: i };
    }
    prev = e.hash;
    head = e.hash;
  }
  return { verified: true, head_hash: head, event_count: rows.length, first_break_at: null };
}
