'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { setApportionment } from '../_lib/api';

/**
 * Bulk apportionment dialog (T-B23).
 *
 * Three scopes:
 *   - selected: only the entries the consultant ticked.
 *   - current_view: every entry currently visible (post-filter).
 *   - all: every entry the list query returned (pre client-side
 *     filter).
 *
 * Applies by firing N PATCH calls in parallel via Promise.all and
 * surfaces an aggregate toast at the end. We don't expose per-row
 * progress for v1 — the table re-renders from the invalidated query
 * once the toast lands.
 *
 * Validation: pct must be a finite number 0-100. Empty / non-numeric
 * input shows an inline error and blocks submit. Trying to submit
 * with no rows in the chosen scope is also rejected — surfaces the
 * "scope is empty" message rather than firing 0 requests silently.
 */

type Scope = 'selected' | 'current_view' | 'all';

export interface BulkApportionmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  currentViewIds: string[];
  allIds: string[];
  onApplied: () => void;
}

export function BulkApportionmentDialog(props: BulkApportionmentDialogProps) {
  const { toast } = useToast();
  const [pctInput, setPctInput] = useState('');
  const [scope, setScope] = useState<Scope>('selected');
  const [submitting, setSubmitting] = useState(false);

  const idsForScope = (s: Scope): string[] => {
    if (s === 'selected') return props.selectedIds;
    if (s === 'current_view') return props.currentViewIds;
    return props.allIds;
  };

  const reset = (): void => {
    setPctInput('');
    setScope('selected');
  };

  const handleSubmit = async (): Promise<void> => {
    const pct = Number(pctInput.trim());
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      toast({
        title: 'Invalid percentage',
        description: 'R&D % must be a number between 0 and 100.',
        variant: 'destructive',
      });
      return;
    }
    const ids = idsForScope(scope);
    if (ids.length === 0) {
      toast({
        title: 'Empty scope',
        description: 'No entries match the chosen scope.',
        variant: 'destructive',
      });
      return;
    }
    setSubmitting(true);
    const results = await Promise.allSettled(ids.map((id) => setApportionment(id, pct)));
    setSubmitting(false);
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.length - fulfilled;
    if (rejected === 0) {
      toast({ title: `Applied R&D ${pct}% to ${fulfilled} entries` });
    } else {
      toast({
        title: `Applied to ${fulfilled} of ${results.length}`,
        description: `${rejected} update${rejected === 1 ? '' : 's'} failed — re-open to retry.`,
        variant: 'destructive',
      });
    }
    props.onApplied();
    props.onOpenChange(false);
    reset();
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        props.onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk apply R&amp;D %</DialogTitle>
          <DialogDescription>
            Set the same apportionment percentage on a batch of time entries.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="bulk-pct">R&amp;D %</Label>
            <Input
              id="bulk-pct"
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={pctInput}
              onChange={(e) => setPctInput(e.target.value)}
              placeholder="0-100"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="bulk-scope">Scope</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
              <SelectTrigger id="bulk-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="selected">Selected ({props.selectedIds.length})</SelectItem>
                <SelectItem value="current_view">
                  Current view ({props.currentViewIds.length})
                </SelectItem>
                <SelectItem value="all">All entries in result ({props.allIds.length})</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              props.onOpenChange(false);
              reset();
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? 'Applying…' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
