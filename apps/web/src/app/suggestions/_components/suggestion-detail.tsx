'use client';
import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { PrTrackingWidget } from '@/components/pr-tracking-widget';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { getSuggestion } from '../_lib/api';
import {
  canGeneratePr,
  formatRelativeTime,
  STATUS_BADGE_BASE,
  statusBadgeClasses,
} from '../_lib/helpers';
import {
  SUGGESTION_REVIEW_DISPOSITION_LABELS,
  SUGGESTION_SOURCE_KIND_LABELS,
  SUGGESTION_STATUS_LABELS,
  SUGGESTION_TRIAGE_CLASSIFICATION_LABELS,
  type SuggestionDetailResponse,
} from '../_lib/types';
import { GeneratePrButton } from './generate-pr-button';
import { ReviewForm } from './review-form';
import { TriageForm } from './triage-form';

/**
 * /suggestions/[id] detail view body. Fetches the detail document and
 * renders:
 *   - Header: status badge + issue summary + flagged info
 *   - Side panel: source_payload (JSON), affected fields, reviews
 *   - Main panel: triage / review forms (gated by status)
 *   - PR-tracking widget at bottom
 *
 * The PR-tracking widget owns its own polling — we pass it the same
 * detail snapshot for an initial paint, but it has its own query key
 * (`suggestion-detail`) so the polling cycles independently. The detail
 * view's own query is a one-shot fetch (no refetchInterval) to avoid
 * double-polling.
 */

/**
 * Feature flag for the Generate-PR button. Defaults OFF.
 *
 * Why: P7 Theme B Phase 1 ships the entire generate-PR pipeline (B.4
 * evaluator agent + B.5 atomic GitHub-App choreography + B.6 webhook
 * receiver) but does NOT wire the production evaluator into the API
 * server. `apps/api/src/server.ts` calls `buildApp()` with no
 * `promptSuggestions.evaluate` dep, so today the route returns
 *   503 evaluator_not_configured
 * for every authenticated request. Rendering the button as if it
 * works would give consultants a non-functional CTA.
 *
 * Phase 2 (B.5.1 follow-up) wires the production evaluator + flips
 * this flag on by default. Until then the button is hidden by default
 * and can be enabled in dev/staging by setting
 *   NEXT_PUBLIC_FEATURE_GENERATE_PR=true
 * to exercise the dep-injection seam against a stubbed evaluator.
 *
 * The state-machine gate `canGeneratePr(status)` remains independent
 * — it asserts "this transition is allowed", not "this feature ships".
 */
const FEATURE_GENERATE_PR = process.env['NEXT_PUBLIC_FEATURE_GENERATE_PR'] === 'true';

export interface SuggestionDetailProps {
  suggestionId: string;
}

