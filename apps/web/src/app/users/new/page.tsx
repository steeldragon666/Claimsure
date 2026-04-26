'use client';
import { AuthGuard } from '@/components/auth-guard';
import { AddUserForm } from '@/components/add-user-form';
import { useWhoami } from '@/hooks/use-whoami';

export default function NewUserPage() {
  return (
    <AuthGuard>
      <Inner />
    </AuthGuard>
  );
}

function Inner() {
  const whoami = useWhoami();
  if (whoami.data?.user.role !== 'admin') {
    return (
      <main className="container mx-auto py-8 px-4">
        <p className="text-slate-500">Admin role required.</p>
      </main>
    );
  }
  return (
    <main className="container mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold mb-6">Add firm member</h1>
      <p className="text-sm text-slate-500 mb-6">
        The user must have signed in via Microsoft or Google at least once before being added. New
        users won&apos;t be invited by email — please tell them to sign in first.
      </p>
      <AddUserForm />
    </main>
  );
}
