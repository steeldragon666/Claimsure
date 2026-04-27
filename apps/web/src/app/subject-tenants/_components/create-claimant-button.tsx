'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ConflictError, ForbiddenError } from '@/lib/api';
import { createSubjectTenant, type CreateSubjectTenantInput } from '../_lib/api';

const Schema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name is too long'),
  kind: z.enum(['claimant', 'financier']),
});
type FormValues = z.infer<typeof Schema>;

/**
 * Create-claimant CTA + modal.
 *
 * On success: invalidates the ['subject-tenants'] list query so the new
 * row shows up immediately, closes the dialog, and routes to the new
 * detail page (where the consultant will paste their first transcript).
 *
 * Error mapping: 409 → "duplicate name" toast; 403 → "admin/consultant
 * required" toast; everything else → generic destructive toast.
 */
export function CreateClaimantButton() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();

  const form = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: { name: '', kind: 'claimant' },
  });

  const mutation = useMutation({
    mutationFn: (input: CreateSubjectTenantInput) => createSubjectTenant(input),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['subject-tenants'] });
      toast({ title: `Claimant "${created.name}" created` });
      setOpen(false);
      form.reset();
      router.push(`/subject-tenants/${created.id}`);
    },
    onError: (err) => {
      if (err instanceof ConflictError) {
        toast({
          title: 'Duplicate claimant name',
          description: 'A claimant with that name already exists in this firm.',
          variant: 'destructive',
        });
      } else if (err instanceof ForbiddenError) {
        toast({
          title: 'Permission denied',
          description: 'Admin or consultant role is required to create claimants.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Failed to create claimant',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    },
  });

  const onSubmit = (values: FormValues) => {
    mutation.mutate(values);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Create claimant</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create claimant</DialogTitle>
          <DialogDescription>
            Add a new claimant chain. You can paste your first activity log right after.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Acme Pty Ltd" autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kind</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select kind" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="claimant">Claimant</SelectItem>
                      <SelectItem value="financier">Financier</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Creating…' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
