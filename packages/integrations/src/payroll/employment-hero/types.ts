/**
 * Employment Hero entity shapes (T-B8).
 *
 * Employment Hero is the largest AU SME cloud payroll. Their public REST
 * API is rooted at https://api.employmenthero.com/api/v1 and uses
 * organisation-scoped routes — every read goes through
 * `/organisations/{organisation_id}/...`. The OAuth surface lives on a
 * separate host (`oauth.employmenthero.com`) and uses the standard
 * authorization-code grant; we don't need PKCE since EH treats this as a
 * confidential client.
 *
 * Naming convention: external API surface stays in EH's snake_case
 * (matches the wire format) so client.ts is a thin pass-through. Internal
 * codebase types remain snake_case anyway, so no remapping required.
 *
 * `EmploymentHeroEmployee.status`: 'active' | 'terminated' | 'pending' —
 * we map 'terminated' → soft-delete in subject_tenant_employee
 * (deactivated_at = NOW()) during sync.
 */

export type EmploymentHeroEmployee = {
  /** EH internal id — persisted as `subject_tenant_employee.payroll_external_id`. */
  id: string;
  first_name: string;
  surname: string;
  work_email: string;
  job_title?: string;
  /** ISO date — when the employee started. */
  start_date: string;
  /** ISO date — present when the employee has been terminated. */
  termination_date?: string;
  organisation_id: string;
  status: 'active' | 'terminated' | 'pending';
};

export type EmploymentHeroTimesheet = {
  /** EH internal id — persisted as `time_entry.external_id`. */
  id: string;
  employee_id: string;
  /** YYYY-MM-DD. */
  date: string;
  /** ISO timestamp (with timezone). */
  start_time: string;
  /** ISO timestamp (with timezone). */
  end_time: string;
  duration_minutes: number;
  status: 'submitted' | 'approved' | 'rejected';
  notes?: string;
};

export type EmploymentHeroAuthConfig = {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
};

/**
 * EH OAuth + API endpoints. EH does NOT have a separate sandbox host —
 * developers test against a sandbox organisation on the same hosts.
 */
export const EH_OAUTH_AUTHORIZE_URL = 'https://oauth.employmenthero.com/oauth2/authorize';
export const EH_OAUTH_TOKEN_URL = 'https://oauth.employmenthero.com/oauth2/token';
export const EH_API_BASE = 'https://api.employmenthero.com/api/v1';

/**
 * Minimum scopes for v1: read-only access to employee + timesheet data.
 * The app does not need write scopes — we never push timesheets back to
 * EH; we only consume them as evidence for R&D apportionment.
 */
export const EH_SCOPES = ['read:employees', 'read:timesheets'] as const;
