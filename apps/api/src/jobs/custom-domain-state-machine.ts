import { privilegedSql } from '@cpa/db/client';
import { resolveCname, type CnameResolver } from '@cpa/integrations/runtime';

/**
 * Expected CNAME target firms publish to point a custom domain at the
 * platform (T-C7). Read at module load time so production sets it once
 * via env; the state machine reuses the route's `PLATFORM_CNAME_TARGET`
 * (apps/api/src/routes/brand-config.ts) — keep both in sync if you
 * ever override the env var per-environment.
 *
 * The `+ '.'` variant in the matcher accepts the trailing-dot form
 * resolvers sometimes emit (rooted FQDN). DNS clients vary; both shapes
 * mean the same thing.
 */
const EXPECTED_CNAME_TARGET =
  process.env['PLATFORM_CNAME_TARGET'] ?? 'platform-cnames.platform.com.au';

interface BrandRow {
  custom_domain: string | null;
  custom_domain_status: string;
}

export interface AdvanceResult {
  status: string;
  transitioned: boolean;
}

export interface AdvanceDeps {
  /**
   * CNAME resolver — production passes nothing and we use Node's
   * dns.promises.resolveCname (via @cpa/integrations/runtime). Tests
   * inject a stub via this hole; the alternative would be module-
   * level mocking which node:test doesn't support cleanly.
   */
  resolveCname?: CnameResolver;
  /**
   * Optional override for the expected CNAME target. Defaults to the
   * module-level env-resolved value. Tests use this to keep assertions
   * deterministic without mucking with `process.env`.
   */
  expectedTarget?: string;
}

/**
 * Advance the custom-domain lifecycle for `tenantId` by one step
 * (T-C7).
 *
 * State machine:
 *   - cname_pending → cert_pending  (when CNAME resolves to expected target)
 *   - cname_pending → cname_pending (CNAME mismatch / DNS error — caller retries)
 *   - cert_pending  → active        (STUB: real ACM cert request lands later)
 *   - active / failed / unconfigured → no-op
 *
 * Idempotent: calling on the same tenant repeatedly is safe — the
 * transition only fires when the prerequisite condition holds, and
 * the second call sees the already-advanced state.
 *
 * The cert_pending → active transition is intentionally a stub. Real
 * impl will:
 *   1. Call ACM RequestCertificate (DNS validation method).
 *   2. Store the returned ARN in custom_domain_acm_arn.
 *   3. Add the ACM-required DNS validation record (Route53 if hosted,
 *      or surface to the user otherwise).
 *   4. Wait for ACM DescribeCertificate to return ISSUED.
 *   5. Attach to CloudFront.
 * For v1 we skip straight to `active` with a placeholder ARN so the
 * wizard's full happy path is demoable end-to-end.
 */
export async function advanceCustomDomainState(
  tenantId: string,
  deps: AdvanceDeps = {},
): Promise<AdvanceResult> {
  const resolver = deps.resolveCname ?? resolveCname;
  const expected = deps.expectedTarget ?? EXPECTED_CNAME_TARGET;

  const rows = await privilegedSql<BrandRow[]>`
    SELECT custom_domain, custom_domain_status
      FROM brand_config
     WHERE tenant_id = ${tenantId}
  `;
  const row = rows[0];
  if (!row || !row.custom_domain) {
    return { status: 'unconfigured', transitioned: false };
  }

  if (row.custom_domain_status === 'cname_pending') {
    let cnames: string[];
    try {
      cnames = await resolver(row.custom_domain);
    } catch {
      // DNS error (NXDOMAIN, timeout, etc.) — record may not have
      // propagated yet. Stay in cname_pending; the caller will retry.
      return { status: 'cname_pending', transitioned: false };
    }
    const matches = cnames.some((c) => c === expected || c === `${expected}.`);
    if (!matches) {
      return { status: 'cname_pending', transitioned: false };
    }
    await privilegedSql`
      UPDATE brand_config
         SET custom_domain_status = 'cert_pending', updated_at = NOW()
       WHERE tenant_id = ${tenantId}
    `;
    return { status: 'cert_pending', transitioned: true };
  }

  if (row.custom_domain_status === 'cert_pending') {
    // STUB: real ACM cert request comes in a later task. Skip ahead to
    // `active` with a placeholder ARN so the wizard's happy path runs
    // end-to-end before the cloud-side wiring lands.
    const placeholderArn = `arn:aws:acm:placeholder:tenant/${tenantId}`;
    await privilegedSql`
      UPDATE brand_config
         SET custom_domain_status = 'active',
             custom_domain_acm_arn = ${placeholderArn},
             updated_at = NOW()
       WHERE tenant_id = ${tenantId}
    `;
    return { status: 'active', transitioned: true };
  }

  // active / failed / unconfigured / unknown values — no-op.
  return { status: row.custom_domain_status, transitioned: false };
}
