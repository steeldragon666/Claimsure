'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { postKnowledgeSearch, type KnowledgeSearchInput } from '../_lib/api';

interface Props {
  subject: string;
  fy: string;
}

export function KnowledgeSearchPanel({ subject, fy }: Props) {
  const [showForm, setShowForm] = useState(false);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: postKnowledgeSearch,
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
          <CardTitle className="font-display text-lg font-semibold">
            Knowledge Search Records
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => setShowForm(!showForm)}>
            <Plus className="h-4 w-4" />
            Add Record
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Document prior-art searches performed for each R&D activity. Each activity must have at
          least one search record to satisfy ATO form requirements.
        </p>

        {showForm && (
          <AddSearchForm
            subject={subject}
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

function AddSearchForm({
  subject,
  onSubmit,
  onCancel,
  isPending,
  error,
}: {
  subject: string;
  onSubmit: (input: KnowledgeSearchInput) => void;
  onCancel: () => void;
  isPending: boolean;
  error: Error | null;
}) {
  const [activityId, setActivityId] = useState('');
  const [searchDate, setSearchDate] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sources, setSources] = useState('');
  const [findingSummary, setFindingSummary] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activityId.trim() || !searchDate || !searchQuery.trim() || !findingSummary.trim()) return;

    const sourcesArray = sources
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    onSubmit({
      subject_tenant_id: subject,
      activity_id: activityId.trim(),
      search_date: searchDate,
      search_query: searchQuery.trim(),
      sources_consulted: sourcesArray.length > 0 ? sourcesArray : ['general'],
      finding_summary: findingSummary.trim(),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-md border p-4 space-y-3 bg-muted/30">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="ks-activity">Activity ID</Label>
          <Input
            id="ks-activity"
            value={activityId}
            onChange={(e) => setActivityId(e.target.value)}
            placeholder="UUID of the activity"
            className="font-mono text-xs"
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ks-date">Search Date</Label>
          <Input
            id="ks-date"
            type="date"
            value={searchDate}
            onChange={(e) => setSearchDate(e.target.value)}
            required
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="ks-query">Search Query</Label>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            id="ks-query"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="What was searched for?"
            className="pl-9"
            required
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="ks-sources">Sources Consulted (comma-separated)</Label>
        <Input
          id="ks-sources"
          value={sources}
          onChange={(e) => setSources(e.target.value)}
          placeholder="e.g. Google Scholar, IEEE Xplore, patent databases"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="ks-summary">Finding Summary</Label>
        <Textarea
          id="ks-summary"
          value={findingSummary}
          onChange={(e) => setFindingSummary(e.target.value)}
          placeholder="Summary of what was found (or not found)"
          rows={3}
          required
        />
      </div>

      {error && (
        <p className="text-sm text-red-700">
          {error instanceof Error ? error.message : 'Failed to save'}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? 'Saving…' : 'Save Record'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
