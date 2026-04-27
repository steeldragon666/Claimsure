'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Event as ApiEvent, ListEventsFilter } from '@cpa/schemas';
import { listEvents } from '../../_lib/api';
import { EventCard } from './event-card';
import { OverrideModal } from './override-modal';

/**
 * Reverse-chronological feed of classified events for one claimant.
 *
 * Single-page query for now — pagination via the API's next_cursor is
 * deferred (P2 scale tops out around tens of events per claimant). Filter
 * defaults to 'all'; T25 hooks up the FilterTabs to pass alternative
 * values down.
 */
export interface EventFeedProps {
  subjectTenantId: string;
  filter?: ListEventsFilter;
  limit?: number;
}

export function EventFeed({ subjectTenantId, filter = 'all', limit = 50 }: EventFeedProps) {
  const { data, isPending, error } = useQuery({
    queryKey: ['events', subjectTenantId, filter, limit],
    queryFn: () => listEvents({ subject_tenant_id: subjectTenantId, filter, limit }),
  });

  // The override modal is shared across all cards in the feed — only
  // one can be open at a time, so we hoist its state here and pass an
  // onOverride handler to each card.
  const [overrideTarget, setOverrideTarget] = useState<ApiEvent | null>(null);

  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading events…</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-red-600">
        Failed to load events: {error instanceof Error ? error.message : 'Unknown error'}
      </p>
    );
  }
  if (data.events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No events yet. Paste a transcript above to classify.
      </p>
    );
  }
  return (
    <>
      <div className="space-y-3">
        {data.events.map((event) => (
          <EventCard key={event.id} event={event} onOverride={setOverrideTarget} />
        ))}
      </div>
      <OverrideModal
        subjectTenantId={subjectTenantId}
        event={overrideTarget}
        open={overrideTarget !== null}
        onOpenChange={(open) => {
          if (!open) setOverrideTarget(null);
        }}
      />
    </>
  );
}
