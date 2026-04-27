'use client';
import { useQuery } from '@tanstack/react-query';
import { getChainStatus } from '../../_lib/api';

/**
 * Renders a small inline pill summarising chain integrity:
 *   - verified=true → green "Verified" with hash-locked count
 *   - verified=false → red "Hash break" with the first break index
 *
 * Uses ASCII glyphs (^ / !) instead of unicode icons because shadcn's
 * lucide-react integration is fine but a plain pill is more demo-stable
 * across font fallbacks. The ChainStatus shape mirrors verifyChain in
 * @cpa/db (re-declared in api.ts to keep the web app shielded from the
 * db internal type).
 */
export function ChainStatusBadge({ subjectTenantId }: { subjectTenantId: string }) {
  const { data, isPending, error } = useQuery({
    queryKey: ['chain-status', subjectTenantId],
    queryFn: () => getChainStatus(subjectTenantId),
  });

  if (isPending) {
    return <span className="text-xs text-muted-foreground">Loading chain…</span>;
  }
  if (error) {
    return (
      <span className="text-xs text-red-600">
        Chain check failed: {error instanceof Error ? error.message : 'unknown error'}
      </span>
    );
  }
  if (data.verified) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5 text-xs font-medium border border-emerald-200">
        Verified ({data.event_count} event{data.event_count === 1 ? '' : 's'})
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-50 text-red-700 px-2 py-0.5 text-xs font-medium border border-red-200">
      Hash break at event #{data.first_break_at ?? '?'}
    </span>
  );
}
