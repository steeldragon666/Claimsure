import crypto from 'node:crypto';
import { hashEvent, type EventForHashing } from '@cpa/db';
import { privilegedSql } from '@cpa/db/client';

/**
 * Seed a tenant. Returns the tenantId.
 *
 * Uses privilegedSql (cpa role, RLS-bypass) — e2e tests aren't testing
 * RLS, just browser flow. Each test uses a unique slug prefix
 * (e.g., 'e2e-T6-firm-alpha') so concurrent runs don't collide.
 */
export async function seedTenant(slug: string, name = `E2E ${slug}`): Promise<string> {
  const id = crypto.randomUUID();
  await privilegedSql`INSERT INTO tenant (id, name, slug, primary_idp)
                       VALUES (${id}, ${name}, ${slug}, 'mixed')`;
  return id;
}

/**
 * Seed a user. Returns the userId. external_id is derived from email
 * to keep the IdP-stable lookup contract (see W2 findOrCreateUser).
 */
export async function seedUser(email: string, displayName: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await privilegedSql`INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
                       VALUES (${id}, ${email}, 'microsoft', ${'microsoft:' + email}, ${displayName})`;
  return id;
}

/**
 * Seed a tenant_user membership row. Returns the row id.
 * Use privilegedSql so we don't need to set up an RLS context just for
 * test fixture seeding.
 */
export async function seedMembership(
  tenantId: string,
  userId: string,
  role: 'admin' | 'consultant' | 'viewer',
  isDefault = false,
): Promise<string> {
  const id = crypto.randomUUID();
  await privilegedSql`INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
                       VALUES (${id}, ${tenantId}, ${userId}, ${role}, ${isDefault})`;
  return id;
}

/**
 * Clean up tenants + tenant_user rows whose slug starts with the prefix.
 * Use this in afterAll() to remove all tenants/memberships seeded by a
 * single spec, regardless of how many tests created fixtures.
 */
export async function cleanupBySlugPrefix(prefix: string): Promise<void> {
  await privilegedSql`DELETE FROM tenant_user
                       WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE ${prefix + '%'})`;
  await privilegedSql`DELETE FROM tenant WHERE slug LIKE ${prefix + '%'}`;
}

/**
 * Clean up users + their tenant_user rows whose email starts with the
 * prefix. Pair with cleanupBySlugPrefix in afterAll.
 */
export async function cleanupByEmailPrefix(prefix: string): Promise<void> {
  await privilegedSql`DELETE FROM tenant_user
                       WHERE user_id IN (SELECT id FROM "user" WHERE email LIKE ${prefix + '%'})`;
  await privilegedSql`DELETE FROM "user" WHERE email LIKE ${prefix + '%'}`;
}

/**
 * Seed a subject_tenant (claimant or financier). Returns the subject_tenant id.
 *
 * Used by P2 event-capture e2e specs; each spec uses a unique name prefix
 * (e.g. 'e2e-T28-claimant') paired with cleanupSubjectTenantsByNamePrefix
 * in afterAll to keep parallel-but-serialised runs hygienic.
 */
export async function seedSubjectTenant(
  tenantId: string,
  name: string,
  kind: 'claimant' | 'financier' = 'claimant',
): Promise<string> {
  const id = crypto.randomUUID();
  await privilegedSql`INSERT INTO subject_tenant (id, tenant_id, name, kind)
                       VALUES (${id}, ${tenantId}, ${name}, ${kind})`;
  return id;
}

/**
 * Clean up subject_tenant rows (and their events + ACL rows) whose name
 * starts with the prefix. Mirrors cleanupBySlugPrefix shape.
 *
 * Order: events → subject_tenant_user → subject_tenant. Events reference
 * subject_tenant via FK so they have to go first, then the ACL table, then
 * the parent.
 */
export async function cleanupSubjectTenantsByNamePrefix(prefix: string): Promise<void> {
  await privilegedSql`DELETE FROM event
                       WHERE subject_tenant_id IN (
                         SELECT id FROM subject_tenant WHERE name LIKE ${prefix + '%'}
                       )`;
  await privilegedSql`DELETE FROM subject_tenant_user
                       WHERE subject_tenant_id IN (
                         SELECT id FROM subject_tenant WHERE name LIKE ${prefix + '%'}
                       )`;
  await privilegedSql`DELETE FROM subject_tenant WHERE name LIKE ${prefix + '%'}`;
}

/**
 * Insert a single event into a chain via privilegedSql, replicating the
 * deterministic prev_hash / hash extension that insertEventWithChain does
 * inside `sql.begin`.
 *
 * insertEventWithChain itself uses the cpa_app pool which RLS-restricts
 * cross-tenant reads — the t.afterAll cleanup uses privilegedSql, so for
 * test seeding we hand-roll the same chain logic on the privileged connection
 * to avoid setting up a request-scoped tenant context just for inserts.
 */
export interface SeedEventInput {
  tenantId: string;
  subjectTenantId: string;
  capturedByUserId: string;
  kind: string;
  payload: unknown;
  classification?: unknown;
  capturedAt?: Date;
}

export async function seedEvent(input: SeedEventInput): Promise<{ id: string; hash: string }> {
  const capturedAt = input.capturedAt ?? new Date();
  const classification = input.classification ?? null;

  // Read the current head hash (highest captured_at on this chain).
  const prevRows = await privilegedSql<{ hash: string }[]>`
    SELECT hash FROM event
     WHERE subject_tenant_id = ${input.subjectTenantId}
     ORDER BY captured_at DESC, received_at DESC, id DESC
     LIMIT 1
  `;
  const prevHash = prevRows[0]?.hash ?? null;

  const eventForHashing: EventForHashing = {
    subject_tenant_id: input.subjectTenantId,
    kind: input.kind,
    payload: input.payload,
    classification,
    captured_at: capturedAt,
    captured_by_user_id: input.capturedByUserId,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
  };
  const hash = hashEvent(prevHash, eventForHashing);
  const id = crypto.randomUUID();

  // captured_at bound as ISO string + ::timestamptz cast — same workaround
  // as packages/db/src/chain.ts insertEventWithChain. postgres-js + Node 22
  // doesn't round-trip Date params cleanly on the bind path.
  const capturedAtIso = capturedAt.toISOString();
  await privilegedSql`
    INSERT INTO event (
      id, tenant_id, subject_tenant_id, kind,
      payload, classification,
      override_of_event_id, override_new_kind, override_reason,
      prev_hash, hash,
      captured_at, captured_by_user_id
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.subjectTenantId}, ${input.kind},
      ${JSON.stringify(input.payload)}::jsonb, ${classification === null ? null : JSON.stringify(classification)}::jsonb,
      ${null}, ${null}, ${null},
      ${prevHash}, ${hash},
      ${capturedAtIso}::timestamptz, ${input.capturedByUserId}
    )
  `;

  return { id, hash };
}
