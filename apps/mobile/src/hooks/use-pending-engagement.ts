import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { fetchPendingEngagement, type PendingEngagement } from '../api-client/engagement.js';
import { useSessionStore } from '../auth/session-store.js';

/**
 * React Query hook for the mobile first-launch engagement gate
 * (Wizard Step 1, Task 05).
 *
 * Wraps `GET /v1/me/pending-engagement` so the authed layout can
 * decide whether to redirect to the sign screen. Returns `null` when
 * there is no pending engagement — that's a NORMAL non-error state
 * (the user has nothing to sign and the app should render the home
 * screen).
 *
 * Disabled while there is no session — there's no Bearer to attach,
 * so the query would throw immediately. The `enabled` guard lets the
 * unauthed layout mount this hook conditionally without an explicit
 * branch.
 *
 * `staleTime` is intentionally short (15s) because the consultant
 * may re-send the letter while the app is open; the pull-to-refresh
 * on the sign screen also invalidates this query directly.
 */
export const PENDING_ENGAGEMENT_QUERY_KEY = ['me', 'pending-engagement'] as const;

export function usePendingEngagement(): UseQueryResult<PendingEngagement | null, Error> {
  const session = useSessionStore((s) => s.session);
  return useQuery<PendingEngagement | null, Error>({
    queryKey: PENDING_ENGAGEMENT_QUERY_KEY,
    queryFn: fetchPendingEngagement,
    enabled: session !== null,
    staleTime: 15_000,
  });
}

/**
 * Imperative refetch helper for callers that aren't using the hook's
 * return value (eg. the sign / decline mutations on the sign screen
 * want to invalidate the cache after a successful action so the
 * authed layout's gate resolves to `null` and renders home).
 */
export function useInvalidatePendingEngagement(): () => Promise<void> {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: PENDING_ENGAGEMENT_QUERY_KEY });
  };
}
