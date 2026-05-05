'use client';
import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { ApiError, ConflictError } from '@/lib/api';
import { triageSuggestion } from '../_lib/api';
import {
  SUGGESTION_TRIAGE_CLASSIFICATION_LABELS,
  SUGGESTION_TRIAGE_CLASSIFICATIONS,
  type SuggestionTriageClassification,
} from '../_lib/types';

/**
 * Triage form — surfaced on the detail view when status === 'open'.
 *
 * Posts to POST /v1/suggestions/:id/triage. The API enforces:
 *   - reviewer role (admin / consultant) — viewers see 403
 *   - status_after must be one of {triaged, dismissed}
 *
 * The form is the only path from `open → triaged` (or `open → dismissed`
 * without a review trail). We assume the parent only mounts the form
 * for status='open' suggestions; the API guards the state-machine for
 * defence in depth.
 */

export interface TriageFormProps {
  suggestionId: string;
}

interface FormValues {
  triage_classification: SuggestionTriageClassification;
  status_after: 'triaged' | 'dismissed';
  notes: string;
}

const DEFAULT_VALUES: FormValues = {
  triage_classification: 'prompt_change',
  status_after: 'triaged',
  notes: '',
};

export function TriageForm({ suggestionId }: TriageFormProps): React.ReactElement {
  const [values, setValues] = React.useState<FormValues>(DEFAULT_VALUES);
  const [formError, setFormError] = React.useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const triageMutation = useMutation({
    mutationFn: (input: FormValues) =>
      triageSuggestion(suggestionId, {
        triage_classification: input.triage_classification,
        status_after: input.status_after,
        notes: input.notes.trim() || undefined,
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['suggestion-detail', suggestionId] });
      void qc.invalidateQueries({ queryKey: ['suggestions'] });
      toast({
        title: 'Suggestion triaged',
        description: `Status is now ${data.suggestion.status}.`,
      });
      // Reset for next interaction (defensive; the form is unmounted
      // when status leaves `open`).
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
    triageMutation.mutate(values);
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" data-testid="triage-form">
      <div className="space-y-1.5">
        <Label htmlFor="triage_classification">Classification</Label>
        <select
          id="triage_classification"
          value={values.triage_classification}
          onChange={(e) =>
            setValues((v) => ({
              ...v,
              triage_classification: e.target.value as SuggestionTriageClassification,
            }))
          }
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {SUGGESTION_TRIAGE_CLASSIFICATIONS.map((tc) => (
            <option key={tc} value={tc}>
              {SUGGESTION_TRIAGE_CLASSIFICATION_LABELS[tc]}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="status_after">Target status</Label>
        <select
          id="status_after"
          value={values.status_after}
          onChange={(e) =>
            setValues((v) => ({
              ...v,
              status_after: e.target.value as FormValues['status_after'],
            }))
          }
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <option value="triaged">Triaged (in review)</option>
          <option value="dismissed">Dismissed (no action)</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="triage_notes">
          Notes <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="triage_notes"
          value={values.notes}
          onChange={(e) => setValues((v) => ({ ...v, notes: e.target.value }))}
          placeholder="Why this classification?"
          rows={3}
          maxLength={1000}
        />
        <p className="text-xs text-muted-foreground" data-testid="triage-notes-caveat">
          Notes are not yet persisted (P7 follow-up).
        </p>
      </div>

      {formError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="triage-form-error"
        >
          {formError}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={triageMutation.isPending}>
          {triageMutation.isPending ? 'Triaging…' : 'Triage suggestion'}
        </Button>
      </div>
    </form>
  );
}
