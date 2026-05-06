'use client';

import Link from 'next/link';
import { use } from 'react';
import { AuthGuard } from '@/components/auth-guard';
import { FormCompletenessGauge } from './_components/form-completeness-gauge';
import { BeneficialOwnershipPanel } from './_components/beneficial-ownership-panel';
import { KnowledgeSearchPanel } from './_components/knowledge-search-panel';
import { FacilitiesPanel } from './_components/facilities-panel';
import { ForecastPanel } from './_components/forecast-panel';
import { SimilarityDashboardPanel } from './_components/similarity-dashboard-panel';

export default function CompliancePage({
  params,
}: {
  params: Promise<{ subject: string; fy: string }>;
}) {
  const { subject, fy } = use(params);
  return (
    <AuthGuard>
      <Inner subject={subject} fy={fy} />
    </AuthGuard>
  );
}

function Inner({ subject, fy }: { subject: string; fy: string }) {
  return (
    <main className="container mx-auto max-w-7xl py-8 px-4 space-y-6">
      <div>
        <Link
          href={`/subject-tenants/${subject}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          &larr; Back to claimant
        </Link>
      </div>

      <div>
        <h1 className="font-display text-2xl font-semibold">Compliance Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Form readiness for <span className="font-mono text-xs tabular-nums">{fy}</span>
        </p>
      </div>

      <FormCompletenessGauge subject={subject} fy={fy} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BeneficialOwnershipPanel subject={subject} fy={fy} />
        <KnowledgeSearchPanel subject={subject} fy={fy} />
        <FacilitiesPanel subject={subject} fy={fy} />
        <ForecastPanel subject={subject} fy={fy} />
        <SimilarityDashboardPanel subject={subject} fy={fy} />
      </div>
    </main>
  );
}
