import { withRetry } from '../../runtime/retry.js';
import { XERO_API_BASE, type XeroPayrollEmployee, type XeroPayrollTimesheet } from './types.js';

/**
 * Xero Payroll AU API client (T-B18).
 *
 * Two read operations: list employees + list timesheets, both scoped to
 * a single Xero tenant via the `Xero-tenant-id` header. Three notable
 * differences from EH / KeyPay / Deputy:
 *
 *   1. **Tenant-id header**: Xero is multi-tenant via header, not via
 *      DNS (Deputy) or path (EH/KeyPay). The orchestrator stores the
 *      tenant_id on `integration_connection.external_account_id` and
 *      passes it in via `xero_tenant_id`. Every call sets
 *      `Xero-tenant-id: <tenant_id>` alongside the bearer token.
 *
 *   2. **`/Date(...)/` wire format**: Most date fields come back as
 *      Microsoft-JSON-Date strings (`/Date(1234567890+0000)/`). The
 *      `parseXeroDate` helper handles both this format and plain
 *      ISO 8601 fallback (newer / partial responses).
 *
 *   3. **Page-based pagination**: Xero uses `?page=N` with a documented
 *      hard cap of 100 items per page (vs Deputy's offset+max=500).
 *      A returned page of exactly 100 signals more pages remain.
 *
 * Filters supported:
 *   - `changed_since` → `If-Modified-Since` header. Xero Payroll AU
 *     honours this on Employees and Timesheets — the API returns
 *     `304 Not Modified` (which we treat as an empty page) or a
 *     filtered list of records modified at-or-after the given time.
 *
 * Retry: `withRetry` wraps each fetch (default 5 attempts with
 * exponential backoff + jitter). 5xx and transient errors retry; 4xx
 * surfaces after the budget because `withRetry` retries on any thrown
 * error and we throw on `!res.ok`.
 */

export type XeroPayrollClientOptions = {
  /** Decrypted access token. */
  access_token: string;
  /** The tenant_id from `listConnections`. Persisted as `external_account_id`. */
  xero_tenant_id: string;
  /** Test override for the API base URL — defaults to XERO_API_BASE. */
  base_url?: string;
};

const PAGE_SIZE = 100;

/**
 * Parse a Xero date field. Handles two wire formats:
 *   1. Microsoft JSON Date: `/Date(1234567890000+0000)/` — returns a
 *      Date built from the unix-millis number. The `+0000` offset is
 *      already implied (the millis are absolute) so we ignore it.
 *   2. Plain ISO 8601 / YYYY-MM-DD — returns the parsed Date.
 *
 * Returns `null` for undefined input or unparseable strings.
 */
export function parseXeroDate(d: string | undefined | null): Date | null {
  if (!d) return null;
  const m = /\/Date\((\d+)([+-]\d{4})?\)\//.exec(d);
  if (m && m[1] !== undefined) {
    return new Date(parseInt(m[1], 10));
  }
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function listEmployees(
  opts: XeroPayrollClientOptions,
  filters?: { changed_since?: Date; page?: number },
): Promise<{ employees: XeroPayrollEmployee[]; next_page: number | null }> {
  const page = filters?.page ?? 1;
  const url = new URL(`${opts.base_url ?? XERO_API_BASE}/Employees`);
  url.searchParams.set('page', String(page));

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.access_token}`,
    'Xero-tenant-id': opts.xero_tenant_id,
    Accept: 'application/json',
  };
  if (filters?.changed_since) {
    headers['If-Modified-Since'] = filters.changed_since.toUTCString();
  }

  const res = await withRetry(() => fetch(url, { headers }));
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`xero list employees: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as { Employees?: XeroPayrollEmployee[] };
  const employees = data.Employees ?? [];
  return {
    employees,
    next_page: employees.length === PAGE_SIZE ? page + 1 : null,
  };
}

export async function listTimesheets(
  opts: XeroPayrollClientOptions,
  filters?: { changed_since?: Date; page?: number },
): Promise<{ timesheets: XeroPayrollTimesheet[]; next_page: number | null }> {
  const page = filters?.page ?? 1;
  const url = new URL(`${opts.base_url ?? XERO_API_BASE}/Timesheets`);
  url.searchParams.set('page', String(page));

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.access_token}`,
    'Xero-tenant-id': opts.xero_tenant_id,
    Accept: 'application/json',
  };
  if (filters?.changed_since) {
    headers['If-Modified-Since'] = filters.changed_since.toUTCString();
  }

  const res = await withRetry(() => fetch(url, { headers }));
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`xero list timesheets: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as { Timesheets?: XeroPayrollTimesheet[] };
  const timesheets = data.Timesheets ?? [];
  return {
    timesheets,
    next_page: timesheets.length === PAGE_SIZE ? page + 1 : null,
  };
}
