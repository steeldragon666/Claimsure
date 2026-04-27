import { privilegedSql } from '@cpa/db/client';

interface BrandRow {
  email_sender_domain: string | null;
  email_sender_dkim_status: string;
}

export interface AdvanceEmailSenderResult {
  status: string;
  transitioned: boolean;
}

/**
 * Advance the DKIM verification lifecycle for `tenantId` by one step
 * (T-C9).
 *
 * State machine:
 *   - pending → verified (STUB: real impl resolves the 3 selectorN.
 *     _domainkey.<domain> TXT records and validates DKIM tag presence;
 *     for v1 we flip to verified directly so the wizard's happy path
 *     demos end-to-end before SES wiring lands).
 *   - verified / failed / unconfigured → no-op
 *
 * Idempotent: calling twice on a verified row is safe — the second
 * call hits the no-op branch.
 *
 * TODO (real impl):
 *   1. Persist DKIM tokens at registration time (likely a `dkim_tokens
 *      jsonb` column on brand_config).
 *   2. Use dns.promises.resolveTxt to fetch records at
 *      `selector{1,2,3}._domainkey.<email_sender_domain>`.
 *   3. Validate each record matches the persisted token + DKIM v=DKIM1
 *      tag layout. All 3 must validate to advance to verified;
 *      partial = stay in pending; explicit "no records" after a long
 *      retry budget = transition to failed.
 */
export async function advanceEmailSenderState(tenantId: string): Promise<AdvanceEmailSenderResult> {
  const rows = await privilegedSql<BrandRow[]>`
    SELECT email_sender_domain, email_sender_dkim_status
      FROM brand_config
     WHERE tenant_id = ${tenantId}
  `;
  const row = rows[0];
  if (!row || !row.email_sender_domain) {
    return { status: 'unconfigured', transitioned: false };
  }

  if (row.email_sender_dkim_status === 'pending') {
    // STUB: real DNS TXT lookup + DKIM token validation lands later.
    // For v1 the wizard's "Verify DNS" click flips straight to verified
    // so the demo flow runs end-to-end without an SES dependency.
    await privilegedSql`
      UPDATE brand_config
         SET email_sender_dkim_status = 'verified', updated_at = NOW()
       WHERE tenant_id = ${tenantId}
    `;
    return { status: 'verified', transitioned: true };
  }

  // verified / failed / unconfigured / unknown — no-op.
  return { status: row.email_sender_dkim_status, transitioned: false };
}
