import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AuditScoreGauge } from '../_components/audit-score-gauge';
import { ScoreRuleBreakdown } from '../_components/score-rule-breakdown';
import { ClaimantApiError, getAuditScore, getClaimantStatus } from '../_lib/api';
import { requireClaimantSession } from '../_lib/auth';

/**
 * PWA-claimant audit-readiness score page (T-C13).
 *
 * Server component. Fetches both the score and the brand context in
 * parallel — score for the gauge + breakdown, brand for the page chrome
 * (logo, primary color tints the gauge stroke). Two parallel calls
 * because the score endpoint doesn't carry brand fields and we want the
 * header to match the /status page's branding.
 *
 * Renders:
 *   - Header (firm logo + name)
 *   - "Back to overview" link
 *   - Audit-readiness gauge (large SVG circle, 78/100 placeholder)
 *   - Delta tile (+10 since last week)
 *   - Per-rule breakdown table with progress bars
 *
 * 401/404 → /expired, same as /status. Cookie-driven auth.
 */

interface Props {
  params: Promise<{ claimant_id: string }>;
}

export default async function ClaimantScorePage({ params }: Props) {
  const { claimant_id } = await params;
  const cookieValue = await requireClaimantSession(claimant_id);

  let score, status;
  try {
    [score, status] = await Promise.all([
      getAuditScore(claimant_id, cookieValue),
      getClaimantStatus(claimant_id, cookieValue),
    ]);
  } catch (err) {
    if (err instanceof ClaimantApiError && (err.status === 401 || err.status === 404)) {
      redirect(`/claimant/${claimant_id}/expired`);
    }
    throw err;
  }

  const logoUrl =
    status.brand.logo_s3_key !== null
      ? `https://placeholder-cdn.platform.com.au/${status.brand.logo_s3_key}`
      : null;

  const deltaSign = score.delta_7d > 0 ? '+' : score.delta_7d < 0 ? '' : '±';

  return (
    <main className="min-h-screen bg-slate-50">
      <header
        className="border-b bg-white px-4 py-4"
        style={{ borderTopColor: status.brand.primary_color, borderTopWidth: 4 }}
      >
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          {logoUrl ? (
            <img src={logoUrl} alt={`${status.brand.display_name} logo`} className="h-10 w-auto" />
          ) : (
            <div
              className="flex h-10 w-10 items-center justify-center rounded font-bold text-white"
              style={{ background: status.brand.primary_color }}
            >
              {status.brand.display_name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{status.brand.display_name}</h1>
            <p className="text-xs text-slate-500">{status.subject_tenant.name}</p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <Link
          href={`/claimant/${claimant_id}/status`}
          className="inline-block text-sm font-medium text-blue-600 hover:underline"
        >
          ← Back to overview
        </Link>

        <div className="grid gap-6 md:grid-cols-3">
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Audit-readiness score</CardTitle>
            </CardHeader>
            <CardContent>
              <AuditScoreGauge
                totalPts={score.total_pts}
                maxPts={score.max_pts}
                primaryColor={status.brand.primary_color}
              />
              <p className="mt-3 text-center text-xs text-slate-500">
                Placeholder data — real scoring lands with the audit engine
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">7-day change</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-1">
                <span
                  className={
                    score.delta_7d > 0
                      ? 'text-3xl font-bold text-emerald-600'
                      : score.delta_7d < 0
                        ? 'text-3xl font-bold text-red-600'
                        : 'text-3xl font-bold text-slate-600'
                  }
                >
                  {deltaSign}
                  {Math.abs(score.delta_7d)}
                </span>
                <span className="text-sm text-slate-500">pts</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">Compared to last week</p>
              <p className="mt-3 text-xs text-slate-400">
                Computed{' '}
                {new Date(score.computed_at).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where the score comes from</CardTitle>
          </CardHeader>
          <CardContent>
            <ScoreRuleBreakdown
              rules={score.rule_breakdown}
              primaryColor={status.brand.primary_color}
            />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
