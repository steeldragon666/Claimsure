'use client';
import { AuthGuard } from '@/components/auth-guard';
import { CreateClaimantButton } from './_components/create-claimant-button';
import { SubjectTenantList } from './_components/subject-tenant-list';

/**
 * /subject-tenants — list of the active firm's claimants + Create CTA.
 *
 * Wraps the inner content in the project-standard AuthGuard (matches
 * /users and /tenants — P1 doesn't use a (authed) route group).
 */
export default function SubjectTenantsPage() {
  return (
    <AuthGuard>
      <Inner />
    </AuthGuard>
  );
}

function Inner() {
  return (
    <main className="container mx-auto py-8 px-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Claimants</h1>
        <CreateClaimantButton />
      </div>
      <SubjectTenantList />
    </main>
  );
}
