import { getApiBaseUrl } from '../auth/redeem.js';
import { useSessionStore } from '../auth/session-store.js';

/**
 * Mobile-side time-entry client (T-B22).
 *
 * The list / create endpoints aren't yet registered in this worktree —
 * they ride along with the rest of Swimlane B's time-tracking
 * surface. The mobile screen ships now so the user-facing UX is
 * complete on merge; pre-merge the list returns empty / 404 and the
 * screen shows "No entries yet".
 *
 * TODO(post-B-merge): replace local TimeEntrySource / TimeEntry with
 * the shared schemas types once @cpa/schemas/time-entry lands. The
 * source enum mirrors the payroll integrations the consultant portal
 * supports (Employment Hero, KeyPay, Deputy, Xero Payroll).
 */
export type TimeEntrySource = 'manual' | 'employment_hero' | 'keypay' | 'deputy' | 'xero_payroll';

export type TimeEntry = {
  id: string;
  subject_tenant_id: string;
  source: TimeEntrySource;
  /** ISO8601 — when the work started. */
  started_at: string;
  /** ISO8601 — when the work ended. Null = entry still open. */
  ended_at: string | null;
  /** True if the consultant flagged the time as R&D-eligible. */
  is_rd: boolean;
  notes: string | null;
};

/**
 * Auth-injecting fetch helper specific to the time-entries client.
 * Mirrors the shape used in api-client/media.ts but kept local
 * because the time-entries surface evolves with Swimlane B and we
 * don't want to couple it to the media client's evolution.
 */
async function timeFetch<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: string },
): Promise<T> {
  const session = useSessionStore.getState().session;
  if (!session) throw new Error('not authenticated');
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    method: init.method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.access_token}`,
    },
    body: init.body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${init.method} ${path} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * List recent time entries for the bound subject_tenant.
 *
 * The API derives subject_tenant_id from the mobile JWT — the query
 * param is currently a no-op but reserved for future consultant-mode
 * audits where one consultant pulls multiple subjects through the
 * same session.
 *
 * Returns [] if the endpoint 404s pre-Swimlane-B (rather than
 * throwing) so the UI degrades to "no entries yet" gracefully.
 */
export async function listTimeEntries(): Promise<TimeEntry[]> {
  const session = useSessionStore.getState().session;
  if (!session) throw new Error('not authenticated');
  const subjectTenantId = session.employee.subject_tenant_id;
  try {
    const r = await timeFetch<{ time_entries: TimeEntry[] }>(
      `/v1/time-entries?subject_tenant_id=${subjectTenantId}`,
      { method: 'GET' },
    );
    return r.time_entries ?? [];
  } catch (e) {
    // Pre-merge: the API doesn't register this route yet. Soft-fail
    // to an empty list so the screen renders correctly.
    if (e instanceof Error && /404/.test(e.message)) return [];
    throw e;
  }
}

/**
 * Create a manual time entry.
 *
 * Source is forced to 'manual' — payroll-synced rows can only land
 * via the Swimlane-B integrations (Employment Hero / KeyPay /
 * Deputy / Xero Payroll) so the mobile app can't fabricate them.
 */
export type CreateTimeEntryInput = {
  started_at: string;
  ended_at: string;
  is_rd: boolean;
  notes?: string;
};

export async function createManualTimeEntry(input: CreateTimeEntryInput): Promise<TimeEntry> {
  const r = await timeFetch<{ time_entry: TimeEntry }>('/v1/time-entries', {
    method: 'POST',
    body: JSON.stringify({
      ...input,
      source: 'manual',
    }),
  });
  return r.time_entry;
}
