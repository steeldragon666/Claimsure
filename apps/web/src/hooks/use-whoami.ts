'use client';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface WhoamiResponse {
  user: {
    id: string;
    email: string;
    tenantId: string | null;
    role: 'admin' | 'consultant' | 'viewer' | null;
  };
  availableTenants: Array<{
    tenantId: string;
    name: string;
    slug: string;
    role: 'admin' | 'consultant' | 'viewer';
    isDefault: boolean;
  }>;
}

/**
 * Fetches the current user's identity + active firm + memberships.
 *
 * The query key 'whoami' is invalidated by mutations that change identity
 * state (tenant switch, signout). Returning loading/error states lets the
 * AuthGuard component render appropriate UI.
 *
 * 401 errors are typed as UnauthenticatedError; the AuthGuard component
 * (which wraps every authenticated page) catches that and redirects to
 * /signup. Components that consume this hook directly should also handle
 * the loading/error states.
 */
export function useWhoami() {
  return useQuery({
    queryKey: ['whoami'],
    queryFn: () => apiFetch<WhoamiResponse>('/v1/whoami'),
  });
}
