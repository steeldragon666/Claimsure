'use client';
import Link from 'next/link';
import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AuthGuard } from '@/components/auth-guard';
import { getSubjectTenant } from '../_lib/api';
import { ChainStatusBadge } from './_components/chain-status-badge';

/**
 * /subject-tenants/[id] — the demo screen scaffold.
 *
 * This commit (T23) lays down the header (claimant name + chain badge +
 * event count) and placeholders for the paste form and event feed; T24
 * fills those in. Following the P1 dynamic-route pattern (see
 * users/[userId]/page.tsx): `'use client'` + React.use(params) so the
 * AuthGuard wraps cleanly without needing server-side cookie reads.
 */
export default function SubjectTenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <AuthGuard>
      <Inner subjectTenantId={id} />
    </AuthGuard>
  );
}

function Inner({ subjectTenantId }: { subjectTenantId: string }) {
  const detail = useQuery({
    queryKey: ['subject-tenant', subjectTenantId],
    queryFn: () => getSubjectTenant(subjectTenantId),
  });

  if (detail.isPending) {
    return (
      <main className="container mx-auto py-8 px-4">
        <p className="text-slate-500">Loading claimant…</p>
      </main>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <main className="container mx-auto py-8 px-4">
        <p className="text-red-600">
          Failed to load claimant:{' '}
          {detail.error instanceof Error ? detail.error.message : 'Unknown error'}
        </p>
        <Link href="/subject-tenants" className="text-sm text-primary underline mt-4 inline-block">
          Back to claimants
        </Link>
      </main>
    );
  }

  const { subject_tenant, event_count } = detail.data;

  return (
    <main className="container mx-auto py-8 px-4 space-y-6">
      <div>
        <Link href="/subject-tenants" className="text-sm text-muted-foreground hover:underline">
          ← Claimants
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{subject_tenant.name}</h1>
        <span className="text-xs text-muted-foreground">{subject_tenant.kind}</span>
        <ChainStatusBadge subjectTenantId={subjectTenantId} />
        <span className="text-xs text-muted-foreground">
          {event_count} event{event_count === 1 ? '' : 's'}
        </span>
      </div>
      {/* T24 fills these in */}
      <div className="text-muted-foreground text-sm">[Paste form coming in T24]</div>
      <div className="text-muted-foreground text-sm">[Event feed coming in T24]</div>
    </main>
  );
}
