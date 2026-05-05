'use client';
import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { ApiError, ConflictError } from '@/lib/api';
import { reviewSuggestion } from '../_lib/api';
import {
  SUGGESTION_REVIEW_DISPOSITION_LABELS,
  SUGGESTION_REVIEW_DISPOSITIONS,
  type SuggestionReviewDisposition,
} from '../_lib/types';

/**
 * Review form — surfaced on the detail view when status === 'triaged'.
 *
 * Posts to POST /v1/suggestions/:id/review (B.3). On `dismiss` disposition
 * the API flips the suggestion's status to `dismissed`; the other three
 * dispositions leave the suggestion in `triaged` for follow-up. After
 * a successful submit we invalidate both the detail and the queue list
 * queries so the UI reflects any side-effect.
 */

export interface ReviewFormProps {
  suggestionId: string;
}

interface FormValues {
  disposition: SuggestionReviewDisposition;
  notes: string;
}

const DEFAULT_VALUES: FormValues = {
  disposition: 'approve_for_pr',
  notes: '',
};

export function ReviewForm({ suggestionId }: ReviewFormProps): React.ReactElement {
  const [values, setValues] = React.useState<FormValues>(DEFAULT_VALUES);
  const [formError, setFormError] = React.useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const reviewMutation = useMutation({
    mutationFn: (input: FormValues) =>
      reviewSuggestion(suggestionId, {
        disposition: input.disposition,
        notes: input.notes.trim() || undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['suggestion-detail', suggestionId] });
      void qc.invalidateQueries({ queryKey: ['suggestions'] });
      toast({
        title: 'Review recorded',
        description: `Disposition: ${SUGGESTION_REVIEW_DISPOSITION_LABELS[values.disposition]}`,
      });
      setValues(DEFAULT_VALUES);
    },
    onError: (err) => {
      // 409 — stale state. Refresh the detail query so the form-gating
      // updates (the user sees the correct state instead of a stale form).
      if (err instanceof ConflictError) {
        void qc.invalidateQueries({ queryKey: ['suggestion-detail', suggestionId] });
      }
      const message =
        err instanceof ApiError
          ? `${err.errorCode}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Unknown error';
      setFormError(message);
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    reviewMutation.mutate(values);
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" data-testid="review-form">
      <div className="space-y-1.5">
        <Label htmlFor="review_disposition">Disposition</Label>
        <select
          id="review_disposition"
          value={values.disposition}
          onChange={(e) =>
            setValues((v) => ({
              ...v,
              disposition: e.target.value as SuggestionReviewDisposition,
            }))
          }
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {SUGGESTION_REVIEW_DISPOSITIONS.map((d) => (
            <option key={d} value={d}>
              {SUGGESTION_REVIEW_DISPOSITION_LABELS[d]}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="review_notes">
          Notes <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="review_notes"
          value={values.notes}
          onChange={(e) => setValues((v) => ({ ...v, notes: e.target.value }))}
          placeholder="Reviewer notes (preserved on the review row)"
          rows={3}
          maxLength={1000}
        />
      </div>

      {formError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="review-form-error"
        >
          {formError}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={reviewMutation.isPending}>
          {reviewMutation.isPending ? 'Recording…' : 'Record review'}
        </Button>
      </div>
    </form>
  );
}
