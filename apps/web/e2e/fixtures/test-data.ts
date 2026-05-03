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
 * Delete subject_tenants whose name matches a prefix, plus their
 * dependent rows in the correct FK-cascade order:
 *
 *   1. activity (FK → claim, project; tenant_id pinned via tenant)
 *   2. claim (FK → subject_tenant)
 *   3. project (FK → subject_tenant)
 *   4. event (FK → subject_tenant only — NOT to activity/claim/project,
 *      even though A10 register events embed `activity_id` inside the
 *      payload jsonb. The DB-level relationship is purely
 *      `event.subject_tenant_id → subject_tenant.id`; the activity_id
 *      pointer is application-level and is what powers the register
 *      filter in events.ts (`payload->>'activity_id' = $1`).)
 *   5. subject_tenant_user (FK → subject_tenant, user)
 *   6. subject_tenant
 *
 * Each DELETE is scoped to subject_tenants matching the prefix; rows
 * belonging to other test prefixes are not touched. Earlier (P2) specs
 * only seeded events under a subject_tenant, so this teardown was
 * simpler — A10 added project/claim/activity seeding which hangs
 * additional rows off the same subject_tenant, hence the wider sweep.
 */
export async function cleanupSubjectTenantsByNamePrefix(prefix: string): Promise<void> {
  await privilegedSql`DELETE FROM activity
                       WHERE claim_id IN (
                         SELECT c.id FROM claim c
                          JOIN subject_tenant st ON st.id = c.subject_tenant_id
                          WHERE st.name LIKE ${prefix + '%'}
                       )`;
  await privilegedSql`DELETE FROM claim
                       WHERE subject_tenant_id IN (
                         SELECT id FROM subject_tenant WHERE name LIKE ${prefix + '%'}
                       )`;
  await privilegedSql`DELETE FROM project
                       WHERE subject_tenant_id IN (
                         SELECT id FROM subject_tenant WHERE name LIKE ${prefix + '%'}
                       )`;
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

/**
 * Seed a project under a subject_tenant. Returns the project id.
 *
 * Used by A-swimlane e2e specs (T-A10) to seed list/detail surfaces.
 * Pair with `cleanupSubjectTenantsByNamePrefix` (which now cascades
 * through activity → claim → project) to keep teardown a single call.
 *
 * Defaults `started_at` to "one year ago" so the row sorts naturally
 * alongside ad-hoc test data without colliding with `now()`-based
 * created_at timestamps elsewhere in the suite.
 */
export interface SeedProjectInput {
  tenantId: string;
  subjectTenantId: string;
  name: string;
  description?: string | null;
  startedAt?: Date;
  endedAt?: Date | null;
  archivedAt?: Date | null;
}

export async function seedProject(input: SeedProjectInput): Promise<string> {
  const id = crypto.randomUUID();
  const startedAt = input.startedAt ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const startedAtIso = startedAt.toISOString();
  const endedAtIso = input.endedAt ? input.endedAt.toISOString() : null;
  const archivedAtIso = input.archivedAt ? input.archivedAt.toISOString() : null;
  await privilegedSql`
    INSERT INTO project (id, tenant_id, subject_tenant_id, name, description,
                         started_at, ended_at, archived_at)
    VALUES (
      ${id}, ${input.tenantId}, ${input.subjectTenantId}, ${input.name},
      ${input.description ?? null},
      ${startedAtIso}::timestamptz,
      ${endedAtIso === null ? null : endedAtIso}::timestamptz,
      ${archivedAtIso === null ? null : archivedAtIso}::timestamptz
    )
  `;
  return id;
}

/**
 * Seed a claim under a subject_tenant. Returns the claim id.
 *
 * `(subject_tenant_id, fiscal_year)` is uniquely-indexed (one claim per
 * claimant per fiscal year — matches AusIndustry's one-registration-per-
 * entity-per-year rule). Tests should pick distinct `fiscalYear` values
 * if they seed multiple claims under the same claimant.
 */
export interface SeedClaimInput {
  tenantId: string;
  subjectTenantId: string;
  fiscalYear: number;
  stage?: string;
}

export async function seedClaim(input: SeedClaimInput): Promise<string> {
  const id = crypto.randomUUID();
  const stage = input.stage ?? 'narrative_drafting';
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage)
    VALUES (${id}, ${input.tenantId}, ${input.subjectTenantId}, ${input.fiscalYear}, ${stage})
  `;
  return id;
}

/**
 * Seed an activity under a project + claim. Returns the activity id.
 *
 * `code` must match `^(CA|SA)-\d{2,3}$` (CHECK constraint
 * activity_code_format in 0012); tests should default to `CA-001` /
 * `SA-001` etc. `kind` ('core' | 'supporting') must agree with the
 * `code` prefix (CA = core, SA = supporting).
 */
export interface SeedActivityInput {
  tenantId: string;
  projectId: string;
  claimId: string;
  code: string;
  kind: 'core' | 'supporting';
  title: string;
  description?: string | null;
  hypothesis?: string | null;
  technicalUncertainty?: string | null;
  experimentationLog?: string | null;
  expectedOutcome?: string | null;
  actualOutcome?: string | null;
  // P7 Theme A: required NOT NULL with no DEFAULT — explicit values
  // ensure tests document the FY context and the contemporaneous
  // hypothesis-formation timestamp rather than relying on `now()`.
  fyLabel?: string;
  hypothesisFormedAt?: string;
}

/**
 * Test-only helper. Production code MUST provide explicit values for
 * fyLabel and hypothesisFormedAt at INSERT time per migration 0037
 * (no DB-level DEFAULT). These fixture defaults exist solely for
 * test ergonomics.
 */
export async function seedActivity(input: SeedActivityInput): Promise<string> {
  const id = crypto.randomUUID();
  const fyLabel = input.fyLabel ?? 'FY25';
  const hypothesisFormedAt = input.hypothesisFormedAt ?? '2025-01-01T00:00:00Z';
  await privilegedSql`
    INSERT INTO activity (id, tenant_id, project_id, claim_id, code, kind, title,
                          description, hypothesis, technical_uncertainty,
                          experimentation_log, expected_outcome, actual_outcome,
                          fy_label, hypothesis_formed_at)
    VALUES (
      ${id}, ${input.tenantId}, ${input.projectId}, ${input.claimId},
      ${input.code}, ${input.kind}, ${input.title},
      ${input.description ?? null},
      ${input.hypothesis ?? null},
      ${input.technicalUncertainty ?? null},
      ${input.experimentationLog ?? null},
      ${input.expectedOutcome ?? null},
      ${input.actualOutcome ?? null},
      ${fyLabel}, ${hypothesisFormedAt}
    )
  `;
  return id;
}
