import { getApiBaseUrl } from '../auth/redeem.js';
import { useSessionStore } from '../auth/session-store.js';

/**
 * Mobile-side signing-request client (T-B7).
 *
 * The DocuSign envelope flow lands in p3b (B6). For v1 in this
 * worktree we declare the types locally so the mobile screen
 * compiles in isolation; on merge with p3b we swap the imports for
 * the shared @cpa/schemas types and drop the local declarations.
 *
 * TODO(post-merge): replace `SigningRequest` / `SigningStatus` with
 * the shared schemas equivalents once @cpa/schemas/signing lands.
 */
export type SigningStatus = 'pending' | 'sent' | 'delivered' | 'completed' | 'declined' | 'voided';

export type SigningRequest = {
  id: string;
  envelope_id: string | null;
  status: SigningStatus;
  signing_url: string | null;
  expires_at: string | null;
};

/**
 * Fetch the current signing request by id.
 *
 * Calls GET /v1/signing/:id (B6 — registered in the p3b worktree;
 * unavailable in this worktree until merge). Returns the typed shape
 * above. On 404 / 5xx the caller surfaces the error to the user; we
 * don't auto-retry from this layer.
 */
export async function getSigningRequest(id: string): Promise<SigningRequest> {
  const session = useSessionStore.getState().session;
  if (!session) throw new Error('not authenticated');
  const url = `${getApiBaseUrl()}/v1/signing/${id}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${session.access_token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /v1/signing/${id} → ${res.status}: ${text}`);
  }
  return (await res.json()) as SigningRequest;
}
