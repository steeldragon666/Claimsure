'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { Project } from '@cpa/schemas';
import { useWhoami } from '@/hooks/use-whoami';
import { MAX_CLAIMS_FANOUT, listProjectClaims } from '../../_lib/api';

/**
 * Project-detail Claims tab (T-A7).
 *
 * Lists every claim under this project, one row per fiscal year, in
 * the same order the API returns them (`fiscal_year DESC, created_at
 * DESC` from /v1/claims). Each row links to /claims/[claim_id] — the
 * C4 page lives on the p4c/pipeline-documents branch and isn't
 * present on p4a/evidence-engine, so on the merged trunk those links
 * resolve; on this branch alone they will 404. That's a known
 * cross-swimlane integration point, not an A7 bug.
 *
 * Data path:
 *   - Fetches via the `listProjectClaims` fan-out helper. See its
 *     docstring for the chicken-and-egg around GET /v1/claims having
 *     no project_id filter and the per-claim activities probe.
 *
 * Per-row content:
 *   - Fiscal year + stage badge (e.g. "FY2025 — narrative_drafting")
 *   - The claim's matching-activity count (how many activities under
 *     this claim belong to this project)
 *   - Total expenditure: deferred to Swimlane B (T-B6); A2's GET /v1/
 *     claims/:id returns total_expenditure but the list endpoint
 *     doesn't, and we don't fan out a detail call per row to keep this
 *     cheap.
 *   - Created date.
 */

export interface ClaimsTabProps {
  project: Pick<Project, 'id' | 'subject_tenant_id'>;
}

/** Friendly stage label — short version mirroring `apps/web/src/lib/claim-stage.ts` shape. */
const STAGE_LABEL: Record<string, string> = {
  engagement: 'Engagement',
  activity_capture: 'Activity capture',
  narrative_drafting: 'Narrative drafting',
  expenditure_schedule: 'Expenditure schedule',
  review: 'Review',
  submitted: 'Submitted',
  audit_defence: 'Audit defence',
};

export function ClaimsTab({ project }: ClaimsTabProps) {
  // Firm scope in the query key keeps cached results from leaking across
  // tenant switches. `tenantId` may be null on first whoami load — fall
  // back to the project's subject_tenant_id (always present here) so the
  // key is stable and never undefined.
  const whoami = useWhoami();
  const firmScope = whoami.data?.user.tenantId ?? project.subject_tenant_id;

  const claims = useQuery({
    queryKey: ['project-claims', firmScope, project.id],
    queryFn: ({ signal }) => listProjectClaims(project, signal),
  });

  if (claims.isPending) {
    return <p className="text-sm text-muted-foreground">Loading claims…</p>;
  }
  if (claims.error) {
    return (
      <p className="text-sm text-red-600">
        Failed to load claims:{' '}
        {claims.error instanceof Error ? claims.error.message : 'Unknown error'}
      </p>
    );
  }
  if (claims.data.claims.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No claims under this project yet. A claim is created from the pipeline once the consultant
        opens a fiscal year for this engagement.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {claims.data.truncated ? (
        <p
          role="status"
          className="text-xs rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800"
        >
          Showing first {MAX_CLAIMS_FANOUT} claims of {claims.data.total_claims_seen} — truncated.
        </p>
      ) : null}
      <ul className="space-y-2">
        {claims.data.claims.map((claim) => (
          <li key={claim.id}>
            <Link
              href={`/claims/${claim.id}`}
              className="block border rounded-md px-4 py-3 hover:bg-muted transition-colors"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">FY{claim.fiscal_year}</span>
                <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700">
                  {STAGE_LABEL[claim.stage] ?? claim.stage}
                </span>
                <span className="text-xs text-muted-foreground">
                  {claim.project_activity_count}{' '}
                  {claim.project_activity_count === 1 ? 'activity' : 'activities'}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  Created {new Date(claim.created_at).toLocaleDateString()}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
