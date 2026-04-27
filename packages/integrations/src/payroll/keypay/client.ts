import { withRetry } from '../../runtime/retry.js';
import {
  KEYPAY_API_BASE,
  type KeypayEmployee,
  type KeypayTimesheet,
  type KeypayClientOptions,
} from './types.js';

/**
 * KeyPay API client (T-B12).
 *
 * Two read operations: list employees + list timesheets, both scoped to
 * a single business. Pagination differs from Employment Hero:
 *
 *   - EH uses opaque cursor strings via `meta.next_cursor`.
 *   - KeyPay uses numeric **page-based pagination** with `skip` + `top`
 *     parameters (similar to OData). We track pages internally as
 *     1-indexed `cursor` numbers and translate to `skip = (page-1)*100`
 *     when calling KeyPay. We assume more pages remain whenever the
 *     server returns a full page (100 items); a short page signals end
 *     of stream. This is the standard pattern when the API doesn't
 *     return a total-count header.
 *
 * Filters supported:
 *   - `changed_since` → `updatedAfter` query param (ISO timestamp).
 *     Drives incremental sync; the orchestrator passes
 *     `integration_connection.last_synced_at`.
 *   - `from_date` / `to_date` → `fromDate`/`toDate` (YYYY-MM-DD) for
 *     timesheet-window pulls. Used for backfill / catch-up sync.
 *
 * Auth: static API key in the `x-api-key` header. No refresh dance.
 * If the key is rotated by the consultant, KeyPay returns 401 and the
 * orchestrator surfaces the error so the user can re-connect.
 *
 * Retry: `withRetry` wraps each fetch (default 5 attempts with
 * exponential backoff + jitter). 5xx and transient network errors
 * retry; 4xx surfaces after exhausting the retry budget because
 * `withRetry` retries on any thrown error and we throw on `!res.ok`.
 */

type Cursor = number;

export async function listEmployees(
  opts: KeypayClientOptions,
  filters?: { changed_since?: Date; cursor?: Cursor },
): Promise<{ employees: KeypayEmployee[]; next_cursor: Cursor | null }> {
  const url = new URL(`${opts.base_url ?? KEYPAY_API_BASE}/business/${opts.business_id}/employee`);
  if (filters?.changed_since) {
    url.searchParams.set('updatedAfter', filters.changed_since.toISOString());
  }
  const page = filters?.cursor ?? 1;
  url.searchParams.set('skip', String((page - 1) * 100));
  url.searchParams.set('top', '100');

  const res = await withRetry(() =>
    fetch(url, {
      headers: { 'x-api-key': opts.api_key, Accept: 'application/json' },
    }),
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`keypay list employees: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as KeypayEmployee[];
  return {
    employees: data,
    next_cursor: data.length === 100 ? page + 1 : null,
  };
}

export async function listTimesheets(
  opts: KeypayClientOptions,
  filters?: {
    changed_since?: Date;
    from_date?: Date;
    to_date?: Date;
    cursor?: Cursor;
  },
): Promise<{ timesheets: KeypayTimesheet[]; next_cursor: Cursor | null }> {
  const url = new URL(`${opts.base_url ?? KEYPAY_API_BASE}/business/${opts.business_id}/timesheet`);
  if (filters?.from_date) {
    url.searchParams.set('fromDate', isoDate(filters.from_date));
  }
  if (filters?.to_date) {
    url.searchParams.set('toDate', isoDate(filters.to_date));
  }
  if (filters?.changed_since) {
    url.searchParams.set('updatedAfter', filters.changed_since.toISOString());
  }
  const page = filters?.cursor ?? 1;
  url.searchParams.set('skip', String((page - 1) * 100));
  url.searchParams.set('top', '100');

  const res = await withRetry(() =>
    fetch(url, {
      headers: { 'x-api-key': opts.api_key, Accept: 'application/json' },
    }),
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`keypay list timesheets: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as KeypayTimesheet[];
  return {
    timesheets: data,
    next_cursor: data.length === 100 ? page + 1 : null,
  };
}

function isoDate(d: Date): string {
  const iso = d.toISOString();
  const datePart = iso.split('T')[0];
  if (!datePart) {
    throw new Error('isoDate: malformed Date.toISOString output');
  }
  return datePart;
}
