'use client';
/**
 * Create-claim CTA + modal for the subject-tenant detail page.
 *
 * On success: invalidates the ['claims', subject_tenant_id] query so the new
 * row shows up immediately, closes the dialog, and routes to the new claim
 * detail page (/claims/<id>).
 *
 * Mirrors CreateClaimantButton's structure (Dialog + RHF + Zod +
 * TanStack mutation + toast) so the codebase has one consistent shape
 * for create-* dialogs.
 *
 * Error mapping: 409 → "duplicate FY" toast; 403 → "permission denied"
 * toast; 404 → "claimant not found" toast; everything else → generic
 * destructive toast.
 */
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
import { useToast } from '@/hooks/use-toast';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api';
import { createClaim } from '../_lib/api';

/**
 * Form schema — mirrors CreateClaimBody in packages/schemas/src/claim.ts:
 *   - subject_tenant_id: injected via prop (not a form field)
 *   - fiscal_year: required integer (Australian FY, e.g. 2025 = FY ending
 *     30 June 2025). Min 2000, max 2100 for sanity.
 *
 * `stage` and `ausindustry_reference` are intentionally omitted from the
 * create form — stage defaults to 'engagement' server-side and the
 * AusIndustry reference is only known post-submission. Consultants can
 * update them via the claim detail page once the claim exists.
 */
const Schema = z.object({
  fiscal_year: z
    .number({ invalid_type_error: 'Fiscal year must be a number' })
    .int('Fiscal year must be a whole number')
    .min(2000, 'Fiscal year must be 2000 or later')
    .max(2100, 'Fiscal year must be 2100 or earlier'),
});
type FormValues = z.infer<typeof Schema>;

interface Props {
  subjectTenantId: string;
  /** Optional className applied to the trigger button. */
  triggerClassName?: string;
  /** Override the trigger label. Defaults to "New claim". */
  triggerLabel?: string;
}

export function CreateClaimButton({
  subjectTenantId,
  triggerClassName,
  triggerLabel = 'New claim',
}: Props) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();

  const form = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: {
      fiscal_year: new Date().getFullYear(),
    },
  });

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      createClaim({
        subject_tenant_id: subjectTenantId,
        fiscal_year: values.fiscal_year,
      }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['claims', subjectTenantId] });
      toast({ title: `Claim FY${created.fiscal_year.toString()} created` });
      setOpen(false);
      form.reset();

      // Workflow state is now written transactionally inside the
      // POST /v1/claims INSERT (see apps/api/src/routes/claims.ts) — no
      // follow-on initialize call is needed. The claim is a wizard claim
      // from the moment it lands, so GET /workflow returns 200
      // immediately on the next page load.
      router.push(`/claims/${created.id}?step=1`);
    },
    onError: (err) => {
      if (err instanceof ConflictError) {
        toast({
          title: 'Duplicate fiscal year',
          description: 'A claim for that fiscal year already exists for this claimant.',
          variant: 'destructive',
        });
      } else if (err instanceof ForbiddenError) {
        toast({
          title: 'Permission denied',
          description: 'Admin or consultant role is required to create claims.',
          variant: 'destructive',
        });
      } else if (err instanceof NotFoundError) {
        toast({
          title: 'Claimant not found',
          description: 'The claimant may have been removed. Refresh and try again.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Failed to create claim',
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
        <Button className={triggerClassName}>{triggerLabel}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New claim</DialogTitle>
          <DialogDescription>
            Create an R&amp;D Tax Incentive claim for a specific Australian fiscal year. The claim
            starts in the &apos;Engagement&apos; stage and moves through the pipeline as work
            progresses.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
            <FormField
              control={form.control}
              name="fiscal_year"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fiscal year</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="e.g. 2025 (= FY ending 30 June 2025)"
                      autoFocus
                      {...field}
                      onChange={(e) => field.onChange(e.target.valueAsNumber)}
                    />
                  </FormControl>
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
                {mutation.isPending ? 'Creating…' : 'Create claim'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
