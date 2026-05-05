'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, TrendingUp } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { postForecast, type ForecastInput } from '../_lib/api';

const OFFSETS = [1, 2, 3] as const;
const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;

const CONFIDENCE_STYLES: Record<(typeof CONFIDENCE_LEVELS)[number], string> = {
  low: 'bg-red-50 text-red-700',
  medium: 'bg-amber-50 text-amber-700',
  high: 'bg-green-50 text-green-700',
};

interface Props {
  subject: string;
  fy: string;
}

export function ForecastPanel({ subject, fy }: Props) {
  const [editingOffset, setEditingOffset] = useState<1 | 2 | 3 | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: postForecast,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['compliance', 'form-completeness', subject, fy],
      });
      setEditingOffset(null);
    },
  });

  // Parse FY label to compute offset years (e.g. FY25 → FY26, FY27, FY28)
  const fyMatch = fy.match(/\d+/);
  const baseYear = fyMatch ? parseInt(fyMatch[0], 10) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-display text-lg font-semibold">
          R&D Expenditure Forecast
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Projected R&D expenditure for the next 3 financial years. All three offsets are required
          for form submission.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {OFFSETS.map((offset) => {
            const yearLabel = baseYear ? `FY${baseYear + offset}` : `Year +${offset}`;
            const isEditing = editingOffset === offset;

            if (isEditing) {
              return (
                <ForecastOffsetForm
                  key={offset}
                  subject={subject}
                  fy={fy}
                  offset={offset}
                  yearLabel={yearLabel}
                  onSubmit={(input) => mutation.mutate(input)}
                  onCancel={() => setEditingOffset(null)}
                  isPending={mutation.isPending}
                  error={mutation.error}
                />
              );
            }

            return (
              <div
                key={offset}
                className="rounded-md border border-dashed p-4 text-center space-y-2"
              >
                <p className="text-sm font-medium">{yearLabel}</p>
                <p className="text-xs text-muted-foreground">No forecast entered</p>
                <Button variant="outline" size="sm" onClick={() => setEditingOffset(offset)}>
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ForecastOffsetForm({
  subject,
  fy,
  offset,
  yearLabel,
  onSubmit,
  onCancel,
  isPending,
  error,
}: {
  subject: string;
  fy: string;
  offset: 1 | 2 | 3;
  yearLabel: string;
  onSubmit: (input: ForecastInput) => void;
  onCancel: () => void;
  isPending: boolean;
  error: Error | null;
}) {
  const [spend, setSpend] = useState('');
  const [headcount, setHeadcount] = useState('');
  const [confidence, setConfidence] = useState<ForecastInput['confidence']>('medium');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const spendVal = parseFloat(spend);
    const headcountVal = parseInt(headcount, 10);
    if (isNaN(spendVal) || isNaN(headcountVal)) return;

    onSubmit({
      subject_tenant_id: subject,
      base_fy_label: fy,
      forecast_year_offset: offset,
      projected_spend_aud: spendVal,
      projected_headcount: headcountVal,
      confidence,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-md border p-4 space-y-3 bg-muted/30">
      <p className="text-sm font-medium flex items-center gap-1.5">
        <TrendingUp className="h-4 w-4 text-muted-foreground" />
        {yearLabel}
      </p>

      <div className="space-y-1">
        <Label htmlFor={`fc-spend-${offset}`}>Projected Spend (AUD)</Label>
        <Input
          id={`fc-spend-${offset}`}
          type="number"
          min="0"
          step="0.01"
          value={spend}
          onChange={(e) => setSpend(e.target.value)}
          placeholder="0.00"
          required
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor={`fc-hc-${offset}`}>Projected Headcount</Label>
        <Input
          id={`fc-hc-${offset}`}
          type="number"
          min="0"
          step="1"
          value={headcount}
          onChange={(e) => setHeadcount(e.target.value)}
          placeholder="0"
          required
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor={`fc-conf-${offset}`}>Confidence</Label>
        <Select value={confidence} onValueChange={(v) => setConfidence(v as typeof confidence)}>
          <SelectTrigger id={`fc-conf-${offset}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONFIDENCE_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                <span className={cn('rounded-full px-2 py-0.5 text-xs', CONFIDENCE_STYLES[level])}>
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <p className="text-sm text-red-700">
          {error instanceof Error ? error.message : 'Failed to save'}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
