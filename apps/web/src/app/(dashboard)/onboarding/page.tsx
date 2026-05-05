'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGuard } from '@/components/auth-guard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api';

/**
 * Onboarding checklist page (T1.8).
 *
 * Displays the guided onboarding steps for new firm administrators.
 * Each step's completion state is fetched from GET /v1/onboarding/status
 * (computed live from database state -- no stale cache).
 *
 * The "Mark Complete" button calls POST /v1/onboarding/complete and
 * redirects to the dashboard. This is the white-glove flow for first
 * customers; a full self-service wizard lands in P9.
 */

interface OnboardingStep {
  key: string;
  label: string;
  completed: boolean;
  completedAt: string | null;
}

interface OnboardingStatus {
  tenantId: string;
  completed: boolean;
  completedAt: string | null;
  steps: OnboardingStep[];
}

export default function OnboardingPage() {
  return (
    <AuthGuard>
      <OnboardingContent />
    </AuthGuard>
  );
}

function OnboardingContent() {
  const router = useRouter();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchStatus() {
      try {
        const data = await apiFetch<OnboardingStatus>('/v1/onboarding/status');
        if (!cancelled) {
          setStatus(data);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load onboarding status');
          setLoading(false);
        }
      }
    }

    void fetchStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleComplete() {
    setCompleting(true);
    try {
      await apiFetch('/v1/onboarding/complete', { method: 'POST' });
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete onboarding');
      setCompleting(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#FAF8F3]">
        <p className="text-slate-500 font-body">Loading onboarding status...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#FAF8F3]">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-red-600">{error}</p>
            <Button className="mt-4" variant="outline" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!status) return null;

  const completedCount = status.steps.filter((s) => s.completed).length;
  const totalCount = status.steps.length;
  const allDone = completedCount === totalCount;

  return (
    <main className="min-h-screen bg-[#FAF8F3] py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-display font-semibold text-[#5C7A6B] mb-2">
            Welcome to CPA Platform
          </h1>
          <p className="text-slate-600 font-body">
            Complete these steps to get your firm up and running.
          </p>
        </header>

        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex justify-between text-sm text-slate-500 mb-2 font-body">
            <span>Setup progress</span>
            <span>
              {completedCount} of {totalCount} steps complete
            </span>
          </div>
          <div className="w-full bg-slate-200 rounded-full h-2">
            <div
              className="bg-[#5C7A6B] h-2 rounded-full transition-all duration-500"
              style={{ width: `${(completedCount / totalCount) * 100}%` }}
            />
          </div>
        </div>

        {/* Checklist */}
        <Card>
          <CardHeader>
            <CardTitle className="font-display">Onboarding Checklist</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-4">
              {status.steps.map((step) => (
                <li key={step.key} className="flex items-start gap-3">
                  <div
                    className={`mt-0.5 flex-shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
                      step.completed ? 'bg-[#5C7A6B] border-[#5C7A6B]' : 'border-slate-300 bg-white'
                    }`}
                  >
                    {step.completed && (
                      <svg
                        className="w-3.5 h-3.5 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1">
                    <p
                      className={`font-body font-medium ${
                        step.completed ? 'text-slate-700' : 'text-slate-900'
                      }`}
                    >
                      {step.label}
                    </p>
                    {step.completedAt && (
                      <p className="text-xs text-slate-400 mt-0.5">
                        Completed{' '}
                        {new Date(step.completedAt).toLocaleDateString('en-AU', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="mt-8 flex gap-4 justify-end">
          <Button variant="outline" onClick={() => router.push('/')}>
            Skip for now
          </Button>
          <Button
            onClick={() => void handleComplete()}
            disabled={completing}
            className="bg-[#5C7A6B] hover:bg-[#4a6858] text-white"
          >
            {completing ? 'Completing...' : allDone ? 'Complete Setup' : 'Mark as Complete'}
          </Button>
        </div>

        {status.completed && status.completedAt && (
          <p className="mt-4 text-center text-sm text-slate-500 font-body">
            Onboarding was completed on{' '}
            {new Date(status.completedAt).toLocaleDateString('en-AU', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
            .
          </p>
        )}
      </div>
    </main>
  );
}
