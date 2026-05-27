'use client';
import { AppShell } from '@/components/app-shell';
import { AddUserForm } from '@/components/add-user-form';
import { useWhoami } from '@/hooks/use-whoami';

export default function NewUserPage() {
  return (
    <AppShell>
      <Inner />
    </AppShell>
  );
}

function Inner() {
  const whoami = useWhoami();
  if (whoami.data?.user.role !== 'admin') {
    return <p className="text-sm text-muted-foreground">Admin role required.</p>;
  }
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Administration
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Add firm member</h1>
        <p className="text-muted-foreground max-w-2xl">
          The user must have signed in via Microsoft or Google at least once before being added. New
          users won&apos;t be invited by email — please tell them to complete approved signup first.
        </p>
      </header>
      <AddUserForm />
    </div>
  );
}
