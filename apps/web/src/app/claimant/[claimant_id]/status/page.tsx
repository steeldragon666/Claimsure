import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClaimStageTimeline } from '../_components/claim-stage-timeline';
import { RecentEventsFeed } from '../_components/recent-events-feed';
import { ClaimantApiError, getClaimantStatus } from '../_lib/api';
import { requireClaimantSession } from '../_lib/auth';

/**
 * PWA-claimant status page (T-C12).
 *
 * Server component. Reads the claimant_id from URL params, pulls the
 * session cookie, fetches the status payload server-side, and renders:
 *
 *   - Page header: firm display_name + logo (if set)
 *   - Claim stage timeline (7 stages, current highlighted)
 *   - Audit-readiness score teaser (links to /score for the full gauge)
 *   - Recent events feed (last 5)
 *   - Pending RFIs (empty state for v1)
 *
 * On 401 (cookie expired or invalid signature) we redirect back to
 * /expired so the user can request a new link from their consultant.
 * On 404 (cross-firm or unknown claimant) we redirect to /expired too —
 * the practical outcome is the same: this employee can't see this
 * claimant.
 *
 * The "Audit-readiness 78/100" tile here is a placeholder — the full
 * gauge + per-rule breakdown lives at /score. We render a static value
 * here so the page paints without an extra round-trip; the /score page
 * is the authoritative view, both reading from the same audit-score
 * endpoint (T-C13 lands the dedicated route).
 */

interface Props {
  params: Promise<{ claimant_id: string }>;
}

export default async function ClaimantStatusPage({ params }: Props) {
  const { claimant_id } = await params;
  const cookieValue = await requireClaimantSession(claimant_id);

  let data;
  try {
    data = await getClaimantStatus(claimant_id, cookieValue);
  } catch (err) {
    if (err instanceof ClaimantApiError && (err.status === 401 || err.status === 404)) {
      redirect(`/claimant/${claimant_id}/expired`);
    }
    throw err;
  }

  const logoUrl =
    data.brand.logo_s3_key !== null
      ? `https://placeholder-cdn.platform.com.au/${data.brand.logo_s3_key}`
      : null;

  return (
    <main className="min-h-screen bg-slate-50">
      <header
        className="border-b bg-white px-4 py-4"
        // Inline style so the firm's primary_color tints the header
        // without a tailwind config rebuild. The body chrome stays
        // neutral so brand color reads as accent, not flood.
        style={{ borderTopColor: data.brand.primary_color, borderTopWidth: 4 }}
      >
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          {logoUrl ? (
            <img src={logoUrl} alt={`${data.brand.display_name} logo`} className="h-10 w-auto" />
          ) : (
            <div
              className="flex h-10 w-10 items-center justify-center rounded font-bold text-white"
              style={{ background: data.brand.primary_color }}
            >
              {data.brand.display_name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{data.brand.display_name}</h1>
            <p className="text-xs text-slate-500">{data.subject_tenant.name}</p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Claim progress</CardTitle>
          </CardHeader>
          <CardContent>
            <ClaimStageTimeline currentStage={data.claim_stage} />
          </CardContent>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Audit readiness</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-bold text-slate-900">78</span>
                <span className="text-sm text-slate-500">/ 100</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Placeholder score — full breakdown coming with the scoring engine
              </p>
              <Link
                href={`/claimant/${claimant_id}/score`}
                className="mt-3 inline-block text-sm font-medium text-blue-600 hover:underline"
              >
                See full breakdown →
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Outstanding requests</CardTitle>
            </CardHeader>
            <CardContent>
              {data.pending_rfis.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No requests from your consultant right now. You&apos;ll see any document or
                  evidence asks here.
                </p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {data.pending_rfis.map((rfi) => (
                    <li key={rfi.id} className="flex justify-between">
                      <span>{rfi.document_kind}</span>
                      <span className="text-slate-500">
                        {new Date(rfi.requested_at).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            <RecentEventsFeed events={data.recent_events} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
