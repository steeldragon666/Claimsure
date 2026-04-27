/**
 * Deputy entity shapes (T-B15).
 *
 * Deputy is a workforce management + payroll-adjacent platform popular in
 * AU. Their public REST API is rooted at
 * `https://YOUR_INSTALL.deputy.com/api/v1/` — every customer's Deputy
 * instance is a separate subdomain (multi-tenant via DNS). The OAuth
 * surface lives on a single shared host (`https://once.deputy.com`) and
 * uses the standard authorization-code grant. The token-exchange
 * response carries the customer's install URL on the `endpoint` field —
 * we persist it onto `integration_connection.external_account_id` so the
 * client knows which subdomain to hit.
 *
 * Naming convention: Deputy's wire format is **PascalCase** (vs EH's
 * snake_case and KeyPay's camelCase). We mirror that here. Internal
 * codebase types remain snake_case; the sync helpers do the translation
 * when writing into `subject_tenant_employee` / `time_entry`.
 *
 * `DeputyEmployee.Id` is **numeric** — Deputy assigns auto-increment
 * integers per install. We coerce to string when persisting into
 * `subject_tenant_employee.payroll_external_id` (text column).
 *
 * `Active` is a **numeric flag** (1 = active, 0 = terminated) rather
 * than an enum string — typical of older Deputy resources.
 */

export type DeputyEmployee = {
  /** Deputy internal id (numeric). Coerced to string when persisting. */
  Id: number;
  DisplayName: string;
  FirstName: string;
  LastName: string;
  /** May be null for employees who haven't set an email — those rows are skipped during sync. */
  Email: string | null;
  /** ISO date — when the employee started. */
  EmployeeStartDate?: string;
  /** ISO date — present when the employee has been terminated. */
  EmployeeTerminationDate?: string;
  /** 1 = active, 0 = terminated. */
  Active: number;
  /** Job title. */
  Position?: string;
  /** Optional cross-ref a customer may set (e.g. an HR system id). Not used by us. */
  EmploymentNumber?: string;
};

export type DeputyTimesheet = {
  /** Deputy internal id (numeric). Persisted as `time_entry.external_id`. */
  Id: number;
  /** Employee Id. */
  Employee: number;
  /** ISO date — YYYY-MM-DD. */
  Date: string;
  /** Unix timestamp (seconds). Composed into a JS Date as `new Date(StartTime * 1000)`. */
  StartTime: number;
  /** Unix timestamp (seconds). */
  EndTime: number;
  /** Hours (decimal). Converted to minutes via Math.round(TotalTime * 60). */
  TotalTime: number;
  /** Optional cost figure — unused by us. */
  Cost: number;
  /** Free-text comment from Deputy. Maps to `time_entry.notes`. */
  Comment?: string;
  /** 1 = soft-deleted; we skip these during sync. */
  Discarded: number;
};

export type DeputyAuthConfig = {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  /** Optional install URL — only used as a context tag; the OAuth flow itself runs against `once.deputy.com`. */
  install_url?: string;
};

/**
 * Deputy OAuth + API endpoints. Deputy uses a shared OAuth host —
 * `once.deputy.com` — for both the authorize and token endpoints. The
 * token-exchange response then returns the customer's install URL on
 * `endpoint` so the client can route subsequent API calls correctly.
 */
export const DEPUTY_OAUTH_AUTHORIZE_URL = 'https://once.deputy.com/my/oauth/login';
export const DEPUTY_OAUTH_TOKEN_URL = 'https://once.deputy.com/oauth/access_token';

/**
 * Minimum scopes for v1: long-lived refresh token. Deputy's scope model
 * is coarser than EH/KeyPay — `longlife_refresh_token` is the marker
 * scope that asks Deputy to issue a refresh_token alongside the access
 * token, rather than forcing re-consent every hour.
 */
export const DEPUTY_SCOPES = ['longlife_refresh_token'] as const;
