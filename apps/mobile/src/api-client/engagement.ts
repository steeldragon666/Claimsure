import { getApiBaseUrl } from '../auth/redeem.js';
import { useSessionStore } from '../auth/session-store.js';

/**
 * Mobile-side engagement-letter client (Wizard Step 1, Task 05).
 *
 * Three calls:
 *   - `fetchPendingEngagement()` — JWT-authed read of the signed-in
 *     employee's pending engagement letter. Used by the cold-start
 *     gate hook to decide whether to render the sign screen.
 *   - `signEngagement(sendToken, typedName)` — public token-gated
 *     sign action. The `sendToken` came from `fetchPendingEngagement`;
 *     the action route itself is unauthed (the token IS the auth
 *     signal) so we don't attach a Bearer here.
 *   - `declineEngagement(sendToken, reason?)` — same shape as sign.
 *
 * No retry / exponential-backoff here — the screen surfaces errors
 * to the user via the standard error state. Pull-to-refresh on the
 * sign screen retriggers the fetch.
 */

export type PendingEngagement = {
  engagementId: string;
  sendToken: string;
  claimId: string;
  renderedMarkdown: string;
  firmName: string;
  consultantName: string | null;
};

/**
 * Fetch the most recent engagement letter in `sent` state for the
 * signed-in employee's claimant. Returns `null` when there is none —
 * the API distinguishes "no pending engagement" (200 + null) from
 * an actual error (non-2xx), so we mirror that here rather than
 * collapsing both into a throw.
 */
export async function fetchPendingEngagement(): Promise<PendingEngagement | null> {
  const session = useSessionStore.getState().session;
  if (!session) throw new Error('not authenticated');
  const url = `${getApiBaseUrl()}/v1/me/pending-engagement`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${session.access_token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /v1/me/pending-engagement → ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { pendingEngagement: PendingEngagement | null };
  return body.pendingEngagement;
}

/**
 * Sign the engagement letter. Public token-gated — no Bearer.
 *
 * Returns the server's `{ engagementId, signedAt }`. Caller (the
 * screen) invalidates the pending-engagement query on success so
 * the gate-hook resolves to null and the sign screen pops itself
 * back to home.
 */
export async function signEngagement(
  sendToken: string,
  typedName: string,
): Promise<{ engagementId: string; signedAt: string }> {
  const url = `${getApiBaseUrl()}/v1/engagement/${encodeURIComponent(sendToken)}/sign`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ typedName }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /v1/engagement/:token/sign → ${res.status}: ${text}`);
  }
  return (await res.json()) as { engagementId: string; signedAt: string };
}

/**
 * Decline the engagement letter with an optional reason. Public
 * token-gated — no Bearer.
 */
export async function declineEngagement(
  sendToken: string,
  reason?: string,
): Promise<{ declinedAt: string }> {
  const url = `${getApiBaseUrl()}/v1/engagement/${encodeURIComponent(sendToken)}/decline`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /v1/engagement/:token/decline → ${res.status}: ${text}`);
  }
  return (await res.json()) as { declinedAt: string };
}
