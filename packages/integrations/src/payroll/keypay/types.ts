/**
 * KeyPay entity shapes (T-B12).
 *
 * KeyPay is the second-largest AU SME cloud payroll. Their public REST
 * API is rooted at https://api.yourpayroll.com.au/api/v2 and uses
 * business-scoped routes — every read goes through
 * `/business/{business_id}/...`. KeyPay was acquired by Employment Hero
 * in 2022, but the API surfaces remain distinct.
 *
 * Auth: a static `x-api-key` header per business (see `client.ts`). No
 * OAuth flow — accountants generate the key from the KeyPay business
 * settings page and paste it during the connect flow. Re-rotating the
 * key forces a re-connect.
 *
 * Naming convention: KeyPay's wire format is camelCase (vs EH's
 * snake_case), so we mirror that here. Internal codebase types remain
 * snake_case; the sync helpers do the translation when writing into
 * `subject_tenant_employee` / `time_entry`.
 *
 * `KeypayEmployee.id` is **numeric** — KeyPay assigns auto-increment
 * integers per business. We coerce to string when persisting into
 * `subject_tenant_employee.payroll_external_id` (text column).
 */

export type KeypayEmployee = {
  /** KeyPay internal id (numeric). Coerced to string when persisting. */
  id: number;
  firstName: string;
  surname: string;
  /** May be null for employees who haven't set an email — those rows are skipped during sync. */
  email: string | null;
  jobTitle?: string;
  /** ISO date — when the employee started. */
  startDate: string;
  /** ISO date — present when the employee has been terminated. */
  endDate?: string;
  status: 'Active' | 'Terminated';
  /** Optional cross-ref a customer may set (e.g. an HR system id). Not used by us. */
  externalId?: string;
};

export type KeypayTimesheet = {
  /** KeyPay internal id (numeric). Persisted as `time_entry.external_id`. */
  id: number;
  employeeId: number;
  /** YYYY-MM-DD. */
  date: string;
  /** 'HH:MM' string — combined with `date` to form an ISO timestamp on insert. */
  startTime: string;
  /** 'HH:MM' string — combined with `date` to form an ISO timestamp on insert. */
  endTime: string;
  /** Hours (decimal). Converted to minutes via Math.round(units * 60). */
  units: number;
  status: 'Submitted' | 'Approved' | 'Rejected' | 'Processed';
  comments?: string;
};

export type KeypayClientOptions = {
  /** KeyPay API key — sent in the `x-api-key` request header. */
  api_key: string;
  /** KeyPay business id (per-firm). */
  business_id: number;
  /** Defaults to KEYPAY_API_BASE; overridable for tests / per-region routing. */
  base_url?: string;
};

export const KEYPAY_API_BASE = 'https://api.yourpayroll.com.au/api/v2';
