/**
 * Xero Payroll AU entity shapes (T-B18).
 *
 * Xero exposes two distinct payroll APIs — AU at `/payroll.xro/1.0/` and
 * NZ at `/payroll.xro/2.0/`. We target **AU only** (the firms in the
 * Australian market this codebase serves). The base URL for every read
 * request is `https://api.xero.com/payroll.xro/1.0/<resource>`.
 *
 * Notable Xero quirks captured here:
 *
 *   1. **PKCE OAuth 2.0**: Xero is the only provider in this codebase
 *      that requires PKCE (RFC 7636) — even for confidential clients. The
 *      `client_secret` is *optional* for public clients but supported for
 *      confidential ones. The `code_verifier` is mandatory on the token
 *      exchange regardless.
 *
 *   2. **Tenant-id header**: After OAuth, the access token is not
 *      bound to a specific organisation — the user may have authorized
 *      multiple Xero orgs (tenants). The flow is: exchange code → call
 *      `GET https://api.xero.com/connections` → discover an array of
 *      `{ tenantId, tenantName, tenantType }` → pick one → pass it on
 *      every API call as the `Xero-tenant-id` header. We persist the
 *      chosen tenant_id onto `integration_connection.external_account_id`
 *      and surface it through the client as `xero_tenant_id`.
 *
 *   3. **`/Date(epoch+0000)/` wire format**: Xero Payroll AU returns
 *      dates as Microsoft JSON Date strings — `/Date(1234567890000+0000)/`
 *      where the inner number is unix milliseconds. Some endpoints
 *      (newer ones, or sub-fields) return plain ISO 8601 instead.
 *      `parseXeroDate` in `client.ts` handles both formats.
 *
 *   4. **Naming convention**: Xero's wire format is **PascalCase**
 *      (similar to Deputy). Internal codebase types remain snake_case;
 *      the sync helpers translate when writing into our tables.
 *
 *   5. **Pagination**: Page-based, not cursor-based. Each page returns
 *      up to **100** items (Xero Payroll AU's documented hard cap, vs
 *      Deputy's 500). A returned page of exactly 100 signals more pages.
 */

/**
 * Xero Payroll AU Employee record (subset — we only need fields used
 * by the sync). The full Xero schema includes home address, payroll
 * calendars, leave balances, super memberships etc — we intentionally
 * read only the fields we project into `subject_tenant_employee`.
 *
 * `EmployeeID` is a **GUID** (Xero standard for all PK fields) — vs
 * Deputy's auto-increment integer. Already a string, so no coercion.
 *
 * `Status` is a string enum: ACTIVE | INACTIVE | TERMINATED. We treat
 * INACTIVE and TERMINATED both as "deactivate".
 */
export type XeroPayrollEmployee = {
  EmployeeID: string;
  FirstName: string;
  LastName: string;
  /** May be null for employees who haven't set an email — those rows are skipped during sync. */
  Email: string | null;
  /** /Date(epoch+0000)/ format — Xero Microsoft-JSON-Date quirk. */
  StartDate?: string;
  /** /Date(epoch+0000)/ format — present when terminated. */
  EndDate?: string;
  Status: 'ACTIVE' | 'INACTIVE' | 'TERMINATED';
  JobTitle?: string;
};

/**
 * Xero Payroll AU Timesheet record (subset).
 *
 * A timesheet covers a date *range* (StartDate → EndDate) and contains
 * `TimesheetLines[]` — one entry per work day with hours
 * (`NumberOfUnits`). The sync expands each line into one `time_entry`
 * row keyed by `${TimesheetID}:${Date}` so we capture per-day
 * granularity even though Xero groups by pay period.
 *
 * `Status === 'REJECTED'` rows are skipped (the consultant rejected
 * the submission, so they should not count toward R&D apportionment).
 */
export type XeroPayrollTimesheet = {
  TimesheetID: string;
  EmployeeID: string;
  /** /Date(...)/ or YYYY-MM-DD depending on endpoint. */
  StartDate: string;
  EndDate: string;
  Status: 'DRAFT' | 'PROCESSED' | 'APPROVED' | 'REJECTED';
  /** Total hours across all lines — informational only; we sum lines. */
  Hours?: number;
  TimesheetLines?: Array<{
    /** /Date(...)/ or YYYY-MM-DD. */
    Date: string;
    /** Hours per day (decimal). Converted via Math.round(NumberOfUnits * 60). */
    NumberOfUnits: number;
    /** Optional Xero earnings rate id (e.g. ordinary, overtime). Not used by us. */
    EarningsRateID?: string;
  }>;
  /** /Date(...)/ — last-modified marker, used for incremental sync. */
  UpdatedDateUTC?: string;
};

export type XeroPayrollAuthConfig = {
  client_id: string;
  /** Optional with PKCE — public clients omit. */
  client_secret?: string;
  redirect_uri: string;
};

/**
 * Xero OAuth + API endpoints. Xero splits the OAuth surface: authorize
 * lives on the identity host (`login.xero.com` / `identity.xero.com`),
 * while the API root is `api.xero.com`.
 */
export const XERO_OAUTH_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
export const XERO_OAUTH_TOKEN_URL = 'https://identity.xero.com/connect/token';
export const XERO_API_BASE = 'https://api.xero.com/payroll.xro/1.0';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

/**
 * Minimum scopes for v1: `offline_access` to receive a refresh_token,
 * plus the Payroll AU read scopes for employees and timesheets. Xero's
 * scope model is per-resource — each domain (employees, timesheets,
 * leave, etc.) has its own scope.
 */
export const XERO_PAYROLL_SCOPES = [
  'offline_access',
  'payroll.employees',
  'payroll.timesheets',
] as const;
