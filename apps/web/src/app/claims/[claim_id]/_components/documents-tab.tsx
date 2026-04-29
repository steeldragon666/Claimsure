'use client';
import { Download } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { listActivities } from '../_lib/api';

/**
 * Documents tab — working list of available PDF downloads for this claim.
 *
 * Two sections:
 *   1. Claim-level documents — generated from claim aggregate data.
 *      C7 shipped the first entry (claim summary); C9 adds the
 *      apportionment report. Future entries (cover letter, etc.) go
 *      here as new <DocumentRow>s.
 *
 *   2. Activity-level documents — one row per activity. Today the only
 *      per-activity download is the activity application PDF (A8). A8
 *      lives on a separate branch and may not be merged into main yet;
 *      the link still renders to demonstrate the pattern (404 in this
 *      branch's preview is expected).
 *
 * Each link uses `Button asChild + <a download>` so the anchor inherits
 * shadcn's button styles + receives the browser's "save as" prompt
 * behaviour for `application/pdf` responses. Per the C7 spec we do NOT
 * promote this pattern to a shared component — keeping it inline is
 * cheaper than a one-call wrapper.
 *
 * Data: `listActivities(claimId)` is the C4 stub and resolves to the
 * activity fixture today (5 entries). Once A3 ships and `listActivities`
 * is wired to the real endpoint, the activity list updates without a
 * code change here.
 */
export function DocumentsTab({ claimId }: { claimId: string }) {
  const activities = useQuery({
    queryKey: ['activities', { claimId }] as const,
    queryFn: () => listActivities(claimId),
  });

  return (
    <div className="space-y-6">
      <section aria-labelledby="documents-claim-level-heading">
        <h2 id="documents-claim-level-heading" className="text-base font-semibold">
          Claim-level documents
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Generated from the aggregate of this claim&apos;s activities and expenditures.
        </p>
        <ul className="mt-3 divide-y rounded-md border bg-background">
          <DocumentRow
            label="Claim summary"
            description="One-page overview: activities table, expenditures rollup."
            href={`/v1/claims/${claimId}/summary.pdf`}
            downloadName={`claim-summary-${claimId}.pdf`}
          />
          <DocumentRow
            label="Apportionment report"
            description="Audit-grade detail: how each expenditure mapped to activities."
            href={`/v1/claims/${claimId}/apportionment.pdf`}
            downloadName={`apportionment-${claimId}.pdf`}
          />
        </ul>
      </section>

      <section aria-labelledby="documents-activity-level-heading">
        <h2 id="documents-activity-level-heading" className="text-base font-semibold">
          Activity-level documents
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          One application PDF per activity — Section 355-25 narrative bundle.
        </p>
        <div className="mt-3">
          {activities.isPending ? (
            <p className="text-sm text-muted-foreground">Loading activities…</p>
          ) : activities.error ? (
            <p className="text-sm text-red-600">
              Failed to load activities:{' '}
              {activities.error instanceof Error ? activities.error.message : 'Unknown error'}
            </p>
          ) : activities.data.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No activities yet for this claim. Add an activity to enable per-activity downloads.
              </p>
            </div>
          ) : (
            <ul className="divide-y rounded-md border bg-background">
              {activities.data.map((a) => (
                <DocumentRow
                  key={a.id}
                  label={`Activity application — ${a.code} ${a.title}`}
                  description={a.kind === 'core' ? 'Core activity' : 'Supporting activity'}
                  href={`/v1/activities/${a.id}/application.pdf`}
                  downloadName={`activity-${a.code.toLowerCase()}-application.pdf`}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

interface DocumentRowProps {
  label: string;
  description: string;
  href: string;
  downloadName: string;
}

/**
 * Single download row. Inline `Button asChild` + `<a download>` per the
 * C7 spec — keeps the anchor semantics (download attribute, right-click
 * "Open in new tab") while inheriting shadcn styles.
 *
 * `download` carries the suggested filename — browsers honour the server
 * Content-Disposition first, but this works as a fallback for callers
 * that don't set it (and gives screen-reader users an additional hint).
 */
function DocumentRow(props: DocumentRowProps) {
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <div className="flex-1">
        <p className="text-sm font-medium">{props.label}</p>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <a href={props.href} download={props.downloadName}>
          <Download aria-hidden="true" />
          Download PDF
        </a>
      </Button>
    </li>
  );
}
