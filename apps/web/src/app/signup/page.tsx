'use client';

import Link from 'next/link';
import { useState } from 'react';

type SubmitState = 'idle' | 'submitting' | 'denied' | 'error';

function Diamond({ className = '' }: { className?: string }) {
  return <span className={`inline-block rotate-45 bg-[#e1a23a] ${className}`} aria-hidden="true" />;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#8a857c]">
        {label}
      </span>
      {children}
    </label>
  );
}

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [firmName, setFirmName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [state, setState] = useState<SubmitState>('idle');
  const [error, setError] = useState('');
  const [denialMessage, setDenialMessage] = useState('');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState('submitting');
    setError('');
    setDenialMessage('');

    try {
      const res = await fetch('/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          firmName: firmName.trim(),
          displayName: displayName.trim() || undefined,
        }),
      });

      // 200 + redirectTo → autonomous approval, navigate now.
      if (res.status === 200) {
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          decision?: string;
          redirectTo?: string;
        };
        const redirect = body.redirectTo ?? '/subject-tenants';
        window.location.href = redirect;
        return;
      }

      // 403 → polite denial. Message is generic by design (no probing).
      if (res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        setDenialMessage(
          body.message ??
            'We could not auto-approve your request. Please contact aaron@carbonproject.com.au if you believe this is in error.',
        );
        setState('denied');
        return;
      }

      // 422 / 4xx / 5xx → surface the error message from the API if provided.
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      const message =
        body.message ?? 'Signup could not be completed. Please check the details and try again.';
      throw new Error(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup could not be completed.');
      setState('error');
    }
  }

  const inputClass =
    'h-12 w-full border border-[#f0ebe2]/20 bg-[#0b0b0d] px-4 font-body text-sm text-[#f0ebe2] outline-none transition placeholder:text-[#5d594f] focus:border-[#e1a23a] focus:ring-1 focus:ring-[#e1a23a]';

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
            Instant approval
          </span>
        </nav>

        <div className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[0.95fr_1.05fr]">
          <section>
            <div className="flex w-fit items-center gap-3 border border-[#f0ebe2]/20 bg-[#131316] px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#e1a23a]">
              <Diamond className="h-1.5 w-1.5" />
              Founder workspace intake
            </div>
            <h1 className="mt-7 max-w-2xl font-display text-5xl font-light leading-[0.98] tracking-[-0.03em] md:text-7xl">
              Create the first claim chain.
            </h1>
            <p className="mt-6 max-w-xl font-body text-base leading-8 text-[#cdc7bd]">
              Spin up an approved firm admin workspace for evidence capture, accounting-source
              connection, narrative drafting, and claim-pack review.
            </p>
            <div className="mt-10 divide-y divide-[#f0ebe2]/10 border-y border-[#f0ebe2]/10">
              {[
                'Approval runs automatically — no email round-trip.',
                'Most decisions take under two seconds.',
                'Trial workspaces are provisioned instantly with a 30-day window.',
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

          <section className="border border-[#f0ebe2]/20 bg-[#131316]/95 p-6 shadow-[0_30px_90px_rgba(0,0,0,0.55)]">
            {state === 'denied' ? (
              <div className="space-y-6 py-6">
                <div className="flex h-12 w-12 items-center justify-center border border-[#c46a48]/60">
                  <Diamond className="h-3 w-3 bg-[#c46a48]" />
                </div>
                <div>
                  <h2 className="font-display text-3xl font-light">Signup not approved.</h2>
                  <p className="mt-4 font-body text-sm leading-7 text-[#cdc7bd]">{denialMessage}</p>
                </div>
                <Link
                  href="/"
                  className="inline-flex border border-[#f0ebe2]/25 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-[#f0ebe2] hover:border-[#e1a23a] hover:text-[#e1a23a]"
                >
                  Back to site
                </Link>
              </div>
            ) : (
              <form onSubmit={(e) => void onSubmit(e)} className="space-y-5">
                <div>
                  <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#e1a23a]">
                    Workspace registration
                  </div>
                  <h2 className="mt-3 font-display text-3xl font-light">
                    Founder workspace signup
                  </h2>
                  <p className="mt-3 font-body text-sm leading-7 text-[#cdc7bd]">
                    Use your work email so the workspace can be associated with your firm.
                  </p>
                </div>

                {state === 'error' && (
                  <p className="border border-[#c46a48]/50 bg-[#c46a48]/10 p-3 font-body text-sm text-[#f0c5b8]">
                    {error}
                  </p>
                )}

                <Field label="Work email">
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                    placeholder="you@firm.com.au"
                    disabled={state === 'submitting'}
                  />
                </Field>

                <Field label="Firm name">
                  <input
                    required
                    minLength={1}
                    maxLength={200}
                    value={firmName}
                    onChange={(e) => setFirmName(e.target.value)}
                    className={inputClass}
                    placeholder="Acme R&D Advisory"
                    disabled={state === 'submitting'}
                  />
                </Field>

                <Field label="Your name">
                  <input
                    maxLength={200}
                    autoComplete="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className={inputClass}
                    placeholder="Jordan Blake"
                    disabled={state === 'submitting'}
                  />
                </Field>

                <button
                  type="submit"
                  disabled={state === 'submitting'}
                  className="inline-flex h-12 w-full items-center justify-center bg-[#e1a23a] px-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0b0b0d] transition hover:bg-[#efb657] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {state === 'submitting' ? 'Approving your signup…' : 'Create workspace'}
                </button>
              </form>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
