'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { Event as ApiEvent } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { overrideEvent } from '../../_lib/api';

/**
 * Override modal — POST /v1/events/:id/override.
 *
 * The 12 ClassifiableKind values mirror packages/schemas/src/event.ts
 * (the API zod-validates the same enum, so submitting a different
 * value would be rejected with a 400). Reason is 1..2000 chars per
 * the schema's overrideEventBody.
 *
 * On success: invalidate ['events', subjectTenantId] to refresh the
 * feed (the new OVERRIDE row appears at the top), invalidate
 * ['chain-status'] (head hash + count both move), and ['subject-tenant']
 * (event_count). Toasts and closes.
 *
 * The modal is controlled — the parent (EventCard) drives `open` and
 * `event` so the same modal instance can be reused for whichever row
 * the consultant clicks Override on.
 */
const KIND_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'HYPOTHESIS', label: 'Hypothesis' },
  { value: 'DESIGN', label: 'Design' },
  { value: 'EXPERIMENT', label: 'Experiment' },
  { value: 'OBSERVATION', label: 'Observation' },
  { value: 'ITERATION', label: 'Iteration' },
  { value: 'NEW_KNOWLEDGE', label: 'New knowledge' },
  { value: 'UNCERTAINTY', label: 'Uncertainty' },
  { value: 'TIME_LOG', label: 'Time log' },
  { value: 'ASSOCIATE_FLAG', label: 'Associate flag' },
  { value: 'EXPENDITURE_NOTE', label: 'Expenditure note' },
  { value: 'SUPPORTING', label: 'Supporting' },
  { value: 'INELIGIBLE', label: 'Ineligible' },
];

const Schema = z.object({
  new_kind: z.enum([
    'HYPOTHESIS',
    'DESIGN',
    'EXPERIMENT',
    'OBSERVATION',
    'ITERATION',
    'NEW_KNOWLEDGE',
    'UNCERTAINTY',
    'TIME_LOG',
    'ASSOCIATE_FLAG',
    'EXPENDITURE_NOTE',
    'SUPPORTING',
    'INELIGIBLE',
  ]),
  reason: z
    .string()
    .min(1, 'A reason is required')
    .max(2000, 'Reason is too long (max 2000 characters)'),
});
type FormValues = z.infer<typeof Schema>;

export interface OverrideModalProps {
  subjectTenantId: string;
  event: ApiEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OverrideModal({ subjectTenantId, event, open, onOpenChange }: OverrideModalProps) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const form = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: { new_kind: 'EXPERIMENT', reason: '' },
  });

  // When the modal opens for a new event, default the kind to the
  // event's current classification so the consultant only has to flip
  // it if they're disagreeing — and clear the reason from any previous
  // override.
  useEffect(() => {
    if (open && event) {
      const current = event.effective_kind;
      const defaultKind = (KIND_OPTIONS.find((o) => o.value === current)?.value ??
        'EXPERIMENT') as FormValues['new_kind'];
      form.reset({ new_kind: defaultKind, reason: '' });
    }
  }, [open, event, form]);

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      if (!event) throw new Error('No event selected');
      return overrideEvent(event.id, values);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['events', subjectTenantId] });
      void qc.invalidateQueries({ queryKey: ['chain-status', subjectTenantId] });
      void qc.invalidateQueries({ queryKey: ['subject-tenant', subjectTenantId] });
      toast({ title: 'Override saved' });
      onOpenChange(false);
    },
    onError: (err) => {
      toast({
        title: 'Failed to save override',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = (values: FormValues) => {
    mutation.mutate(values);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Override classification</DialogTitle>
          <DialogDescription>
            {event ? (
              <>
                Reclassifying event{' '}
                <span className="font-mono text-xs">{event.id.slice(0, 8)}</span>. Currently
                classified as <span className="font-medium">{event.effective_kind}</span>. The
                original event is preserved; this appends an OVERRIDE entry to the chain.
              </>
            ) : (
              'No event selected.'
            )}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
            <FormField
              control={form.control}
              name="new_kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New kind</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select kind" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {KIND_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
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
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Why is the original classification wrong?"
                      className="min-h-[100px]"
                      {...field}
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
                onClick={() => onOpenChange(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending || !event}>
                {mutation.isPending ? 'Saving…' : 'Save override'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
