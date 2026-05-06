'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  getBeneficialOwnership,
  postBeneficialOwnership,
  type BeneficialOwnershipInput,
} from '../_lib/api';

const OWNER_KINDS = ['individual', 'entity', 'foreign_entity', 'associate'] as const;

const OWNER_KIND_LABELS: Record<(typeof OWNER_KINDS)[number], string> = {
  individual: 'Individual',
  entity: 'Entity',
  foreign_entity: 'Foreign Entity',
  associate: 'Associate',
};

interface Props {
  subject: string;
  fy: string;
}

export function BeneficialOwnershipPanel({ subject, fy }: Props) {
  const [showForm, setShowForm] = useState(false);
  const queryClient = useQueryClient();

  const { data, isPending, error } = useQuery({
    queryKey: ['compliance', 'beneficial-ownership', subject, fy],
    queryFn: () => getBeneficialOwnership(subject, fy),
  });

  const mutation = useMutation({
    mutationFn: postBeneficialOwnership,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['compliance', 'beneficial-ownership', subject, fy],
      });
      void queryClient.invalidateQueries({
        queryKey: ['compliance', 'form-completeness', subject, fy],
      });
      setShowForm(false);
    },
  });

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="font-display text-lg font-semibold">Beneficial Ownership</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setShowForm(!showForm)}>
            <Plus className="h-4 w-4" />
            Add Owner
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {showForm && (
          <AddOwnerForm
            subject={subject}
            fy={fy}
            onSubmit={(input) => mutation.mutate(input)}
            onCancel={() => setShowForm(false)}
            isPending={mutation.isPending}
            error={mutation.error}
          />
        )}

        {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && (
          <p className="text-sm text-red-700">
            {error instanceof Error ? error.message : 'Failed to load'}
          </p>
        )}

        {!isPending && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No beneficial owners declared for {fy}.</p>
        )}

        {rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Ownership %</TableHead>
                <TableHead>Associate</TableHead>
                <TableHead>Foreign Related</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.owner_name}</TableCell>
                  <TableCell>
                    <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs">
                      {OWNER_KIND_LABELS[row.owner_kind] ?? row.owner_kind}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {row.ownership_pct}%
                  </TableCell>
                  <TableCell>{row.is_associate ? 'Yes' : 'No'}</TableCell>
                  <TableCell>{row.is_foreign_related ? 'Yes' : 'No'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function AddOwnerForm({
  subject,
  fy,
  onSubmit,
  onCancel,
  isPending,
  error,
}: {
  subject: string;
  fy: string;
  onSubmit: (input: BeneficialOwnershipInput) => void;
  onCancel: () => void;
  isPending: boolean;
  error: Error | null;
}) {
  const [ownerName, setOwnerName] = useState('');
  const [ownerKind, setOwnerKind] = useState<BeneficialOwnershipInput['owner_kind']>('individual');
  const [ownerCountry, setOwnerCountry] = useState('');
  const [ownershipPct, setOwnershipPct] = useState('');
  const [isAssociate, setIsAssociate] = useState(false);
  const [isForeignRelated, setIsForeignRelated] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const pct = parseFloat(ownershipPct);
    if (!ownerName.trim() || isNaN(pct)) return;

    onSubmit({
      subject_tenant_id: subject,
      fy_label: fy,
      owner_kind: ownerKind,
      owner_name: ownerName.trim(),
      ...(ownerCountry.trim() ? { owner_country: ownerCountry.trim() } : {}),
      ownership_pct: pct,
      is_associate: isAssociate,
      is_foreign_related: isForeignRelated,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-md border p-4 space-y-3 bg-muted/30">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="bo-name">Owner Name</Label>
          <Input
            id="bo-name"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bo-kind">Kind</Label>
          <Select value={ownerKind} onValueChange={(v) => setOwnerKind(v as typeof ownerKind)}>
            <SelectTrigger id="bo-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OWNER_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {OWNER_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="bo-country">Country (optional)</Label>
          <Input
            id="bo-country"
            value={ownerCountry}
            onChange={(e) => setOwnerCountry(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bo-pct">Ownership %</Label>
          <Input
            id="bo-pct"
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={ownershipPct}
            onChange={(e) => setOwnershipPct(e.target.value)}
            required
          />
        </div>
      </div>

      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isAssociate}
            onChange={(e) => setIsAssociate(e.target.checked)}
            className="rounded border-input"
          />
          Associate
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isForeignRelated}
            onChange={(e) => setIsForeignRelated(e.target.checked)}
            className="rounded border-input"
          />
          Foreign Related
        </label>
      </div>

      {error && (
        <p className="text-sm text-red-700">
          {error instanceof Error ? error.message : 'Failed to save'}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? 'Saving…' : 'Save Owner'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
