'use client';
import { AuthGuard } from '@/components/auth-guard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useWhoami } from '@/hooks/use-whoami';

export default function TenantsPage() {
  return (
    <AuthGuard>
      <Inner />
    </AuthGuard>
  );
}

function Inner() {
  const { data } = useWhoami();
  if (!data) return null;

  const activeId = data.user.tenantId;

  return (
    <main className="container mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold mb-6">My firms</h1>
      <Card>
        <CardHeader>
          <CardTitle>Memberships</CardTitle>
        </CardHeader>
        <CardContent>
          {data.availableTenants.length === 0 ? (
            <p className="text-slate-500">
              No firm memberships yet. Ask your firm admin to add you.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Firm</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Default</TableHead>
                  <TableHead>Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.availableTenants.map((t) => (
                  <TableRow key={t.tenantId}>
                    <TableCell>
                      <div className="font-medium">{t.name}</div>
                      <div className="text-xs text-slate-400">{t.slug}</div>
                    </TableCell>
                    <TableCell>{t.role}</TableCell>
                    <TableCell>{t.isDefault ? 'Yes' : 'No'}</TableCell>
                    <TableCell>{t.tenantId === activeId ? 'Active' : ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="text-sm text-slate-500 mt-4">
            To switch firms, use the dropdown in the dashboard header.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
