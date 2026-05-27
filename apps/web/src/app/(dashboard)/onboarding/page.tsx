'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
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
    <AppShell>
      <OnboardingContent />
    </AppShell>
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
    return <p className="text-sm text-muted-foreground">Loading onboarding status...</p>;
  }

  if (error) {
    return (
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{error}</p>
          <Button className="mt-4" variant="outline" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!status) return null;

  const completedCount = status.steps.filter((s) => s.completed).length;
  const totalCount = status.steps.length;
  const allDone = completedCount === totalCount;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Onboarding
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Welcome to ArchiveOne
        </h1>
        <p className="text-muted-foreground">
          Complete these steps to get your firm up and running.
        </p>
      </header>

      {/* Progress indicator */}
      <div>
        <div className="flex justify-between font-mono text-xs text-muted-foreground mb-2">
          <span className="uppercase tracking-widest text-[10px]">Setup progress</span>
          <span>
            {completedCount} of {totalCount} steps complete
          </span>
        </div>
        <div className="w-full bg-muted rounded-full h-2">
          <div
            className="bg-primary h-2 rounded-full transition-all duration-500"
            style={{ width: `${(completedCount / totalCount) * 100}%` }}
          />
        </div>
      </div>

      {/* Checklist */}
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-2xl font-medium">Onboarding checklist</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-4">
            {status.steps.map((step) => (
              <li key={step.key} className="flex items-start gap-3">
                <div
                  className={`mt-0.5 flex-shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
                    step.completed ? 'bg-primary border-primary' : 'border-border bg-card'
                  }`}
                >
                  {step.completed && (
                    <svg
                      className="w-3.5 h-3.5 text-primary-foreground"
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
                    className={`font-medium ${
                      step.completed ? 'text-muted-foreground' : 'text-foreground'
                    }`}
                  >
                    {step.label}
                  </p>
                  {step.completedAt && (
                    <p className="font-mono text-xs text-muted-foreground mt-0.5">
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
      <div className="flex gap-4 justify-end">
        <Button variant="outline" onClick={() => router.push('/')}>
          Skip for now
        </Button>
        <Button onClick={() => void handleComplete()} disabled={completing}>
          {completing ? 'Completing...' : allDone ? 'Complete setup' : 'Mark as complete'}
        </Button>
      </div>

      {status.completed && status.completedAt && (
        <p className="text-center text-sm text-muted-foreground">
          Onboarding was completed on{' '}
          <span className="font-mono">
            {new Date(status.completedAt).toLocaleDateString('en-AU', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </span>
          .
        </p>
      )}
    </div>
  );
}
