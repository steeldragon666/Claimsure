'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ForensicChip } from '@/components/forensic-chip';
import type { FederatedClaimDetail } from '../../_lib/api';
import { fetchClaimDetail } from '../../_lib/api';

/**
 * P9 Phase 3 — Financier portal: claim detail view.
 *
 * Displays a single claim's activities and narrative drafts with
 * ForensicChip provenance stamps. Read-only — no edit buttons,
 * no comment surfaces, no admin navigation.
 *
 * Design system: cream paper (#FAF8F3), patina green (#5C7A6B),
 * Fraunces serif headings, ForensicChip for audit timestamps.
 */

export default function ClaimDetailPage() {
  const params = useParams<{ claimId: string }>();
  const searchParams = useSearchParams();
  const shareId = searchParams.get('share');

  const [data, setData] = useState<FederatedClaimDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!shareId || !params.claimId) {
        setError('Missing share or claim identifier');
        setLoading(false);
        return;
      }

      try {
        const detail = await fetchClaimDetail(shareId, params.claimId);
        if (!cancelled) {
          setData(detail);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load claim detail');
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [shareId, params.claimId]);

  if (loading) {
    return <p className="text-slate-500 font-body">Loading claim detail...</p>;
  }

  if (error) {
    return <p className="text-red-600 font-body">{error}</p>;
  }

  if (!data) return null;

  const { claim, activities, narratives } = data;

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <nav className="text-sm text-slate-500 font-body">
        <Link href="/shared" className="hover:text-[#5C7A6B] transition-colors">
          Shared Claims
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-900">{claim.project_name}</span>
      </nav>

      {/* Claim header */}
      <header>
        <h2 className="text-2xl font-display font-semibold text-slate-900 mb-1">
          {claim.project_name}
        </h2>
        <p className="text-slate-500 font-body">
          {claim.subject_tenant_name} &middot; FY{claim.fiscal_year} &middot; {claim.stage}
        </p>
      </header>

      {/* Activities */}
      <section>
        <h3 className="text-lg font-display font-semibold text-slate-800 mb-4">
          R&amp;D Activities
        </h3>
        {activities.length === 0 ? (
          <p className="text-sm text-slate-400 font-body">No activities recorded.</p>
        ) : (
          <div className="space-y-3">
            {activities.map((activity) => (
              <Card key={activity.id}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start gap-3">
                    <span className="inline-flex items-center justify-center rounded bg-[#5C7A6B]/10 px-2 py-0.5 text-xs font-mono text-[#5C7A6B]">
                      {activity.code}
                    </span>
                    <div>
                      <p className="font-body font-medium text-slate-900">{activity.title}</p>
                      {activity.description && (
                        <p className="text-sm text-slate-500 font-body mt-1">
                          {activity.description}
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Narratives */}
      <section>
        <h3 className="text-lg font-display font-semibold text-slate-800 mb-4">Narrative Drafts</h3>
        {narratives.length === 0 ? (
          <p className="text-sm text-slate-400 font-body">No narrative drafts available.</p>
        ) : (
          <div className="space-y-4">
            {narratives.map((narrative) => (
              <Card key={narrative.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="font-display text-base capitalize">
                      {narrative.section_kind.replace(/_/g, ' ')}
                    </CardTitle>
                    <ForensicChip
                      hash={narrative.content_hash}
                      capturedAt={narrative.created_at}
                      version={`v${narrative.version}`}
                      size="sm"
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="prose prose-sm prose-slate max-w-none font-body">
                    {narrative.content.split('\n').map((paragraph, i) => (
                      <p key={i}>{paragraph}</p>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
