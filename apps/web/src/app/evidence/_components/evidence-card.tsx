import type { EvidenceFeedItem, EvidenceFeedKind } from '@cpa/schemas';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Colored pill for an evidence kind.
 *
 * Colour groups match the existing event-card KindChip in
 * subject-tenants/[id]/_components/kind-chip.tsx. Duplicated here
 * because importing across sibling route segments isn't established
 * convention. If a shared component emerges later, promote it.
 */
const KIND_STYLES: Partial<Record<EvidenceFeedKind, string>> = {
  HYPOTHESIS: 'bg-blue-50 text-blue-700 border-blue-200',
  DESIGN: 'bg-blue-50 text-blue-700 border-blue-200',
  UNCERTAINTY: 'bg-blue-50 text-blue-700 border-blue-200',
  EXPERIMENT: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  OBSERVATION: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ITERATION: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  NEW_KNOWLEDGE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  TIME_LOG: 'bg-amber-50 text-amber-700 border-amber-200',
  ASSOCIATE_FLAG: 'bg-amber-50 text-amber-700 border-amber-200',
  EXPENDITURE_NOTE: 'bg-amber-50 text-amber-700 border-amber-200',
  SUPPORTING: 'bg-amber-50 text-amber-700 border-amber-200',
  INELIGIBLE: 'bg-red-50 text-red-700 border-red-200',
  EVIDENCE_UPLOADED: 'bg-violet-50 text-violet-700 border-violet-200',
};

const formatRelative = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return 'just now';
  if (sec < 90) return '1 minute ago';
  const min = Math.round(sec / 60);
  if (min < 45) return `${min} minutes ago`;
  if (min < 90) return '1 hour ago';
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hours ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 14) return `${day} days ago`;
  return new Date(iso).toLocaleDateString();
};

export interface EvidenceCardProps {
  item: EvidenceFeedItem;
}

export function EvidenceCard({ item }: EvidenceCardProps) {
  return (
    <article className="border rounded-md p-4 space-y-2 bg-card">
      <header className="flex flex-wrap items-center gap-2">
        {/* Kind chip */}
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
            KIND_STYLES[item.kind] ?? 'bg-slate-100 text-slate-700 border-slate-200',
          )}
        >
          {item.kind}
        </span>

        {/* Classification chip (when present) */}
        {item.classification ? (
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
            {item.classification.kind}{' '}
            <span className="ml-1 font-mono text-[10px]">
              {Math.round(item.classification.confidence * 100)}%
            </span>
          </span>
        ) : null}

        {/* Timestamp — right-aligned */}
        <span className="ml-auto text-xs text-muted-foreground">
          {formatRelative(item.captured_at)}
        </span>
      </header>

      {/* Payload excerpt */}
      {item.payload_excerpt ? <p className="text-sm line-clamp-3">{item.payload_excerpt}</p> : null}

      {/* Footer: claimant link + claim link */}
      <footer className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Link
          href={`/subject-tenants/${item.claimant.id}`}
          className="inline-flex items-center rounded-full border border-input bg-background px-2 py-0.5 font-medium hover:border-primary hover:text-primary transition-colors"
        >
          {item.claimant.name}
        </Link>
        {item.claim_id ? (
          <Link
            href={`/claims/${item.claim_id}`}
            className="hover:text-primary transition-colors underline underline-offset-2"
          >
            View claim
          </Link>
        ) : null}
      </footer>
    </article>
  );
}
