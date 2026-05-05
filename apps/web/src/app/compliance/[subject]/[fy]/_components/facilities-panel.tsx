'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { postFacility, type FacilityInput } from '../_lib/api';

interface Props {
  subject: string;
  fy: string;
}

export function FacilitiesPanel({ subject, fy }: Props) {
  const [showForm, setShowForm] = useState(false);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: postFacility,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['compliance', 'form-completeness', subject, fy],
      });
      setShowForm(false);
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="font-display text-lg font-semibold">R&D Facilities</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setShowForm(!showForm)}>
            <Plus className="h-4 w-4" />
            Add Facility
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Register facilities where R&D activities are conducted. At least one facility is required
          for form submission.
        </p>

        {showForm && (
          <AddFacilityForm
            subject={subject}
            fy={fy}
            onSubmit={(input) => mutation.mutate(input)}
            onCancel={() => setShowForm(false)}
            isPending={mutation.isPending}
            error={mutation.error}
          />
        )}
      </CardContent>
    </Card>
  );
}

function AddFacilityForm({
  subject,
  fy,
  onSubmit,
  onCancel,
  isPending,
  error,
}: {
  subject: string;
  fy: string;
  onSubmit: (input: FacilityInput) => void;
  onCancel: () => void;
  isPending: boolean;
  error: Error | null;
}) {
  const [facilityName, setFacilityName] = useState('');
  const [address, setAddress] = useState('');
  const [isOwned, setIsOwned] = useState(false);
  const [activityIds, setActivityIds] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!facilityName.trim() || !address.trim()) return;

    const ids = activityIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    onSubmit({
      subject_tenant_id: subject,
      fy_label: fy,
      facility_name: facilityName.trim(),
      address: address.trim(),
      is_owned: isOwned,
      used_for_activity_ids: ids,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-md border p-4 space-y-3 bg-muted/30">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="fac-name">Facility Name</Label>
          <Input
            id="fac-name"
            value={facilityName}
            onChange={(e) => setFacilityName(e.target.value)}
            placeholder="e.g. Head Office Lab"
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="fac-address">Address</Label>
          <Input
            id="fac-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Full street address"
            required
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="fac-activities">Linked Activity IDs (comma-separated, optional)</Label>
        <Input
          id="fac-activities"
          value={activityIds}
          onChange={(e) => setActivityIds(e.target.value)}
          placeholder="UUID, UUID, …"
          className="font-mono text-xs"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isOwned}
          onChange={(e) => setIsOwned(e.target.checked)}
          className="rounded border-input"
        />
        <Building2 className="h-4 w-4 text-muted-foreground" />
        Facility is owned (not leased)
      </label>

      {error && (
        <p className="text-sm text-red-700">
          {error instanceof Error ? error.message : 'Failed to save'}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? 'Saving…' : 'Save Facility'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
