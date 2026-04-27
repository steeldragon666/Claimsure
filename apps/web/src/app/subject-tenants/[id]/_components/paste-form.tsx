'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { createEvent } from '../../_lib/api';

/**
 * The paste-and-classify form.
 *
 * Submits `raw_text` to POST /v1/events; on success:
 *   - invalidates ['events', subjectTenantId, '*'] so the feed re-renders
 *   - invalidates ['chain-status'] and ['subject-tenant'] so the header
 *     badge + event count refresh
 *   - resets the form so the consultant can paste the next entry quickly
 *
 * Cmd/Ctrl+Enter is wired as a keyboard shortcut to match the design
 * doc §5.4 hint ("press ⌘↵ to classify"). The textarea autosizes via
 * a min-height utility and lets the browser handle further growth.
 */
const Schema = z.object({
  raw_text: z
    .string()
    .min(1, 'Paste a transcript or note to classify')
    .max(10_000, 'Max 10,000 characters'),
});
type FormValues = z.infer<typeof Schema>;

export function PasteForm({ subjectTenantId }: { subjectTenantId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const form = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: { raw_text: '' },
  });

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      createEvent({ subject_tenant_id: subjectTenantId, raw_text: values.raw_text }),
    onSuccess: (event) => {
      void qc.invalidateQueries({ queryKey: ['events', subjectTenantId] });
      void qc.invalidateQueries({ queryKey: ['chain-status', subjectTenantId] });
      void qc.invalidateQueries({ queryKey: ['subject-tenant', subjectTenantId] });
      toast({
        title: 'Classified',
        description: `Tagged as ${event.effective_kind}.`,
      });
      form.reset({ raw_text: '' });
    },
    onError: (err) => {
      toast({
        title: 'Failed to classify',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = (values: FormValues) => {
    mutation.mutate(values);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void form.handleSubmit(onSubmit)();
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-3">
        <FormField
          control={form.control}
          name="raw_text"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Paste a transcript or note</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Paste a meeting transcript, lab note, or activity log…"
                  className="min-h-[140px] resize-y"
                  onKeyDown={onKeyDown}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Press <kbd className="rounded border bg-muted px-1 py-0.5">⌘</kbd>+
            <kbd className="rounded border bg-muted px-1 py-0.5">↵</kbd> to classify.
          </p>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Classifying…' : 'Classify'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
