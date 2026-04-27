import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Read the cpa_claimant_session cookie. Redirect to /expired if missing.
 *
 * Used by every page under `/claimant/[claimant_id]/*` that requires an
 * authenticated session. Returns the raw cookie value so the caller can
 * pass it through to the API on a server-side fetch.
 *
 * Cookie validity (signature, audience, expiry) is checked at the API
 * layer when the page's first fetch runs — a signed-but-expired cookie
 * passes this gate but the fetch will 401, which the page-level
 * try/catch maps back to /expired. Cheaper than verifying JWTs in two
 * places.
 */
export async function requireClaimantSession(claimantId: string): Promise<string> {
  const jar = await cookies();
  const session = jar.get('cpa_claimant_session');
  if (!session || session.value.length === 0) {
    redirect(`/claimant/${claimantId}/expired`);
  }
  return session.value;
}
