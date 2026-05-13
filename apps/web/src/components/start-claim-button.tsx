'use client';
/**
 * StartClaimButton — the prominent, top-level "Start a new claim" CTA that
 * lets a consultant create a wizard-mode claim without first navigating to
 * a specific client firm.
 *
 * Why this exists: the wizard is a real feature but had no good entry
 * points — beta testers had to "know the URL" or navigate Pipeline → click
 * the right card. This button fixes that onboarding gap.
 *
 * Differs from `app/subject-tenants/[id]/_components/create-claim-button.tsx`:
 *   - That component is used from a subject-tenant detail page where the
 *     subject_tenant_id is already known (just asks for fiscal_year).
 *   - This component asks for *both* client firm and fiscal year, so it can
 *     be placed on the dashboard / pipeline / global header.
 *
 * On submit: POST /v1/claims (which auto-initializes wizard mode per
 * commit 7e5dd45 — the workflow_state row is written transactionally in
 * the same INSERT), then router.push('/claims/<id>?step=1') to drop the
 * user straight into wizard step 1. `router.push` (not `.replace`) so the
 * browser back button returns to where they were.
 *
 * No follow-on /workflow/initialize call — that would be redundant and
 * would 409 (the route refuses to overwrite an existing workflow_state).
 *
 * UI primitives: existing shadcn/Radix wrappers in components/ui/ — no new
 * dependencies introduced.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { Claim, SubjectTenant } from '@cpa/schemas';
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
import { useWhoami } from '@/hooks/use-whoami';
import { apiFetch, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api';

/**
 * Default Australian fiscal year. AU FY runs Jul 1 – Jun 30, and a claim
 * for "FY2025" means the FY ending 30 June 2025.
 *
 *   - July (month 6) → Dec (month 11): we're in the FY ending NEXT June
 *     → currentCalendarYear + 1
 *   - Jan (month 0) → June (month 5): we're in the FY ending THIS June
 *     → currentCalendarYear
 */
function defaultFiscalYear(now: Date = new Date()): number {
  return now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
}

/**
 * Form schema — matches the server's CreateClaimBody (packages/schemas).
 * The DB CHECK constraint `claim_fiscal_year_range` enforces 2010-2050;
 * we mirror that here so invalid years are caught before the round trip.
 */
const Schema = z.object({
  subject_tenant_id: z.string().uuid('Select a client firm'),
  fiscal_year: z
    .number({ invalid_type_error: 'Fiscal year must be a number' })
    .int('Fiscal year must be a whole number')
    .min(2010, 'Fiscal year must be 2010 or later')
    .max(2050, 'Fiscal year must be 2050 or earlier'),
});
type FormValues = z.infer<typeof Schema>;

/**
 * Direct POST /v1/claims — kept local so this component doesn't reach
 * into `app/subject-tenants/[id]/_lib/api.ts` (which is intentionally
 * scoped to that route segment).
 */
async function startClaim(input: {
  subject_tenant_id: string;
  fiscal_year: number;
}): Promise<Claim> {
  const body = await apiFetch<{ claim: Claim }>('/v1/claims', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.claim;
}

async function fetchSubjectTenants(): Promise<SubjectTenant[]> {
  const body = await apiFetch<{ subject_tenants: SubjectTenant[] }>('/v1/subject-tenants');
  return body.subject_tenants;
}

interface Props {
  /** Button size — defaults to 'default'. Use 'lg' for hero placements, 'sm' for header. */
  size?: 'default' | 'sm' | 'lg' | 'icon';
  /** Button variant — defaults to 'default'. Use 'ghost' for in-header placement. */
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  /** Override the trigger label. */
  triggerLabel?: string;
  /** Optional className applied to the trigger button. */
  className?: string;
}

export function StartClaimButton({
  size = 'default',
  variant = 'default',
  triggerLabel = 'Start a new claim',
  className,
}: Props = {}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const whoami = useWhoami();
  const firmScope = whoami.data?.user.tenantId ?? 'unknown';

  // Lazy-load the subject-tenants list — only fires once the dialog opens,
  // so the dashboard render doesn't pay for a query most users won't trigger.
  const subjectTenants = useQuery({
    queryKey: ['subject-tenants', firmScope],
    queryFn: fetchSubjectTenants,
    enabled: open,
  });

  // Only claimant-kind subject_tenants can hold R&D claims (financiers
  // are advance-funding counterparties, not R&D entities). Mirrors the
  // filter in create-project-button.tsx.
  const claimants = (subjectTenants.data ?? []).filter((t) => t.kind === 'claimant');

  const form = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: {
      subject_tenant_id: '',
      fiscal_year: defaultFiscalYear(),
    },
  });

  const mutation = useMutation({
    mutationFn: (values: FormValues) => startClaim(values),
    onSuccess: (created) => {
      // Pipeline / claim-list views key off ['claims', ...] — invalidate the
      // root prefix so any cached view picks up the new row on next focus.
      void qc.invalidateQueries({ queryKey: ['claims'] });
      toast({ title: `Claim FY${created.fiscal_year.toString()} created` });
      setOpen(false);
      form.reset({ subject_tenant_id: '', fiscal_year: defaultFiscalYear() });

      // router.push (not replace) so back-button returns to the originating
      // page. The wizard auto-initialized server-side, so step=1 is safe.
      router.push(`/claims/${created.id}?step=1`);
    },
    onError: (err) => {
      if (err instanceof ConflictError) {
        toast({
          title: 'Duplicate fiscal year',
          description:
            'A claim for that fiscal year already exists for this client firm. Open the existing claim instead.',
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
          title: 'Client firm not found',
          description: 'The selected client firm may have been removed. Refresh and try again.',
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

  const noClaimants = subjectTenants.isSuccess && claimants.length === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={size} variant={variant} className={className}>
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a new claim</DialogTitle>
          <DialogDescription>
            Pick the client firm and Australian fiscal year. You&apos;ll land in the wizard at
            step&nbsp;1.
          </DialogDescription>
        </DialogHeader>

        {noClaimants ? (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              You need at least one client firm before starting a claim. Add a client firm first,
              then come back here.
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push('/subject-tenants');
                }}
              >
                Go to Client firms
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
              <FormField
                control={form.control}
                name="subject_tenant_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Client firm</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={subjectTenants.isPending || mutation.isPending}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              subjectTenants.isPending
                                ? 'Loading client firms…'
                                : 'Select a client firm'
                            }
                          />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {claimants.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="fiscal_year"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Fiscal year</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={2010}
                        max={2050}
                        placeholder="e.g. 2025 (= FY ending 30 June 2025)"
                        disabled={mutation.isPending}
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
                  {mutation.isPending ? 'Creating…' : 'Start claim'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
