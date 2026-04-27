'use client';
import { AuthGuard } from '@/components/auth-guard';
import { ApportionmentTable } from './_components/apportionment-table';

/**
 * /admin/apportionment — apportionment workbench (T-B23).
 *
 * Consultant view for setting R&D apportionment_pct on time_entry
 * rows and reviewing payroll-vs-manual flagged conflicts (T-B21).
 *
 * Wrapped in AuthGuard like the rest of the protected web surface
 * (matches /users, /subject-tenants). Inner content is a client
 * component owning the TanStack Query lifecycle.
 */
export default function ApportionmentPage() {
  return (
    <AuthGuard>
      <main className="container mx-auto py-8 px-4 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Apportionment workbench</h1>
          <p className="text-muted-foreground mt-2">
            Set R&amp;D apportionment percentage per time entry. Flagged entries (manual entries
            overlapping payroll-synced periods) require review before they roll into the chain.
          </p>
        </div>
        <ApportionmentTable />
      </main>
    </AuthGuard>
  );
}
