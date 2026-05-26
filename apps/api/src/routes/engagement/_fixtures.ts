import { signSession } from '@cpa/auth';
import { privilegedSql } from '@cpa/db/client';

/**
 * Shared per-test fixtures for the engagement-letter route suite.
 *
 * Disjoint UUID namespace (`0e2XXX`) from the schema-level RLS test
 * (`0e1XXX` in engagement-letter.test.ts) so parallel runs don't
 * collide on the shared tenant/claim cleanup paths.
 *
 * Each test file calls `seedFixtures()` in `before()` and
 * `cleanupFixtures()` in `after()`. The IDs are constants so tests
 * can target rows directly.
 */

export const TENANT_A = '00000000-0000-4000-8000-00000000e2a1';
export const TENANT_B = '00000000-0000-4000-8000-00000000e2b1';
export const SUBJECT_A = '00000000-0000-4000-8000-00000000e2a2';
export const SUBJECT_B = '00000000-0000-4000-8000-00000000e2b2';
export const CLAIM_A = '00000000-0000-4000-8000-00000000e2a3';
export const CLAIM_B = '00000000-0000-4000-8000-00000000e2b3';
export const LETTER_A = '00000000-0000-4000-8000-00000000e2a4';

export const ADMIN_A_USER = '00000000-0000-4000-8000-00000000e2a5';
export const VIEWER_A_USER = '00000000-0000-4000-8000-00000000e2a6';
export const CONSULTANT_A_USER = '00000000-0000-4000-8000-00000000e2a7';
export const ADMIN_B_USER = '00000000-0000-4000-8000-00000000e2b5';

export const TEMPLATE_MD =
  'Engagement letter for {{claimant_name}} (FY{{financial_year}}). Consultant: {{consultant_name}}.';

export const SESSION_SECRET =
  process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

export const jwtFor = async (
  userId: string,
  email: string,
  role: 'admin' | 'consultant' | 'viewer',
  tenantId: string = TENANT_A,
): Promise<string> =>
  signSession(
    {
      sub: userId,
      email,
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: role,
      availableTenants: [],
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

export const adminJwt = (): Promise<string> =>
  jwtFor(ADMIN_A_USER, 'engapi-admin@example.com', 'admin');
export const consultantJwt = (): Promise<string> =>
  jwtFor(CONSULTANT_A_USER, 'engapi-cons@example.com', 'consultant');
export const viewerJwt = (): Promise<string> =>
  jwtFor(VIEWER_A_USER, 'engapi-viewer@example.com', 'viewer');
export const tenantBAdminJwt = (): Promise<string> =>
  jwtFor(ADMIN_B_USER, 'engapi-admin-b@example.com', 'admin', TENANT_B);

export async function cleanupFixtures(): Promise<void> {
  // Order matters: engagement_letter -> claim -> subject_tenant ->
  // tenant_user / user -> tenant. privilegedSql bypasses RLS.
  await privilegedSql`DELETE FROM engagement_letter WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM claim WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM subject_tenant WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`DELETE FROM tenant_user WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await privilegedSql`
    DELETE FROM "user"
     WHERE id IN (${ADMIN_A_USER}, ${VIEWER_A_USER}, ${CONSULTANT_A_USER}, ${ADMIN_B_USER})
  `;
  await privilegedSql`DELETE FROM tenant WHERE id IN (${TENANT_A}, ${TENANT_B})`;
}

export async function seedFixtures(opts?: {
  /** Pre-create the engagement_letter row (e.g. for get/countersign tests). */
  withEngagementLetter?: boolean;
  /** If true, mark the seeded letter as already signed by claimant. */
  signedByClaimant?: boolean;
  /** Pass a specific send_token to seed (default: random). */
  sendToken?: string;
  /** Override claim engagement_status (default: 'pending_send'). */
  engagementStatus?: 'pending_send' | 'sent' | 'signed' | 'declined' | 'expired';
}): Promise<void> {
  await cleanupFixtures();

  await privilegedSql`
    INSERT INTO tenant (id, name, slug, primary_idp, engagement_letter_template_md)
    VALUES (${TENANT_A}, 'EngAPI Firm A', 'eng-api-firm-a', 'mixed', ${TEMPLATE_MD}),
           (${TENANT_B}, 'EngAPI Firm B', 'eng-api-firm-b', 'mixed', ${TEMPLATE_MD})
  `;
  await privilegedSql`
    INSERT INTO "user" (id, email, primary_idp, external_id, display_name)
    VALUES
      (${ADMIN_A_USER},      'engapi-admin@example.com',   'microsoft', 'microsoft:engapi-admin',   'EngAPI Admin A'),
      (${VIEWER_A_USER},     'engapi-viewer@example.com',  'microsoft', 'microsoft:engapi-viewer',  'EngAPI Viewer A'),
      (${CONSULTANT_A_USER}, 'engapi-cons@example.com',    'microsoft', 'microsoft:engapi-cons',    'EngAPI Consultant A'),
      (${ADMIN_B_USER},      'engapi-admin-b@example.com', 'microsoft', 'microsoft:engapi-admin-b', 'EngAPI Admin B')
  `;
  await privilegedSql`
    INSERT INTO tenant_user (id, tenant_id, user_id, role, is_default)
    VALUES (gen_random_uuid(), ${TENANT_A}, ${ADMIN_A_USER},      'admin',      true),
           (gen_random_uuid(), ${TENANT_A}, ${VIEWER_A_USER},     'viewer',     true),
           (gen_random_uuid(), ${TENANT_A}, ${CONSULTANT_A_USER}, 'consultant', true),
           (gen_random_uuid(), ${TENANT_B}, ${ADMIN_B_USER},      'admin',      true)
  `;
  await privilegedSql`
    INSERT INTO subject_tenant (id, tenant_id, name, kind)
    VALUES (${SUBJECT_A}, ${TENANT_A}, 'EngAPI Claimant A', 'claimant'),
           (${SUBJECT_B}, ${TENANT_B}, 'EngAPI Claimant B', 'claimant')
  `;
  const stage = opts?.engagementStatus ?? 'pending_send';
  await privilegedSql`
    INSERT INTO claim (id, tenant_id, subject_tenant_id, fiscal_year, stage, engagement_status)
    VALUES (${CLAIM_A}, ${TENANT_A}, ${SUBJECT_A}, 2025, 'engagement', ${stage}),
           (${CLAIM_B}, ${TENANT_B}, ${SUBJECT_B}, 2025, 'engagement', ${stage})
  `;
  if (opts?.withEngagementLetter) {
    const sendToken = opts.sendToken ?? 'seeded-token-for-tests-aaaaaaaaaaaaaaaaaaaaaa';
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const signedAt = opts.signedByClaimant ? new Date() : null;
    await privilegedSql`
      INSERT INTO engagement_letter
        (id, tenant_id, claim_id, rendered_markdown, template_version,
         send_token, send_token_expires_at, sent_to_claimant_at,
         signed_by_claimant_at, signed_by_claimant_name)
      VALUES
        (${LETTER_A}, ${TENANT_A}, ${CLAIM_A}, 'seeded letter A body', 'v1',
         ${sendToken}, ${expiresAt}, NOW(),
         ${signedAt}, ${opts.signedByClaimant ? 'Sig Tester' : null})
    `;
  }
}
