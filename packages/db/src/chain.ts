import crypto from 'node:crypto';
import { sql } from './client.js';

export type EventForHashing = {
  subject_tenant_id: string;
  kind: string;
  payload: unknown;
  classification: unknown;
  captured_at: Date;
  captured_by_user_id: string;
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
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k]))
      .join(',') +
    '}'
  );
}

export function canonicaliseEvent(e: EventForHashing): string {
  return canonicalJsonStringify({
    subject_tenant_id: e.subject_tenant_id,
    kind: e.kind,
    payload: e.payload,
    classification: e.classification,
    captured_at: e.captured_at.toISOString(),
    captured_by_user_id: e.captured_by_user_id,
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
    await tx`
      INSERT INTO event (
        id, tenant_id, subject_tenant_id, project_id, milestone_id, kind,
        payload, classification,
        override_of_event_id, override_new_kind, override_reason,
        prev_hash, hash, idempotency_key,
        captured_at, captured_by_user_id
      ) VALUES (
        ${id}, ${input.tenant_id}, ${input.subject_tenant_id},
        ${input.project_id ?? null}, ${input.milestone_id ?? null}, ${input.kind},
        ${input.payload as never}::jsonb, ${input.classification as never}::jsonb,
        ${input.override_of_event_id ?? null},
        ${input.override_new_kind ?? null},
        ${input.override_reason ?? null},
        ${prevHash}, ${newHash}, ${input.idempotency_key ?? null},
        ${input.captured_at}, ${input.captured_by_user_id}
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
  const rows = await sql<
    (EventForHashing & {
      id: string;
      prev_hash: string | null;
      hash: string;
      received_at: Date;
    })[]
  >`
    SELECT
      id, subject_tenant_id, kind, payload, classification,
      captured_at, captured_by_user_id, received_at,
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
    const expected = hashEvent(prev, {
      subject_tenant_id: e.subject_tenant_id,
      kind: e.kind,
      payload: e.payload,
      classification: e.classification,
      captured_at: new Date(e.captured_at),
      captured_by_user_id: e.captured_by_user_id,
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
