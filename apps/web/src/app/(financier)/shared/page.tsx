'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { FederationShare, FederatedClaim } from '../_lib/api';
import { fetchShares, fetchSharedClaims } from '../_lib/api';

/**
 * P9 Phase 3 — Financier portal: shared claims listing.
 *
 * Lists all active federation_share records for the current tenant (as
 * target), then fetches claims under each share. Read-only — no edit
 * buttons, no admin navigation.
 *
 * Design system: cream paper (#FAF8F3), patina green (#5C7A6B),
 * Fraunces serif headings.
 */

interface ShareWithClaims {
  share: FederationShare;
  claims: FederatedClaim[];
}

export default function SharedClaimsPage() {
  const [data, setData] = useState<ShareWithClaims[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const shares = await fetchShares();
        const results = await Promise.all(
          shares.map(async (share) => ({
            share,
            claims: await fetchSharedClaims(share.id),
          })),
        );
        if (!cancelled) {
          setData(results);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load shared claims');
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="text-slate-500 font-body">Loading shared claims...</p>;
  }

  if (error) {
    return <p className="text-red-600 font-body">{error}</p>;
  }

  if (data.length === 0) {
    return (
      <div className="text-center py-16">
        <h2 className="text-xl font-display font-semibold text-slate-700 mb-2">No shared claims</h2>
        <p className="text-slate-500 font-body">
          No consultant firms have shared claim data with your organisation yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-2xl font-display font-semibold text-slate-900 mb-1">Shared Claims</h2>
        <p className="text-slate-500 font-body">
          R&amp;D Tax Incentive claims shared with your organisation via federation.
        </p>
      </header>

      {data.map(({ share, claims }) => (
        <Card key={share.id}>
          <CardHeader>
            <CardTitle className="font-display text-lg">{share.subject_tenant_name}</CardTitle>
            <p className="text-sm text-slate-500 font-body">
              Shared by {share.source_tenant_name} &middot; Granted{' '}
              {new Date(share.granted_at).toLocaleDateString('en-AU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
              {share.expires_at && (
                <>
                  {' '}
                  &middot; Expires{' '}
                  {new Date(share.expires_at).toLocaleDateString('en-AU', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </>
              )}
            </p>
          </CardHeader>
          <CardContent>
            {claims.length === 0 ? (
              <p className="text-sm text-slate-400 font-body">No claims found for this entity.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {claims.map((claim) => (
                  <li key={claim.id}>
                    <Link
                      href={`/shared/${claim.id}?share=${share.id}`}
                      className="flex items-center justify-between py-3 hover:bg-slate-50 -mx-2 px-2 rounded-md transition-colors"
                    >
                      <div>
                        <p className="font-body font-medium text-slate-900">{claim.project_name}</p>
                        <p className="text-sm text-slate-500 font-body">
                          FY{claim.fiscal_year} &middot; {claim.stage}
                        </p>
                      </div>
                      <svg
                        className="w-5 h-5 text-slate-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
