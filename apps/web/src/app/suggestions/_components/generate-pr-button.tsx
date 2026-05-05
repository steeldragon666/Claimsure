'use client';
import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { ApiError } from '@/lib/api';
import { generatePullRequest } from '../_lib/api';

/**
 * Generate-PR CTA — surfaced on the detail view when status === 'triaged'.
 *
 * Posts to POST /v1/suggestions/:id/generate-pr (B.5 choreography). On
 * success the API returns the freshly-inserted prompt_suggestion_pr row
 * + the parent suggestion flipped to `pr_drafted`; we invalidate the
 * detail query so the page re-renders with the new state (the
 * ReviewForm card unmounts; the "Awaiting merge" card mounts).
 *
 * Two-step confirm: the first click reveals a "Confirm" button + Cancel,
 * the second click fires the request. This matches the spec's
 * "confirm dialog (briefly)" without pulling in a Radix AlertDialog.
 *
 * Error surface (matches the handler's HTTP map):
 *   - 422 contract_test_failed     → render structured detail (test output)
 *   - 502 github_upstream_failure  → toast "GitHub API error"
 *   - 503 *_not_configured         → toast "PR generation not configured"
 *   - other                        → generic ApiError message
 *
 * The component is deliberately split from <ReviewForm> so the consultant
 * decides explicitly when to spend the (~30-120s) PR generation budget.
 */

export interface GeneratePrButtonProps {
  suggestionId: string;
}

interface ContractTestDetail {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export function GeneratePrButton({ suggestionId }: GeneratePrButtonProps): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  const [contractFailure, setContractFailure] = React.useState<{
    message: string;
    detail: ContractTestDetail;
  } | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: () => generatePullRequest(suggestionId),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['suggestion-detail', suggestionId] });
      void qc.invalidateQueries({ queryKey: ['suggestions'] });
      setConfirming(false);
      setContractFailure(null);
      toast({
        title: 'Pull request drafted',
        description: `#${data.pr.github_pr_number} on branch ${data.pr.branch_name}`,
      });
    },
    onError: (err) => {
      setConfirming(false);
      if (err instanceof ApiError) {
        // 422 — contract test failed: surface stdout/stderr inline so the
        // consultant can see exactly what the evaluator produced.
        if (err.status === 422 && err.errorCode === 'contract_test_failed') {
          // The ApiError class loses the `detail` blob from the JSON body
          // (apiFetch only carries error+message). Re-fetch the response
          // body via a second request? No — instead, surface the message
          // and a generic hint; full detail lives in server logs.
          // (Future: extend ApiError to carry the JSON envelope.)
          setContractFailure({
            message: err.message,
            detail: {},
          });
          return;
        }
        if (err.status === 502) {
          toast({
            variant: 'destructive',
            title: 'GitHub API error',
            description: 'GitHub upstream failed; please try again.',
          });
          return;
        }
        if (err.status === 503) {
          toast({
            variant: 'destructive',
            title: 'PR generation not configured for this environment',
            description: err.message,
          });
          return;
        }
        if (err.status === 409) {
          // Stale state: someone else moved this past `triaged`. Refresh
          // the detail query so the form-gating updates.
          void qc.invalidateQueries({ queryKey: ['suggestion-detail', suggestionId] });
          toast({
            variant: 'destructive',
            title: 'Suggestion state changed',
            description: 'Refreshing to show the latest state.',
          });
          return;
        }
        toast({
          variant: 'destructive',
          title: `Error ${err.status}`,
          description: `${err.errorCode}: ${err.message}`,
        });
        return;
      }
      toast({
        variant: 'destructive',
        title: 'Unexpected error',
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (contractFailure) {
    return (
      <div className="space-y-3" data-testid="generate-pr-contract-failure">
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <p className="font-medium">Contract test failed</p>
          <p className="mt-1 text-xs">{contractFailure.message}</p>
          {contractFailure.detail.stderr ? (
            <pre className="mt-2 max-h-48 overflow-auto rounded-sm bg-background p-2 text-[11px] font-mono whitespace-pre-wrap">
              {contractFailure.detail.stderr}
            </pre>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setContractFailure(null)}
          >
            Dismiss
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="generate-pr-button-root">
      <p className="text-sm text-muted-foreground">
        Drafts a pull request via the GitHub App with the proposed changes. PR opens in draft state
        for human review.
      </p>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-foreground">Open a draft PR for this suggestion?</span>
          <Button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            data-testid="generate-pr-confirm"
          >
            {mutation.isPending ? 'Generating…' : 'Confirm'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirming(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button type="button" onClick={() => setConfirming(true)} data-testid="generate-pr-button">
          Generate PR
        </Button>
      )}
    </div>
  );
}
