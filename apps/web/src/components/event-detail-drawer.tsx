'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * P7 Theme C Task C.5 — Event detail drawer component.
 *
 * Slide-out panel showing full event details when a timeline row is clicked.
 * Renders:
 *   - Event kind badge
 *   - Captured at + received at timestamps
 *   - Chain hash + prev_hash
 *   - Full JSON payload (formatted)
 *   - Classification (if present)
 */

export interface EventDetail {
  id: string;
  kind: string;
  payload: unknown;
  classification?: unknown;
  captured_at: string;
  received_at?: string;
  hash?: string;
  prev_hash?: string | null;
  chain_position?: number;
  chain_verified?: boolean;
}

export function EventDetailDrawer({
  event,
  open,
  onClose,
}: {
  event: EventDetail | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!open || !event) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      data-testid="event-detail-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Event details"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Drawer panel */}
      <div className="relative w-full max-w-md bg-card border-l border-border p-6 overflow-y-auto shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Event Detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg"
            aria-label="Close drawer"
          >
            ✕
          </button>
        </div>

        <dl className="space-y-3 text-sm">
          {/* Kind badge */}
          <div>
            <dt className="text-muted-foreground text-xs">Kind</dt>
            <dd className="font-mono mt-0.5">{event.kind}</dd>
          </div>

          {/* Timestamps */}
          <div>
            <dt className="text-muted-foreground text-xs">Captured at</dt>
            <dd className="mt-0.5">{new Date(event.captured_at).toLocaleString()}</dd>
          </div>
          {event.received_at && (
            <div>
              <dt className="text-muted-foreground text-xs">Received at</dt>
              <dd className="mt-0.5">{new Date(event.received_at).toLocaleString()}</dd>
            </div>
          )}

          {/* Chain info */}
          {event.hash && (
            <div>
              <dt className="text-muted-foreground text-xs">Hash</dt>
              <dd className="font-mono text-xs mt-0.5 break-all">{event.hash}</dd>
            </div>
          )}
          {event.prev_hash !== undefined && (
            <div>
              <dt className="text-muted-foreground text-xs">Previous hash</dt>
              <dd className="font-mono text-xs mt-0.5 break-all">
                {event.prev_hash ?? '(genesis)'}
              </dd>
            </div>
          )}
          {event.chain_position != null && (
            <div>
              <dt className="text-muted-foreground text-xs">Chain position</dt>
              <dd className="mt-0.5">#{String(event.chain_position)}</dd>
            </div>
          )}
          {event.chain_verified !== undefined && (
            <div>
              <dt className="text-muted-foreground text-xs">Chain verified</dt>
              <dd
                className={cn('mt-0.5', event.chain_verified ? 'text-green-600' : 'text-red-600')}
              >
                {event.chain_verified ? '✓ Verified' : '✗ Broken'}
              </dd>
            </div>
          )}

          {/* Payload */}
          <div>
            <dt className="text-muted-foreground text-xs">Payload</dt>
            <dd className="mt-1">
              <pre className="rounded bg-muted p-2 text-xs overflow-x-auto max-h-64">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </dd>
          </div>

          {/* Classification */}
          {event.classification != null && (
            <div>
              <dt className="text-muted-foreground text-xs">Classification</dt>
              <dd className="mt-1">
                <pre className="rounded bg-muted p-2 text-xs overflow-x-auto max-h-32">
                  {JSON.stringify(event.classification, null, 2)}
                </pre>
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}

/**
 * Hook for managing drawer state. Usage:
 * ```tsx
 * const drawer = useEventDrawer();
 * <button onClick={() => drawer.open(event)}>View</button>
 * <EventDetailDrawer {...drawer.props} />
 * ```
 */
export function useEventDrawer() {
  const [state, setState] = useState<{ event: EventDetail | null; open: boolean }>({
    event: null,
    open: false,
  });

  return {
    open: (event: EventDetail) => setState({ event, open: true }),
    close: () => setState({ event: null, open: false }),
    props: {
      event: state.event,
      open: state.open,
      onClose: () => setState({ event: null, open: false }),
    },
  };
}
