'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { listSubjectTenants } from '../_lib/api';

/**
 * Client-rendered list of claimants in the active firm.
 *
 * Uses the project-standard apiFetch + useQuery pattern (see hooks/use-users
 * for the same shape). The empty state is the demo-friendly "Create claimant
 * to begin" copy from design doc §5.1.
 */
export function SubjectTenantList() {
  const { data, isPending, error } = useQuery({
    queryKey: ['subject-tenants'],
    queryFn: listSubjectTenants,
  });

  if (isPending) {
    return <p className="text-slate-500">Loading…</p>;
  }
  if (error) {
    return (
      <p className="text-red-600">
        Failed to load claimants: {error instanceof Error ? error.message : 'Unknown error'}
      </p>
    );
  }
  if (data.length === 0) {
    return (
      <p className="text-slate-500">
        No claimants yet. Click &quot;Create claimant&quot; to begin.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {data.map((st) => (
        <li key={st.id} className="border rounded-md p-4 hover:bg-muted transition-colors">
          <Link href={`/subject-tenants/${st.id}`} className="font-medium">
            {st.name}
          </Link>
          <span className="ml-2 text-xs text-muted-foreground">{st.kind}</span>
        </li>
      ))}
    </ul>
  );
}
