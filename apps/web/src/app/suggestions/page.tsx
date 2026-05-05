'use client';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { AuthGuard } from '@/components/auth-guard';
import { FlagSuggestionModal } from '@/components/flag-suggestion-modal';
import { SuggestionList } from './_components/suggestion-list';
import { parseSuggestionSourceKindFilter, parseSuggestionStatusFilter } from './_lib/url-params';

/**
 * /suggestions — prompt-suggestion queue list view (P7 Theme B Task B.7).
 *
 * URL-driven filters (defaults shown when omitted):
 *   - `?status=open|triaged|pr_drafted|pr_merged|dismissed|all`  (default: all)
 *   - `?source_kind=consultant_flag|rif_event|contract_test_failure|reviewer_disposition|all`  (default: all)
 *
 * Same shell as `/projects/page.tsx` and `/users/page.tsx`: AuthGuard
 * wraps the client-rendered list. The list view fetches via TanStack
 * Query against GET /v1/suggestions (B.3); the New Suggestion CTA in
 * the header opens the FlagSuggestionModal which POSTs and routes to
 * the new detail page.
 */
export default function SuggestionsPage() {
  return (
    <AuthGuard>
      <Inner />
    </AuthGuard>
  );
}

function Inner() {
  const searchParams = useSearchParams();
  const status = parseSuggestionStatusFilter(searchParams.get('status'));
  const sourceKind = parseSuggestionSourceKindFilter(searchParams.get('source_kind'));

  return (
    <main className="container mx-auto py-8 px-4">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold text-foreground">
            Prompt Suggestions
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Flagged issues with agent outputs. Reviewers triage each suggestion, optionally generate
            a PR, and the queue tracks the lifecycle through merge.
          </p>
        </div>
        <FlagSuggestionModal>
          <Button>New suggestion</Button>
        </FlagSuggestionModal>
      </div>
      <SuggestionList status={status} sourceKind={sourceKind} />
    </main>
  );
}
