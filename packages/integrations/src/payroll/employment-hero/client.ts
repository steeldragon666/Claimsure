import { withRetry } from '../../runtime/retry.js';
import {
  EH_API_BASE,
  type EmploymentHeroEmployee,
  type EmploymentHeroTimesheet,
} from './types.js';

/**
 * Employment Hero API client (T-B8).
 *
 * Two read operations: list employees + list timesheets, both scoped to a
 * single organisation. EH's pagination is cursor-based — `meta.next_cursor`
 * carries the opaque "fetch next page" value; null/missing means done.
 *
 * Filters supported:
 *   - `changed_since` → `updated_after` query param. Drives incremental sync;
 *     the orchestrator passes `integration_connection.last_synced_at` so we
 *     only see deltas.
 *   - `from_date` / `to_date` → date-only filters for timesheet pulls. Used
 *     for backfill / catch-up sync windows.
 *
 * Auth: Bearer access token. The caller is responsible for refreshing the
 * token via `oauth.refreshAccessToken()` before invoking — the client
 * surfaces 401 as a thrown error rather than re-reading from DB. This
 * keeps the runtime helper free of DB dependencies, mirroring docusign/.
 *
 * Retry: `withRetry` wraps each fetch (default 5 attempts with exponential
 * backoff + jitter). 5xx and transient network errors retry; 4xx surfaces
 * after the first attempt because withRetry retries on any thrown error
 * and we throw on !res.ok. Tests around 401 verify exhaustion behaviour.
 */

export type EmploymentHeroClientOptions = {
  /** Decrypted access token (from `integration_connection.access_token_encrypted`). */
  access_token: string;
  /** EH organisation id — persisted on `integration_connection.external_account_id`. */
  organisation_id: string;
  /** Defaults to EH_API_BASE; overridable for tests / per-region routing. */
  base_url?: string;
};

type EmploymentHeroListResponse<T> = {
  data: T[];
  meta?: {
    next_cursor?: string;
  };
};

export async function listEmployees(
  opts: EmploymentHeroClientOptions,
  filters?: { changed_since?: Date; cursor?: string },
): Promise<{ employees: EmploymentHeroEmployee[]; next_cursor: string | null }> {
  const url = new URL(
    `${opts.base_url ?? EH_API_BASE}/organisations/${opts.organisation_id}/employees`,
  );
  if (filters?.changed_since) {
    url.searchParams.set('updated_after', filters.changed_since.toISOString());
  }
  if (filters?.cursor) {
    url.searchParams.set('cursor', filters.cursor);
  }

  const res = await withRetry(() =>
    fetch(url, {
      headers: { Authorization: `Bearer ${opts.access_token}` },
    }),
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`employment_hero list employees: ${res.status} ${errText}`);
  }
  const j = (await res.json()) as EmploymentHeroListResponse<EmploymentHeroEmployee>;
  return { employees: j.data, next_cursor: j.meta?.next_cursor ?? null };
}

export async function listTimesheets(
  opts: EmploymentHeroClientOptions,
  filters?: {
    changed_since?: Date;
    from_date?: Date;
    to_date?: Date;
    cursor?: string;
  },
): Promise<{ timesheets: EmploymentHeroTimesheet[]; next_cursor: string | null }> {
  const url = new URL(
    `${opts.base_url ?? EH_API_BASE}/organisations/${opts.organisation_id}/timesheets`,
  );
  if (filters?.changed_since) {
    url.searchParams.set('updated_after', filters.changed_since.toISOString());
  }
  if (filters?.from_date) {
    // EH's date-only filters take YYYY-MM-DD; trim the time portion.
    url.searchParams.set('from_date', isoDate(filters.from_date));
  }
  if (filters?.to_date) {
    url.searchParams.set('to_date', isoDate(filters.to_date));
  }
  if (filters?.cursor) {
    url.searchParams.set('cursor', filters.cursor);
  }

  const res = await withRetry(() =>
    fetch(url, {
      headers: { Authorization: `Bearer ${opts.access_token}` },
    }),
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`employment_hero list timesheets: ${res.status} ${errText}`);
  }
  const j = (await res.json()) as EmploymentHeroListResponse<EmploymentHeroTimesheet>;
  return { timesheets: j.data, next_cursor: j.meta?.next_cursor ?? null };
}

function isoDate(d: Date): string {
  const iso = d.toISOString();
  const datePart = iso.split('T')[0];
  if (!datePart) {
    throw new Error('isoDate: malformed Date.toISOString output');
  }
  return datePart;
}
