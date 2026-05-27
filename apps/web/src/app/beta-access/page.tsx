'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function BetaAccessForm() {
  const params = useSearchParams();
  const errorParam = params.get('error');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch('/api/beta/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-md w-full space-y-6 rounded-lg border border-border bg-card p-8">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          ArchiveOne beta access
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Enter your email. If it&apos;s on the beta allowlist, you&apos;ll get a magic link valid
          for 15 minutes.
        </p>
      </header>

      {errorParam === 'expired' && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          That magic link has expired. Request a new one below.
        </p>
      )}
      {errorParam === 'invalid' && (
        <p className="rounded-md border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900">
          That magic link is invalid. Request a new one below.
        </p>
      )}

      {submitted ? (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          If your email is on the beta allowlist, check your inbox for a link.
        </p>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Email address</span>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="alice@firm.com.au"
            />
          </label>
          <button
            type="submit"
            disabled={submitting || email.length === 0}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? 'Sending\u2026' : 'Send magic link'}
          </button>
        </form>
      )}
    </div>
  );
}

export default function BetaAccessPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <Suspense
        fallback={
          <div className="max-w-md w-full rounded-lg border border-border bg-card p-8">
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        }
      >
        <BetaAccessForm />
      </Suspense>
    </main>
  );
}
