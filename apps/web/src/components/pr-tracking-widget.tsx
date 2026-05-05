'use client';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { getSuggestion } from '@/app/suggestions/_lib/api';
import { prTrackingDisplayState, truncateMergeSha } from '@/app/suggestions/_lib/helpers';
import {
  TERMINAL_SUGGESTION_STATUSES,
  type PromptSuggestionPr,
  type SuggestionDetailResponse,
  type SuggestionStatus,
} from '@/app/suggestions/_lib/types';
import { cn } from '@/lib/utils';

/**
 * P7 Theme B Task B.7 — PR-tracking widget.
 *
 * Renders the linked `prompt_suggestion_pr` row for a given suggestion
 * and polls `GET /v1/suggestions/:id` every 10 s until the suggestion
 * reaches a terminal status (`pr_merged` / `dismissed`). Stops polling
 * automatically once the status is terminal so we don't hammer the API
 * for resolved rows.
 *
 * Visual language follows the design system "forensic-metadata chip"
 * convention:
 *   - Hairline border (`border` resolves to `--border`).
 *   - Patina-accent verify-pulse animation while a status flip is
 *     in-flight (matches the chain-verify chip in chain-status-badge.tsx).
 *   - JetBrains Mono for the merge_commit_sha (forensic data).
 *
 * Lives outside `app/suggestions/_components/` because the spec calls
 * it out as a reusable widget — a future surface (e.g. a dashboard
 * tile) can import it the same way the multi-cycle-timeline component
 * is consumed cross-page.
 */

export interface PrTrackingWidgetProps {
  /** Suggestion id whose PR row we're tracking. */
  suggestionId: string;
  /**
   * Optional initial detail snapshot — if the parent has already
   * fetched the detail for the page header, threading it through
   * avoids the first-paint flash before the polling query lands. The
   * widget will still poll on its own schedule.
   */
  initialDetail?: SuggestionDetailResponse;
}

/**
 * Polling interval for the in-flight detail fetch.
 *
 * 10 s is the spec value. Reasonable trade: a webhook flip from B.6
 * usually arrives within seconds of GitHub merging, so the user sees
 * the change with at-most-10s lag; meanwhile the API gets one cheap
 * read every 10 s while the queue is open, which scales linearly with
 * "active reviewer windows" (a tiny multiplier).
 */
const PR_POLL_INTERVAL_MS = 10_000;

export function PrTrackingWidget({
  suggestionId,
  initialDetail,
}: PrTrackingWidgetProps): React.ReactElement {
  const detail = useQuery<SuggestionDetailResponse>({
    queryKey: ['suggestion-detail', suggestionId],
    queryFn: ({ signal }) => getSuggestion(suggestionId, signal),
    initialData: initialDetail,
    // Refetch every 10 s while the suggestion is in-flight; stop once
    // it reaches a terminal status. Returning `false` here disables the
    // interval — TanStack Query treats it as "don't poll".
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return PR_POLL_INTERVAL_MS;
      if (TERMINAL_SUGGESTION_STATUSES.has(data.suggestion.status)) {
        return false;
      }
      return PR_POLL_INTERVAL_MS;
    },
    // Don't refetch on focus while polling is enabled — would just
    // double up the request flow when the tab regains focus.
    refetchOnWindowFocus: false,
  });

  const data = detail.data;
  const status: SuggestionStatus | undefined = data?.suggestion.status;
  const pr: PromptSuggestionPr | null = data?.pr ?? null;

  if (detail.isPending && !data) {
    return (
      <div
        className="rounded-md border bg-card px-4 py-3 text-sm text-muted-foreground"
        data-testid="pr-tracking-widget-loading"
      >
        Loading PR status…
      </div>
    );
  }

  if (detail.error && !data) {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        data-testid="pr-tracking-widget-error"
      >
        Failed to load PR status:{' '}
        {detail.error instanceof Error ? detail.error.message : 'Unknown error'}
      </div>
    );
  }

  if (!status) {
    // Defensive: query resolved without data and no error. Render the
    // empty shell rather than crash.
    return (
      <div
        className="rounded-md border bg-card px-4 py-3 text-sm text-muted-foreground"
        data-testid="pr-tracking-widget-empty"
      >
        No PR status available.
      </div>
    );
  }

  const display = prTrackingDisplayState(status, pr);

  return (
    <div
      className={cn(
        'rounded-md border bg-card px-4 py-3 space-y-3',
        display.isInFlight && 'animate-verify-pulse',
      )}
      data-testid="pr-tracking-widget"
      data-display-kind={display.kind}
      data-suggestion-status={status}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-sm font-semibold text-foreground">Pull request</h3>
        <span
          className="text-xs uppercase tracking-wide text-muted-foreground"
          data-testid="pr-tracking-widget-status-label"
        >
          {displayKindLabel(display.kind)}
        </span>
      </div>

      {display.kind === 'no_pr_yet' ? (
        <p className="text-sm text-muted-foreground">
          No PR has been generated yet. The reviewer will trigger PR generation after triage.
        </p>
      ) : pr ? (
        <PrDetails pr={pr} />
      ) : (
        // The unknown / dismissed-without-pr fallthrough.
        <p className="text-sm text-muted-foreground">
          {display.kind === 'dismissed'
            ? 'Suggestion was dismissed before a PR was generated.'
            : 'PR row not yet visible — refreshing in the background.'}
        </p>
      )}
    </div>
  );
}

