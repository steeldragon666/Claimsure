'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

type VerifyStatus = 'checking' | 'verified' | 'error';

interface VerifyErrorBody {
  error?: string;
  message?: string;
}

function Diamond({ className = '' }: { className?: string }) {
  return <span className={`inline-block rotate-45 bg-[#e1a23a] ${className}`} aria-hidden="true" />;
}

function describeVerificationFailure(statusCode: number, body: VerifyErrorBody): string {
  if (body.error === 'already_registered' || statusCode === 409) {
    return 'This email already has an ArchiveOne workspace. Request approved access again if you need a fresh invite.';
  }

  if (body.error === 'invalid_body' || statusCode === 422) {
    return 'This verification link is incomplete. Start signup again so ArchiveOne can issue a fresh link.';
  }

  if (body.error === 'invalid_token' || statusCode === 401) {
    return 'This verification link is invalid, expired, or was issued before the latest production secret update. Start signup again to receive a fresh link.';
  }

  return (
    body.message ??
    'ArchiveOne could not verify this link. Start signup again or contact the pilot operator.'
  );
}

function VerifyPanelFallback() {
  return (
    <VerificationShell>
      <div className="border border-[#f0ebe2]/20 bg-[#131316]/95 p-6 shadow-[0_30px_90px_rgba(0,0,0,0.55)]">
        <Loader2 className="h-10 w-10 animate-spin text-[#e1a23a]" aria-hidden="true" />
        <p className="mt-5 font-body text-sm leading-7 text-[#cdc7bd]">Loading verification...</p>
      </div>
    </VerificationShell>
  );
}

function VerificationShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0b0b0d] px-6 py-8 text-[#f0ebe2] sm:px-10">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(240,235,226,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(240,235,226,0.04)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_90%_70%_at_50%_45%,#000_25%,transparent_92%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_50%_35%_at_50%_100%,rgba(225,162,58,0.09),transparent_70%)]" />

      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl flex-col">
        <nav className="flex items-center justify-between">
          <Link href="/" className="inline-flex items-center gap-3">
            <Diamond className="h-2.5 w-2.5 shadow-[0_0_14px_rgba(225,162,58,0.55)]" />
            <span className="font-display text-xl font-semibold">ArchiveOne</span>
          </Link>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#8a857c]">
            Approved signup only
          </span>
        </nav>

        <div className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[0.95fr_1.05fr]">
          <section>
            <div className="flex w-fit items-center gap-3 border border-[#f0ebe2]/20 bg-[#131316] px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#e1a23a]">
              <Diamond className="h-1.5 w-1.5" />
              Email verification
            </div>
            <h1 className="mt-7 max-w-2xl font-display text-5xl font-light leading-[0.98] tracking-[-0.03em] md:text-7xl">
              Finish the workspace handoff.
            </h1>
            <p className="mt-6 max-w-xl font-body text-base leading-8 text-[#cdc7bd]">
              ArchiveOne checks each verification link before creating the firm tenant and opening
              the consultant workspace.
            </p>
            <div className="mt-10 divide-y divide-[#f0ebe2]/10 border-y border-[#f0ebe2]/10">
              {[
                'Verification links expire after 24 hours.',
                'Fresh links replace stale links after environment updates.',
                'Only approved firm admin signups create new workspaces.',
              ].map((item, index) => (
                <div key={item} className="flex gap-4 py-4">
                  <span className="font-mono text-sm text-[#e1a23a]">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <p className="font-body text-sm leading-6 text-[#cdc7bd]">{item}</p>
                </div>
              ))}
            </div>
          </section>

          {children}
        </div>
      </div>
    </main>
  );
}

function VerifyEmailContent() {
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<VerifyStatus>('checking');
  const [message, setMessage] = useState('Verifying your email address...');

  const token = useMemo(() => params.get('token')?.trim() ?? '', [params]);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage(
        'This verification link is missing a token. Start signup again to get a fresh link.',
      );
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

        const body = (await res.json().catch(() => ({}))) as VerifyErrorBody;

        if (!res.ok) {
          throw new Error(describeVerificationFailure(res.status, body));
        }

        if (!cancelled) {
          setStatus('verified');
          setMessage('Your ArchiveOne trial workspace is ready. Redirecting to the app...');
          window.setTimeout(() => router.replace('/subject-tenants'), 1200);
        }
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setMessage(
            err instanceof Error
              ? err.message
              : 'ArchiveOne could not verify this link. Start signup again to receive a fresh link.',
          );
        }
      }
    }

    void verify();
    return () => {
      cancelled = true;
    };
  }, [router, token]);

  return (
    <VerificationShell>
      <section className="border border-[#f0ebe2]/20 bg-[#131316]/95 p-6 shadow-[0_30px_90px_rgba(0,0,0,0.55)]">
        <div className="flex h-12 w-12 items-center justify-center border border-[#e1a23a]/60">
          {status === 'checking' && (
            <Loader2 className="h-6 w-6 animate-spin text-[#e1a23a]" aria-hidden="true" />
          )}
          {status === 'verified' && (
            <CheckCircle2 className="h-6 w-6 text-[#e1a23a]" aria-hidden="true" />
          )}
          {status === 'error' && (
            <AlertCircle className="h-6 w-6 text-[#f0c5b8]" aria-hidden="true" />
          )}
        </div>

        <div className="mt-6 font-mono text-[11px] uppercase tracking-[0.2em] text-[#e1a23a]">
          Workspace verification
        </div>
        <h2 className="mt-3 font-display text-3xl font-light">
          {status === 'verified'
            ? 'Email verified.'
            : status === 'error'
              ? 'Verification needs a fresh link.'
              : 'Verifying signup.'}
        </h2>
        <p className="mt-4 font-body text-sm leading-7 text-[#cdc7bd]">{message}</p>

        {status === 'error' && (
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="inline-flex h-11 items-center justify-center bg-[#e1a23a] px-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0b0b0d] transition hover:bg-[#efb657]"
            >
              Start signup again
            </Link>
            <Link
              href="/"
              className="inline-flex h-11 items-center justify-center border border-[#f0ebe2]/25 px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-[#f0ebe2] hover:border-[#e1a23a] hover:text-[#e1a23a]"
            >
              Back to site
            </Link>
          </div>
        )}
      </section>
    </VerificationShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<VerifyPanelFallback />}>
      <VerifyEmailContent />
    </Suspense>
  );
}
