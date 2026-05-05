'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { ApiError } from '@/lib/api';
import { flagSuggestion } from '@/app/suggestions/_lib/api';
import {
  ISSUE_SUMMARY_MAX,
  ISSUE_SUMMARY_MIN,
  parseSourcePayload,
  validateIssueSummary,
} from '@/app/suggestions/_lib/helpers';
import {
  SUGGESTION_SOURCE_KINDS,
  SUGGESTION_SOURCE_KIND_LABELS,
  type SuggestionSourceKind,
} from '@/app/suggestions/_lib/types';

/**
 * P7 Theme B Task B.7 — flag-suggestion modal.
 *
 * Wraps a child trigger element (typically a Button or an inline link)
 * in a shadcn Dialog primitive. On submit:
 *   1. Validates issue_summary length (10–1000) client-side, mirroring
 *      the API's Zod constraint so we don't burn a 400 round-trip on
 *      obvious mistakes.
 *   2. Parses source_payload as JSON; rejects with an inline error if
 *      the input isn't a JSON object.
 *   3. POSTs to /v1/suggestions; on success, invalidates the
 *      'suggestions' list query and navigates the user to the new
 *      detail page.
 *
 * Modal dialog primitive: shadcn `Dialog` wrapping radix-ui — same
 * primitive used by `MultiCycleTimeline` for the segment drawer. The
 * design system spec calls for `rounded-lg` (12px) on dialogs, which
 * is the default `sm:rounded-lg` in our DialogContent. Hairline border
 * resolves to `--border`.
 */

export interface FlagSuggestionModalProps {
  /**
   * Pre-fill values for the form. Useful when the modal is opened from
   * a context like a narrative draft viewer where the affected module /
   * section is already known.
   */
  initialValues?: Partial<FlagSuggestionFormValues>;
  /**
   * Trigger element. Wrapped in DialogTrigger via `asChild` so the
   * caller can pass a Button, link, or inline element with `data-...`
   * attributes preserved.
   */
  children: React.ReactNode;
  /**
   * Callback fired after a successful submission, before navigation.
   * Caller can use this to toast / refresh additional surfaces.
   */
  onSuccess?: (newSuggestionId: string) => void;
  /**
   * If `true`, skip the navigation-to-detail-page after successful
   * submit. Useful when the caller has its own follow-up flow.
   */
  navigateToDetailOnSuccess?: boolean;
}

interface FlagSuggestionFormValues {
  source_kind: SuggestionSourceKind;
  source_payload: string; // raw JSON text from the textarea
  affected_prompt_module: string;
  affected_section_kind: string;
  issue_summary: string;
}

const DEFAULT_FORM_VALUES: FlagSuggestionFormValues = {
  source_kind: 'consultant_flag',
  source_payload: '',
  affected_prompt_module: '',
  affected_section_kind: '',
  issue_summary: '',
};

export function FlagSuggestionModal({
  initialValues,
  children,
  onSuccess,
  navigateToDetailOnSuccess = true,
}: FlagSuggestionModalProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [values, setValues] = React.useState<FlagSuggestionFormValues>({
    ...DEFAULT_FORM_VALUES,
    ...initialValues,
  });
  const [formError, setFormError] = React.useState<string | null>(null);

  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();

  // Reset values when the modal opens — caller may have changed
  // initialValues since last open.
  React.useEffect(() => {
    if (open) {
      setValues({ ...DEFAULT_FORM_VALUES, ...initialValues });
      setFormError(null);
    }
  }, [open, initialValues]);

  const flagMutation = useMutation({
    mutationFn: (body: Parameters<typeof flagSuggestion>[0]) => flagSuggestion(body),
    onSuccess: (data) => {
      // Invalidate the queue list so the new row appears on next render.
      void qc.invalidateQueries({ queryKey: ['suggestions'] });
      toast({
        title: 'Suggestion flagged',
        description: `New suggestion ${data.suggestion.id.slice(0, 8)} added to the queue.`,
      });
      onSuccess?.(data.suggestion.id);
      setOpen(false);
      if (navigateToDetailOnSuccess) {
        router.push(`/suggestions/${data.suggestion.id}`);
      }
    },
    onError: (err) => {
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

    // 1. Validate issue_summary
    const summaryCheck = validateIssueSummary(values.issue_summary);
    if (!summaryCheck.valid) {
      setFormError(summaryCheck.error ?? 'Invalid issue summary');
      return;
    }

    // 2. Parse source_payload
    let payload: Record<string, unknown>;
    try {
      payload = parseSourcePayload(values.source_payload);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Invalid source_payload');
      return;
    }

    // 3. Submit
    flagMutation.mutate({
      source_kind: values.source_kind,
      source_payload: payload,
      affected_prompt_module: values.affected_prompt_module.trim() || undefined,
      affected_section_kind: values.affected_section_kind.trim() || undefined,
      issue_summary: values.issue_summary.trim(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg" data-testid="flag-suggestion-modal">
        <DialogHeader>
          <DialogTitle className="font-display">Flag a prompt suggestion</DialogTitle>
          <DialogDescription>
            Capture an issue with an agent output. Reviewers will triage and decide whether to
            generate a PR.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" data-testid="flag-suggestion-form">
          <div className="space-y-1.5">
            <Label htmlFor="source_kind">Source</Label>
            <select
              id="source_kind"
              value={values.source_kind}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  source_kind: e.target.value as SuggestionSourceKind,
                }))
              }
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {SUGGESTION_SOURCE_KINDS.map((sk) => (
                <option key={sk} value={sk}>
                  {SUGGESTION_SOURCE_KIND_LABELS[sk]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="affected_prompt_module">
              Affected prompt module <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="affected_prompt_module"
              type="text"
              value={values.affected_prompt_module}
              onChange={(e) => setValues((v) => ({ ...v, affected_prompt_module: e.target.value }))}
              placeholder="narrative-drafter@1.0.0"
              maxLength={200}
              className="font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="affected_section_kind">
              Affected section kind <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="affected_section_kind"
              type="text"
              value={values.affected_section_kind}
              onChange={(e) => setValues((v) => ({ ...v, affected_section_kind: e.target.value }))}
              placeholder="hypothesis"
              maxLength={100}
              className="font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="issue_summary">
              Issue summary <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="issue_summary"
              value={values.issue_summary}
              onChange={(e) => setValues((v) => ({ ...v, issue_summary: e.target.value }))}
              placeholder="Briefly describe what's wrong with the agent output…"
              minLength={ISSUE_SUMMARY_MIN}
              maxLength={ISSUE_SUMMARY_MAX}
              required
              rows={4}
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground tabular-nums">
              {values.issue_summary.trim().length}/{ISSUE_SUMMARY_MAX}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="source_payload">
              Source payload <span className="text-muted-foreground">(JSON, optional)</span>
            </Label>
            <Textarea
              id="source_payload"
              value={values.source_payload}
              onChange={(e) => setValues((v) => ({ ...v, source_payload: e.target.value }))}
              placeholder='{"reason": "Hypothesis section keeps repeating the same claim"}'
              rows={3}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Free-form JSON object. Empty input is treated as{' '}
              <span className="font-mono">{'{}'}</span>.
            </p>
          </div>

          {formError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              data-testid="flag-suggestion-form-error"
            >
              {formError}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={flagMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={flagMutation.isPending}>
              {flagMutation.isPending ? 'Submitting…' : 'Flag suggestion'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