export function SuggestionDetail({ suggestionId }: SuggestionDetailProps): React.ReactElement {
  const detail = useQuery<SuggestionDetailResponse>({
    queryKey: ['suggestion-detail', suggestionId],
    queryFn: ({ signal }) => getSuggestion(suggestionId, signal),
  });

  if (detail.isPending) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="suggestion-detail-loading">
        Loading suggestion…
      </p>
    );
  }

  if (detail.error) {
    const isNotFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="space-y-3" data-testid="suggestion-detail-error">
        <Link
          href="/suggestions"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:underline"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to queue
        </Link>
        {isNotFound ? (
          <div className="rounded-md border border-dashed py-10 px-4 text-center space-y-2">
            <p className="text-sm font-medium">Suggestion not found</p>
            <p className="text-xs text-muted-foreground font-mono">{suggestionId}</p>
            <p className="text-xs text-muted-foreground">
              The suggestion may have been removed, or you may not have access in this firm.
            </p>
          </div>
        ) : (
          <p className="text-sm text-destructive">
            Failed to load suggestion:{' '}
            {detail.error instanceof Error ? detail.error.message : 'Unknown error'}
          </p>
        )}
      </div>
    );
  }

  const data = detail.data;
  if (!data) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }

  const { suggestion, reviews } = data;

  return (
    <div className="space-y-6" data-testid="suggestion-detail">
      <div className="space-y-3">
        <Link
          href="/suggestions"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:underline"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to queue
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2 flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(STATUS_BADGE_BASE, statusBadgeClasses(suggestion.status))}
                data-testid="suggestion-detail-status"
                data-status={suggestion.status}
              >
                {SUGGESTION_STATUS_LABELS[suggestion.status]}
              </span>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {SUGGESTION_SOURCE_KIND_LABELS[suggestion.source_kind]}
              </span>
              <span
                className="font-mono text-xs text-muted-foreground tabular-nums"
                title={suggestion.id}
              >
                {suggestion.id}
              </span>
            </div>
            <h1 className="font-display text-2xl font-semibold text-foreground break-words">
              {suggestion.issue_summary}
            </h1>
            <p className="text-xs text-muted-foreground">
              Flagged{' '}
              <span className="font-mono tabular-nums" title={suggestion.flagged_at}>
                {formatRelativeTime(suggestion.flagged_at)}
              </span>{' '}
              by{' '}
              <span className="font-mono tabular-nums" title={suggestion.flagged_by_user_id}>
                {suggestion.flagged_by_user_id.slice(0, 8)}
              </span>
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Side panel */}
        <aside className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-base">Forensic data</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Field label="Module" value={suggestion.affected_prompt_module} mono />
              <Field label="Section" value={suggestion.affected_section_kind} mono />
              <Field
                label="Triage"
                value={
                  suggestion.triage_classification
                    ? SUGGESTION_TRIAGE_CLASSIFICATION_LABELS[suggestion.triage_classification]
                    : null
                }
              />
              <Field
                label="First recorded"
                value={
                  suggestion.first_recorded_at
                    ? formatRelativeTime(suggestion.first_recorded_at)
                    : null
                }
                mono
              />
              <Field
                label="Resolved"
                value={suggestion.resolved_at ? formatRelativeTime(suggestion.resolved_at) : null}
                mono
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-display text-base">Source payload</CardTitle>
            </CardHeader>
            <CardContent>
              <pre
                className="rounded-sm bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-words overflow-auto max-h-72"
                data-testid="suggestion-detail-source-payload"
              >
                {JSON.stringify(suggestion.source_payload, null, 2)}
              </pre>
            </CardContent>
          </Card>

          {reviews.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base">Reviews ({reviews.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {reviews.map((r) => (
                  <div key={r.id} className="border rounded-sm p-2 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        {SUGGESTION_REVIEW_DISPOSITION_LABELS[r.disposition]}
                      </span>
                      <span
                        className="font-mono text-[10px] text-muted-foreground tabular-nums"
                        title={r.reviewed_at}
                      >
                        {formatRelativeTime(r.reviewed_at)}
                      </span>
                    </div>
                    {r.notes ? (
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                        {r.notes}
                      </p>
                    ) : null}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </aside>

        {/* Main panel */}
        <section className="lg:col-span-2 space-y-4">
          {suggestion.status === 'open' ? (
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base">Triage</CardTitle>
              </CardHeader>
              <CardContent>
                <TriageForm suggestionId={suggestion.id} />
              </CardContent>
            </Card>
          ) : null}

          {suggestion.status === 'triaged' ? (
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base">Review</CardTitle>
              </CardHeader>
              <CardContent>
                <ReviewForm suggestionId={suggestion.id} />
              </CardContent>
            </Card>
          ) : null}

          {FEATURE_GENERATE_PR && canGeneratePr(suggestion.status) ? (
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base">Generate pull request</CardTitle>
              </CardHeader>
              <CardContent>
                <GeneratePrButton suggestionId={suggestion.id} />
              </CardContent>
            </Card>
          ) : null}

          {suggestion.status === 'pr_drafted' ? (
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base">Awaiting merge</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  A pull request has been drafted. The webhook receiver flips this suggestion to{' '}
                  <span className="font-medium">PR merged</span> when GitHub merges the PR.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {suggestion.status === 'pr_merged' || suggestion.status === 'dismissed' ? (
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base">Resolved</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  This suggestion is closed. No further actions are available.
                </p>
              </CardContent>
            </Card>
          ) : null}

          <PrTrackingWidget suggestionId={suggestion.id} initialDetail={data} />
        </section>
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}

function Field({ label, value, mono = false }: FieldProps): React.ReactElement {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground w-24 shrink-0">
        {label}
      </dt>
      <dd className={cn('flex-1 break-words text-sm', mono && 'font-mono tabular-nums text-xs')}>
        {value ?? <span className="text-muted-foreground italic">—</span>}
      </dd>
    </div>
  );
}
