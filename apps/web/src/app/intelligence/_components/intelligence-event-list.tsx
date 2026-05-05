'use client';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { IntelligenceEventCard } from './intelligence-event-card';

interface RegulatoryEvent {
  id: string;
  source_id: string;
  external_id: string;
  raw_title: string;
  raw_content: string;
  source_url: string | null;
  published_at: string;
  classified_at: string | null;
  classification_kind: string | null;
  classification_severity: string | null;
  source_name: string;
}

interface EventsResponse {
  events: RegulatoryEvent[];
  total: number;
}

const SEVERITY_OPTIONS = ['all', 'high', 'medium', 'low', 'informational'] as const;
const KIND_OPTIONS = [
  'all',
  'tax_alert',
  'pcg',
  'public_ruling',
  'disr_program_change',
  'form_change',
  'aat_decision',
  'art_decision',
  'isa_finding',
  'industry_guidance',
  'asx_disclosure',
  'other',
] as const;

const SEVERITY_LABELS: Record<string, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  informational: 'Info',
};

const KIND_LABELS: Record<string, string> = {
  tax_alert: 'Tax Alert',
  pcg: 'PCG',
  public_ruling: 'Public Ruling',
  disr_program_change: 'DISR Change',
  form_change: 'Form Change',
  aat_decision: 'AAT Decision',
  art_decision: 'ART Decision',
  isa_finding: 'ISA Finding',
  industry_guidance: 'Industry',
  asx_disclosure: 'ASX Disclosure',
  other: 'Other',
};

const SEVERITY_BADGE: Record<string, string> = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-amber-100 text-amber-800',
  low: 'bg-blue-100 text-blue-800',
  informational: 'bg-gray-100 text-gray-600',
};

const PAGE_SIZE = 25;

export function IntelligenceEventList() {
  const [severityFilter, setSeverityFilter] = React.useState<string>('all');
  const [kindFilter, setKindFilter] = React.useState<string>('all');
  const [page, setPage] = React.useState(0);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const params = new URLSearchParams();
  if (severityFilter !== 'all') params.set('severity', severityFilter);
  if (kindFilter !== 'all') params.set('kind', kindFilter);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(page * PAGE_SIZE));

  const { data, isLoading } = useQuery<EventsResponse>({
    queryKey: ['intelligence-events', severityFilter, kindFilter, page],
    queryFn: () => apiFetch(`/v1/intelligence/events?${params.toString()}`),
  });

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Severity:</span>
          {SEVERITY_OPTIONS.map((s) => (
            <Button
              key={s}
              variant={severityFilter === s ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setSeverityFilter(s);
                setPage(0);
              }}
            >
              {s === 'all' ? 'All' : (SEVERITY_LABELS[s] ?? s)}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Kind:</span>
          <select
            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            value={kindFilter}
            onChange={(e) => {
              setKindFilter(e.target.value);
              setPage(0);
            }}
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k === 'all' ? 'All kinds' : (KIND_LABELS[k] ?? k)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading events...</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No events found.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Published</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="w-[100px]">Source</TableHead>
                <TableHead className="w-[120px]">Kind</TableHead>
                <TableHead className="w-[80px]">Severity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((evt) => (
                <React.Fragment key={evt.id}>
                  <TableRow
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setExpandedId(expandedId === evt.id ? null : evt.id)}
                  >
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(evt.published_at).toLocaleDateString('en-AU')}
                    </TableCell>
                    <TableCell className="font-medium text-sm">
                      {evt.raw_title.length > 80
                        ? evt.raw_title.slice(0, 80) + '...'
                        : evt.raw_title}
                    </TableCell>
                    <TableCell className="text-xs">{evt.source_name}</TableCell>
                    <TableCell>
                      {evt.classification_kind && (
                        <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs">
                          {KIND_LABELS[evt.classification_kind] ?? evt.classification_kind}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {evt.classification_severity && (
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                            SEVERITY_BADGE[evt.classification_severity] ??
                            'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {SEVERITY_LABELS[evt.classification_severity] ??
                            evt.classification_severity}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                  {expandedId === evt.id && (
                    <TableRow>
                      <TableCell colSpan={5} className="p-0">
                        <IntelligenceEventCard event={evt} />
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
