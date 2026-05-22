'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

function VerifyEmailContent() {
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<'checking' | 'verified' | 'error'>('checking');
  const [message, setMessage] = useState('Verifying your email address...');

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setStatus('error');
      setMessage('This verification link is missing a token. Please request a new signup link.');
      return;
    }

    let cancelled = false;

    async function verify() {
      try {
        const res = await fetch('/v1/auth/verify-email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ token }),
        });

        if (!res.ok) {
          let nextMessage = 'The verification link is invalid or expired.';
          try {
            const body = (await res.json()) as { message?: string };
            if (body.message) nextMessage = body.message;
          } catch {
            /* keep default */
          }
          throw new Error(nextMessage);
        }

        if (!cancelled) {
          setStatus('verified');
          setMessage('Your trial account is ready. Redirecting to Claimsure...');
          window.setTimeout(() => router.replace('/subject-tenants'), 1200);
        }
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setMessage(err instanceof Error ? err.message : 'Verification failed.');
        }
      }
    }

    void verify();
    return () => {
      cancelled = true;
    };
  }, [params, router]);

  return (
    <div className="w-full max-w-md rounded-md border border-border bg-card p-8 text-center shadow-high">
      {status === 'checking' && (
        <Loader2 className="mx-auto h-10 w-10 animate-spin text-brand-accent" aria-hidden="true" />
      )}
      {status === 'verified' && (
        <CheckCircle2 className="mx-auto h-10 w-10 text-brand-accent" aria-hidden="true" />
      )}
      {status === 'error' && (
        <AlertCircle className="mx-auto h-10 w-10 text-destructive" aria-hidden="true" />
      )}

      <h1 className="mt-5 font-display text-2xl font-semibold">
        {status === 'verified' ? 'Email verified' : status === 'error' ? 'Verification failed' : 'Verifying signup'}
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{message}</p>

      {status === 'error' && (
        <Link
          href="/signup"
          className="mt-6 inline-flex h-10 items-center justify-center rounded-sm bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Request a new link
        </Link>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Suspense
        fallback={
          <div className="w-full max-w-md rounded-md border border-border bg-card p-8 text-center shadow-high">
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-brand-accent" aria-hidden="true" />
            <p className="mt-4 text-sm text-muted-foreground">Loading verification...</p>
          </div>
        }
      >
        <VerifyEmailContent />
      </Suspense>
    </main>
  );
}
