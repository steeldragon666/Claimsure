'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { UnauthenticatedError } from '@/lib/api';
import { useWhoami } from '@/hooks/use-whoami';

/**
 * Wraps an authenticated page. Renders nothing while the whoami query
 * is loading; redirects to /signup on 401 (UnauthenticatedError); shows
 * a fallback for any other error.
 *
 * Usage:
 *   export default function ProtectedPage() {
 *     return <AuthGuard><PageContent /></AuthGuard>;
 *   }
 *
 * The query is configured (in query-client.ts) NOT to retry on 401, so
 * the redirect fires immediately on cookie expiry.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data, isLoading, error } = useWhoami();
  const router = useRouter();

  useEffect(() => {
    if (error instanceof UnauthenticatedError) {
      router.push('/signup');
    }
  }, [error, router]);

  if (isLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-slate-500">Loading…</p>
      </main>
    );
  }

  if (error instanceof UnauthenticatedError) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-slate-500">Redirecting to approved signup...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-red-600">Error loading session: {error.message}</p>
      </main>
    );
  }

  if (!data) return null;

  return <>{children}</>;
}
