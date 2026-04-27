'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useRemoveUser } from '@/hooks/use-remove-user';
import { useUpdateUser } from '@/hooks/use-update-user';
import type { UserRef } from '@/hooks/use-user';
import { ConflictError } from '@/lib/api';

const Schema = z.object({
  role: z.enum(['admin', 'consultant', 'viewer']),
  isDefault: z.boolean(),
});
type FormValues = z.infer<typeof Schema>;

export function EditUserForm({ user }: { user: UserRef }) {
  const router = useRouter();
  const { toast } = useToast();
  const update = useUpdateUser(user.id);
  const remove = useRemoveUser(user.id);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: { role: user.role, isDefault: user.isDefault },
  });

  const onSubmit = (values: FormValues) => {
    update.mutate(values, {
      onSuccess: () => {
        toast({ title: 'Updated' });
        router.push('/users');
      },
      onError: (err) => {
        if (err instanceof ConflictError) {
          toast({
            title: 'Cannot demote',
            description: 'Cannot demote the only firm admin. Promote another user first.',
            variant: 'destructive',
          });
        } else {
          toast({
            title: 'Update failed',
            description: err instanceof Error ? err.message : 'Unknown error',
            variant: 'destructive',
          });
        }
      },
    });
  };

  const onRemove = () => {
    remove.mutate(undefined, {
      onSuccess: () => {
        // Close the confirmation dialog before navigating. Leaving it open
        // while router.push fires keeps Radix's focus-trap active and the
        // overlay mounted, which delays the route transition (Playwright
        // observed the navigation never landing within 10s). Closing the
        // dialog first lets focus restore + overlay unmount synchronously.
        setConfirmOpen(false);
        toast({ title: 'Removed from firm' });
        router.push('/users');
      },
      onError: (err) => {
        // Close the dialog FIRST, then surface the toast. Radix's focus-
        // trap + portal pattern keeps the visible toast occluded by the
        // dialog overlay until the dialog unmounts; closing first ensures
        // the toast is reachable for assistive tech and Playwright alike.
        setConfirmOpen(false);
        if (err instanceof ConflictError) {
          toast({
            title: 'Cannot remove',
            description: 'Cannot remove the only firm admin. Promote another user first.',
            variant: 'destructive',
          });
        } else {
          toast({
            title: 'Remove failed',
            description: err instanceof Error ? err.message : 'Unknown error',
            variant: 'destructive',
          });
        }
      },
    });
  };

  return (
    <div className="space-y-6 max-w-lg">
      <div className="text-slate-700">
        <p>
          <strong>{user.email}</strong>
          {user.displayName && <span className="text-slate-500 ml-2">({user.displayName})</span>}
        </p>
        <p className="text-xs text-slate-400">
          Joined {new Date(user.addedAt).toLocaleDateString()}
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Role</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="consultant">Consultant</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="isDefault"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2">
                <FormControl>
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                  />
                </FormControl>
                <FormLabel className="!mt-0">Default firm at login</FormLabel>
              </FormItem>
            )}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.push('/users')}>
              Cancel
            </Button>
          </div>
        </form>
      </Form>

      <hr className="border-slate-200" />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogTrigger asChild>
          <Button variant="destructive">Remove from firm</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {user.email}?</DialogTitle>
            <DialogDescription>
              They will lose access to this firm immediately. Their underlying user account stays
              intact and they may be re-added later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onRemove} disabled={remove.isPending}>
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
