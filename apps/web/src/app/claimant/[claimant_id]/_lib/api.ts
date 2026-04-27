/**
 * Server-side typed fetchers for the PWA-claimant routes (T-C12, T-C13).
 *
 * Distinct from `apps/web/src/lib/api.ts` (the consultant-side, browser-
 * resident `apiFetch`) because the PWA pages run as React server
 * components — they fetch over the loopback rather than via the
 * browser's cookie jar. We pass the `cpa_claimant_session` cookie value
 * through manually using `next/headers` `cookies()` since `fetch()` on
 * the server side has no cookie jar of its own.
 *
 * Errors throw a typed `ClaimantApiError`; the page-level try/catch
 * decides whether to redirect to /expired (on 401) or surface a message.
 */

interface ClaimantStatus {
  subject_tenant: { id: string; name: string; kind: 'claimant' | 'financier' };
  brand: {
    display_name: string;
    primary_color: string;
    accent_color: string;
    logo_s3_key: string | null;
  };
  claim_stage:
    | 'engagement'
    | 'activity_capture'
    | 'narrative_drafting'
    | 'expenditure_schedule'
    | 'review'
    | 'submission'
    | 'audit_defence';
  recent_events: Array<{
    id: string;
    kind: string;
    captured_at: string;
    snippet: string;
  }>;
  pending_rfis: Array<{
    id: string;
    requested_at: string;
    document_kind: string;
  }>;
}

interface AuditScore {
  total_pts: number;
  max_pts: number;
  rule_breakdown: Array<{
    id: string;
    label: string;
    earned: number;
    max: number;
  }>;
  delta_7d: number;
  computed_at: string;
}

export type { ClaimantStatus, AuditScore };

export class ClaimantApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClaimantApiError';
  }
}

const apiBaseUrl = (): string => {
  return process.env['INTERNAL_API_URL'] ?? 'http://localhost:3000';
};

/**
 * Server-side fetch wrapper. Forwards the cpa_claimant_session cookie
 * value (read by the caller via `cookies()`) as a Cookie header so the
 * Fastify auth gate sees the session.
 *
 * `cache: 'no-store'` — the status / score routes are per-claimant and
 * the data is freshness-sensitive (recent events, score changes); we
 * don't want Next's fetch cache to memoise.
 */
async function claimantFetch<T>(path: string, cookieValue: string): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method: 'GET',
    headers: {
      cookie: `cpa_claimant_session=${cookieValue}`,
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    let errorCode = 'unknown';
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      errorCode = body.error?.code ?? errorCode;
      message = body.error?.message ?? message;
    } catch {
      // non-JSON body; keep defaults
    }
    throw new ClaimantApiError(res.status, errorCode, message);
  }
  return (await res.json()) as T;
}

export async function getClaimantStatus(
  claimantId: string,
  cookieValue: string,
): Promise<ClaimantStatus> {
  return claimantFetch<ClaimantStatus>(`/v1/claimant-status/${claimantId}`, cookieValue);
}

export async function getAuditScore(claimantId: string, cookieValue: string): Promise<AuditScore> {
  return claimantFetch<AuditScore>(`/v1/audit-score/${claimantId}`, cookieValue);
}
