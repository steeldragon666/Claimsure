import { withRetry } from '../../runtime/retry.js';
import type { DeputyEmployee, DeputyTimesheet } from './types.js';

/**
 * Deputy API client (T-B15).
 *
 * Two read operations: list employees + list timesheets, both scoped to
 * the customer's Deputy install URL. Three notable differences from
 * Employment Hero / KeyPay:
 *
 *   1. **Per-tenant subdomain**: Deputy is multi-tenant via DNS — every
 *      customer's API root is `https://YOUR_INSTALL.deputy.com/api/v1/`.
 *      The orchestrator stores the install URL on
 *      `integration_connection.external_account_id` and passes it in via
 *      `install_url` here.
 *
 *   2. **POST-based QUERY API**: Deputy's filtered list endpoints take
 *      a JSON body via POST `/api/v1/resource/{Type}/QUERY` rather than
 *      GET with query strings. The body shape is documented at
 *      <https://www.deputy.com/api-doc/API/Resource_Calls#querying>.
 *      Pagination uses `start` (offset) + `max` (page size); we use
 *      max=500 (Deputy's documented hard cap). A returned page of
 *      exactly 500 signals more pages remain.
 *
 *   3. **`OAuth` auth scheme**: Deputy expects `Authorization: OAuth
 *      <token>` (not `Bearer <token>`). This is a Deputy-specific quirk
 *      tied to their original OAuth 1.0 implementation that survived
 *      into their OAuth 2.0 flow.
 *
 * Filters supported:
 *   - `changed_since` → search predicate on `Modified` field (unix
 *     seconds). Drives incremental sync; the orchestrator passes
 *     `integration_connection.last_synced_at`.
 *   - `from_date` / `to_date` → search predicates on `Date` (YYYY-MM-DD)
 *     for timesheet-window pulls. Used for backfill / catch-up sync.
 *
 * Retry: `withRetry` wraps each fetch (default 5 attempts with
 * exponential backoff + jitter). 5xx and transient network errors
 * retry; 4xx surfaces after exhausting the retry budget because
 * `withRetry` retries on any thrown error and we throw on `!res.ok`.
 */

export type DeputyClientOptions = {
  /** Decrypted access token (from `integration_connection.access_token_encrypted`). */
  access_token: string;
  /** Customer's Deputy install URL (e.g. 'https://acme.deputy.com'). Persisted as `external_account_id`. */
  install_url: string;
};

const PAGE_SIZE = 500;

type SearchPredicate = {
  field: string;
  type: 'ge' | 'le' | 'eq';
  data: string | number;
};

export async function listEmployees(
  opts: DeputyClientOptions,
  filters?: { changed_since?: Date; cursor?: number },
): Promise<{ employees: DeputyEmployee[]; next_cursor: number | null }> {
  const start = filters?.cursor ?? 0;
  const url = `${opts.install_url}/api/v1/resource/Employee/QUERY`;
  const search: Record<string, SearchPredicate> = {};
  if (filters?.changed_since) {
    search['s1'] = {
      field: 'Modified',
      type: 'ge',
      data: Math.floor(filters.changed_since.getTime() / 1000),
    };
  }
  const queryBody: Record<string, unknown> = {
    sort: { Id: 'asc' },
    start,
    max: PAGE_SIZE,
  };
  if (Object.keys(search).length > 0) {
    queryBody['search'] = search;
  }

  const res = await withRetry(() =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${opts.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(queryBody),
    }),
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`deputy list employees: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as DeputyEmployee[];
  return {
    employees: data,
    next_cursor: data.length === PAGE_SIZE ? start + PAGE_SIZE : null,
  };
}

export async function listTimesheets(
  opts: DeputyClientOptions,
  filters?: {
    changed_since?: Date;
    from_date?: Date;
    to_date?: Date;
    cursor?: number;
  },
): Promise<{ timesheets: DeputyTimesheet[]; next_cursor: number | null }> {
  const start = filters?.cursor ?? 0;
  const url = `${opts.install_url}/api/v1/resource/Timesheet/QUERY`;
  const search: Record<string, SearchPredicate> = {};
  if (filters?.from_date) {
    search['s1'] = { field: 'Date', type: 'ge', data: isoDate(filters.from_date) };
  }
  if (filters?.to_date) {
    search['s2'] = { field: 'Date', type: 'le', data: isoDate(filters.to_date) };
  }
  if (filters?.changed_since) {
    search['s3'] = {
      field: 'Modified',
      type: 'ge',
      data: Math.floor(filters.changed_since.getTime() / 1000),
    };
  }
  const queryBody: Record<string, unknown> = {
    sort: { Id: 'asc' },
    start,
    max: PAGE_SIZE,
  };
  if (Object.keys(search).length > 0) {
    queryBody['search'] = search;
  }

  const res = await withRetry(() =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${opts.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(queryBody),
    }),
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`deputy list timesheets: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as DeputyTimesheet[];
  return {
    timesheets: data,
    next_cursor: data.length === PAGE_SIZE ? start + PAGE_SIZE : null,
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
