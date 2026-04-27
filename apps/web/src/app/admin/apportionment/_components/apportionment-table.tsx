'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SubjectTenant, TimeEntry } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { apiFetch } from '@/lib/api';
import { clearFlag, listTimeEntries, setApportionment } from '../_lib/api';
import { BulkApportionmentDialog } from './bulk-apportionment-dialog';

/**
 * Apportionment workbench table (T-B23).
 *
 * Layout:
 *   - Filter strip: claimant select, employee filter (text), from/to
 *     date range, "show flagged only" toggle.
 *   - Summary strip: total entries, flagged count, "Bulk apply R&D %"
 *     button (opens the bulk dialog).
 *   - Table rows: started_at, duration, source badge, current pct
 *     (inline edit), flagged badge + "Clear flag" button when set.
 *
 * Data fetching: keyed on the filter tuple so changing any filter
 * triggers a refetch. include_flagged is hard-coded to true here so
 * the workbench surfaces the rows that need attention; the
 * "show flagged only" toggle filters client-side rather than pushing
 * include_flagged=false (we want to see the unflagged context too).
 *
 * Inline pct edit uses a controlled `editingPct` map keyed by entry
 * id. Submit on blur or Enter; the mutation invalidates the list
 * query on success so React Query re-fetches.
 *
 * Checkbox column drives bulk-select. The bulk dialog reads the
 * current selection + the unfiltered list so the consultant can
 * pick "selected", "current view", or "all" as the scope.
 */

type Filters = {
  subject_tenant_id: string;
  employee_id: string;
  from: string;
  to: string;
  show_flagged_only: boolean;
};

const sourceBadgeClass = (source: TimeEntry['source']): string => {
  if (source === 'manual') return 'bg-blue-100 text-blue-800';
  return 'bg-slate-100 text-slate-700';
};

const fmtDuration = (mins: number): string => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
};