function displayKindLabel(kind: ReturnType<typeof prTrackingDisplayState>['kind']): string {
  switch (kind) {
    case 'no_pr_yet':
      return 'Awaiting PR';
    case 'drafted':
      return 'Drafted';
    case 'merged':
      return 'Merged';
    case 'dismissed':
      return 'Dismissed';
    case 'unknown':
      return 'Syncing';
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return String(kind);
    }
  }
}

function PrDetails({ pr }: { pr: PromptSuggestionPr }): React.ReactElement {
  const [shaExpanded, setShaExpanded] = React.useState(false);
  return (
    <dl className="space-y-2 text-sm">
      <div className="flex items-baseline gap-2">
        <dt className="text-xs uppercase tracking-wide text-muted-foreground w-24 shrink-0">PR</dt>
        <dd className="flex-1 break-words">
          <a
            href={pr.github_pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          >
            <span className="font-mono tabular-nums">#{pr.github_pr_number}</span>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </dd>
      </div>
      <div className="flex items-baseline gap-2">
        <dt className="text-xs uppercase tracking-wide text-muted-foreground w-24 shrink-0">
          Branch
        </dt>
        <dd className="flex-1 font-mono text-xs break-all">{pr.branch_name}</dd>
      </div>
      <div className="flex items-baseline gap-2">
        <dt className="text-xs uppercase tracking-wide text-muted-foreground w-24 shrink-0">
          Created
        </dt>
        <dd className="flex-1 font-mono tabular-nums text-xs">
          {new Date(pr.created_at).toLocaleString()}
        </dd>
      </div>
      {pr.merged_at ? (
        <div className="flex items-baseline gap-2">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground w-24 shrink-0">
            Merged
          </dt>
          <dd className="flex-1 font-mono tabular-nums text-xs">
            {new Date(pr.merged_at).toLocaleString()}
          </dd>
        </div>
      ) : null}
      {pr.merge_commit_sha ? (
        <div className="flex items-baseline gap-2">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground w-24 shrink-0">
            Commit
          </dt>
          <dd className="flex-1 font-mono text-xs break-all">
            <button
              type="button"
              onClick={() => setShaExpanded((v) => !v)}
              className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={shaExpanded ? 'Click to collapse' : 'Click to expand'}
              data-testid="pr-tracking-widget-sha-toggle"
              data-expanded={shaExpanded}
            >
              {shaExpanded ? pr.merge_commit_sha : truncateMergeSha(pr.merge_commit_sha)}
            </button>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
