'use client';
import { useParams } from 'next/navigation';
import { AuthGuard } from '@/components/auth-guard';
import { SuggestionDetail } from '../_components/suggestion-detail';

/**
 * /suggestions/[id] — prompt-suggestion detail view (P7 Theme B Task B.7).
 *
 * Same shell as `/projects/[project_id]/page.tsx`: AuthGuard wraps the
 * client-rendered detail body. The detail body fetches via TanStack
 * Query against GET /v1/suggestions/:id (B.3); the bottom of the page
 * mounts the PR-tracking widget which polls independently.
 */
export default function SuggestionDetailPage() {
  return (
    <AuthGuard>
      <Inner />
    </AuthGuard>
  );
}

function Inner() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';

  return (
    <main className="container mx-auto py-8 px-4">
      <SuggestionDetail suggestionId={id} />
    </main>
  );
}