export function ApportionmentTable() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filters, setFilters] = useState<Filters>({
    subject_tenant_id: '',
    employee_id: '',
    from: '',
    to: '',
    show_flagged_only: false,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingPct, setEditingPct] = useState<Record<string, string>>({});
  const [bulkOpen, setBulkOpen] = useState(false);

  // Claimants dropdown — re-uses the existing /v1/subject-tenants
  // endpoint so we don't need a new one. Loaded once at mount.
  const claimants = useQuery<SubjectTenant[]>({
    queryKey: ['subject-tenants'],
    queryFn: async () => {
      const body = await apiFetch<{ subject_tenants: SubjectTenant[] }>('/v1/subject-tenants');
      return body.subject_tenants;
    },
  });

  const entriesKey = [
    'time-entries',
    filters.subject_tenant_id,
    filters.employee_id,
    filters.from,
    filters.to,
  ] as const;

  const entries = useQuery<TimeEntry[]>({
    queryKey: entriesKey,
    enabled: filters.subject_tenant_id !== '',
    queryFn: () =>
      listTimeEntries({
        subject_tenant_id: filters.subject_tenant_id,
        employee_id: filters.employee_id || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        include_flagged: true,
      }),
  });

  const visibleEntries = useMemo<TimeEntry[]>(() => {
    if (!entries.data) return [];
    return filters.show_flagged_only
      ? entries.data.filter((e) => e.flagged_at !== null)
      : entries.data;
  }, [entries.data, filters.show_flagged_only]);

  const setPctMutation = useMutation({
    mutationFn: ({ id, pct }: { id: string; pct: number }) => setApportionment(id, pct),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: entriesKey });
      toast({ title: 'Apportionment saved' });
    },
    onError: (err) => {
      toast({
        title: 'Failed to save apportionment',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const clearFlagMutation = useMutation({
    mutationFn: (id: string) => clearFlag(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: entriesKey });
      toast({ title: 'Flag cleared' });
    },
    onError: (err) => {
      toast({
        title: 'Failed to clear flag',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const submitPct = (entry: TimeEntry): void => {
    const raw = editingPct[entry.id];
    if (raw === undefined) return;
    const trimmed = raw.trim();
    if (trimmed === '') {
      // Empty = revert to current value, drop the edit buffer.
      setEditingPct((prev) => {
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
      return;
    }
    const pct = Number(trimmed);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      toast({
        title: 'Invalid percentage',
        description: 'Apportionment must be between 0 and 100.',
        variant: 'destructive',
      });
      return;
    }
    setPctMutation.mutate({ id: entry.id, pct });
    setEditingPct((prev) => {
      const next = { ...prev };
      delete next[entry.id];
      return next;
    });
  };

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (): void => {
    setSelected((prev) =>
      prev.size === visibleEntries.length ? new Set() : new Set(visibleEntries.map((e) => e.id)),
    );
  };

  const flaggedCount = entries.data?.filter((e) => e.flagged_at !== null).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end border rounded-md p-4">
        <div className="md:col-span-2">
          <Label htmlFor="claimant">Claimant</Label>
          <Select
            value={filters.subject_tenant_id}
            onValueChange={(v) => setFilters((prev) => ({ ...prev, subject_tenant_id: v }))}
          >
            <SelectTrigger id="claimant">
              <SelectValue placeholder="Select a claimant" />
            </SelectTrigger>
            <SelectContent>
              {claimants.data?.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="from">From</Label>
          <Input
            id="from"
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value }))}
          />
        </div>
        <div>
          <Label htmlFor="to">To</Label>
          <Input
            id="to"
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value }))}
          />
        </div>
        <div>
          <Label htmlFor="employee">Employee id</Label>
          <Input
            id="employee"
            placeholder="(optional UUID)"
            value={filters.employee_id}
            onChange={(e) => setFilters((prev) => ({ ...prev, employee_id: e.target.value }))}
          />
        </div>
        <div className="md:col-span-5">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filters.show_flagged_only}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  show_flagged_only: e.target.checked,
                }))
              }
            />
            Show flagged entries only
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {entries.isPending && filters.subject_tenant_id !== ''
            ? 'Loading…'
            : `${visibleEntries.length} entries shown · ${flaggedCount} flagged · ${selected.size} selected`}
        </div>
        <Button onClick={() => setBulkOpen(true)} disabled={visibleEntries.length === 0}>
          Bulk apply R&amp;D %
        </Button>
      </div>

      {filters.subject_tenant_id === '' ? (
        <div className="rounded-md border border-slate-200 p-8 text-center text-slate-500">
          Select a claimant to begin.
        </div>
      ) : entries.error ? (
        <div className="rounded-md border border-red-200 p-4 text-red-600">
          Failed to load entries:{' '}
          {entries.error instanceof Error ? entries.error.message : 'Unknown error'}
        </div>
      ) : visibleEntries.length === 0 ? (
        <div className="rounded-md border border-slate-200 p-8 text-center text-slate-500">
          No entries in this view.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  checked={visibleEntries.length > 0 && selected.size === visibleEntries.length}
                  onChange={toggleSelectAll}
                />
              </TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>R&amp;D %</TableHead>
              <TableHead>Flag</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleEntries.map((e) => {
              const editing = editingPct[e.id];
              const displayPct =
                editing !== undefined
                  ? editing
                  : e.apportionment_pct === null
                    ? ''
                    : String(e.apportionment_pct);
              return (
                <TableRow key={e.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selected.has(e.id)}
                      onChange={() => toggleSelect(e.id)}
                    />
                  </TableCell>
                  <TableCell className="text-xs">
                    {new Date(e.started_at).toLocaleString()}
                  </TableCell>
                  <TableCell>{fmtDuration(e.duration_minutes)}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-xs ${sourceBadgeClass(
                        e.source,
                      )}`}
                    >
                      {e.source}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      className="h-8 w-24"
                      value={displayPct}
                      onChange={(ev) =>
                        setEditingPct((prev) => ({
                          ...prev,
                          [e.id]: ev.target.value,
                        }))
                      }
                      onBlur={() => submitPct(e)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') {
                          ev.preventDefault();
                          submitPct(e);
                        }
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    {e.flagged_at ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => clearFlagMutation.mutate(e.id)}
                        disabled={clearFlagMutation.isPending}
                      >
                        Clear flag
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <BulkApportionmentDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        selectedIds={Array.from(selected)}
        currentViewIds={visibleEntries.map((e) => e.id)}
        allIds={entries.data?.map((e) => e.id) ?? []}
        onApplied={() => {
          void qc.invalidateQueries({ queryKey: entriesKey });
          setSelected(new Set());
        }}
      />
    </div>
  );
}
