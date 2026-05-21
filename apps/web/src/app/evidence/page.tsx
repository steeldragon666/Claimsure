'use client';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { EvidenceFeed } from './_components/evidence-feed';
import { EvidenceFilterBar } from './_components/evidence-filter-bar';
import { parseClaimantIds, parseEvidenceKinds } from './_lib/url-params';

/**
 * /evidence — Cross-claimant evidence feed.
 *
 * URL is the source of truth for filter state (?kinds=..., ?claimant_ids=...).
 * The page parses URL params, passes them to the filter bar (for display)
 * and the feed (for data fetching via React Query).
 *
 * Replaces the P1 "coming next" stub.
 */
export default function EvidencePage() {
  return (
    <AppShell>
      <Inner />
    </AppShell>
  );
}

function Inner() {
  const searchParams = useSearchParams();
  const kinds = parseEvidenceKinds(searchParams.get('kinds'));
  const claimantIds = parseClaimantIds(searchParams.get('claimant_ids'));

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Workspace
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Evidence</h1>
        <p className="text-muted-foreground max-w-2xl">
          AI-classified evidence from raw documents, pictures, videos, and voice notes — across all
          claimants.
        </p>
      </header>

      <EvidenceFilterBar activeKinds={kinds} />
      <EvidenceFeed kinds={kinds} claimantIds={claimantIds} />
    </div>
  );
}
