import { withRetry } from '../runtime/retry.js';
import { XERO_API_BASE } from './types.js';

/**
 * Xero Accounting API client (T-B1 scaffolding).
 *
 * B1 lays down the shared HTTP plumbing (tenant-id header, retry
 * wrapper, base-URL override) so subsequent expenditure tasks (B2-B12)
 * can drop in resource-specific list/create/update calls without
 * re-implementing the boilerplate. Notable Xero quirks captured by the
 * shape (see also payroll/xero-payroll/client.ts for the parallel
 * Payroll AU implementation):
 *
 *   1. Tenant-id header: Xero is multi-tenant via header, not via DNS
 *      or path. The orchestrator stores the tenant_id on
 *      integration_connection.external_account_id and passes it in via
 *      xero_tenant_id. Every call sets Xero-tenant-id: <tenant_id>
 *      alongside the bearer token.
 *
 *   2. /Date(...)/ wire format: Most date fields come back as
 *      Microsoft-JSON-Date strings (/Date(1234567890+0000)/). The
 *      parseXeroDate helper handles both this format and plain ISO
 *      8601 fallback (newer / partial responses).
 *
 *   3. Page-based pagination: Xero uses ?page=N with a documented hard
 *      cap of 100 items per page on most accounting endpoints.
 *
 * Retry: withRetry wraps each fetch (default 5 attempts with
 * exponential backoff + jitter). 5xx and transient errors retry; 4xx
 * surfaces after the budget because withRetry retries on any thrown
 * error and we throw on !res.ok.
 */

export type XeroAccountingClientOptions = {
  /** Decrypted access token. */
  access_token: string;
  /** The tenant_id from listConnections. Persisted as external_account_id. */
  xero_tenant_id: string;
  /** Test override for the API base URL — defaults to XERO_API_BASE. */
  base_url?: string;
};

/**
 * Parse a Xero date field. Handles two wire formats:
 *   1. Microsoft JSON Date: /Date(1234567890000+0000)/ — returns a
 *      Date built from the unix-millis number. The +0000 offset is
 *      already implied (the millis are absolute) so we ignore it.
 *   2. Plain ISO 8601 / YYYY-MM-DD — returns the parsed Date.
 *
 * Returns null for undefined input or unparseable strings.
 */
export function parseXeroDate(d: string | undefined | null): Date | null {
  if (!d) return null;
  // Anchored with ^...$ so a substring match (e.g. "Prefix/Date(123)/Suffix")
  // does NOT silently parse — those are malformed inputs and must fall through
  // to the generic Date parse, which then returns null for non-ISO strings.
  const m = /^\/Date\((\d+)([+-]\d{4})?\)\/$/.exec(d);
  if (m && m[1] !== undefined) {
    return new Date(parseInt(m[1], 10));
  }
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Internal helper — performs an authenticated GET against an Xero
 * Accounting endpoint with retry. Centralises the header set
 * (Authorization + Xero-tenant-id + Accept) so subsequent B-series
 * tasks (B2 listInvoices, B3 listContacts, …) only specify the path
 * and query.
 *
 * path should be relative to XERO_API_BASE and start with / — e.g.
 * /Invoices, /Contacts, /Accounts.
 */
export async function xeroAccountingGet(
  opts: XeroAccountingClientOptions,
  path: string,
  query?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${opts.base_url ?? XERO_API_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.access_token}`,
    'Xero-tenant-id': opts.xero_tenant_id,
    Accept: 'application/json',
    ...extraHeaders,
  };

  const res = await withRetry(() => fetch(url, { headers }));
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`xero accounting GET ${path}: ${res.status} ${errText}`);
  }
  return res.json();
}
