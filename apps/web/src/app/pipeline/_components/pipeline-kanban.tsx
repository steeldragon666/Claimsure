'use client';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { CLAIM_STAGES_LITERAL, type Claim, type ClaimStage } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { patchClaimStage } from '../_lib/api';
import { STAGE_LABELS } from './url-params';

/**
 * Swimlane C2: 7-column kanban for `/pipeline?view=kanban`.
 *
 * Uses HTML5 native drag-drop (no `@hello-pangea/dnd` — not in the workspace
 * deps; keeping the bundle lean, and the UX requirement here is forward-only
 * card moves which native d&d handles fine). Wired against the `_lib/api`
 * stub so it ships ahead of Swimlane A's A2 PATCH route — the stub already
 * has the correct shape, so the swap to a real fetch is a one-line change.
 *
 * Stage transitions follow the same rules as F10's `validateStageTransition`:
 *   - Forward = any role
 *   - Backward = admin only
 *   - `submitted` is terminal (no revert)
 *   - No-op (same column) is a no-op
 *
 * `validateClientStageTransition` re-implements the F10 contract on the
 * client because the web app explicitly does NOT import server types
 * (cross-network boundary, see `claim-stage-timeline.tsx`'s comment).
 *
 * Multi-select:
 *   - plain click on card  → navigate to detail
 *   - cmd/ctrl-click       → toggle card in selection
 *   - shift-click          → extend selection from anchor
 *   - click empty board    → clear selection
 *
 * Bulk actions appear in a floating toolbar when `selected.size > 0`.
 */

// --- Pure logic (kanban.test.tsx imports these directly) -------------------

export type Role = 'admin' | 'consultant' | 'viewer';

export type ClientStageTransition =
  | { ok: true; from: ClaimStage; to: ClaimStage; direction: 'forward' | 'backward' }
  | {
      ok: false;
      reason: 'invalid_target' | 'cannot_revert_from_submitted' | 'role_required' | 'no_op';
    };

/**
 * Client-side mirror of `validateStageTransition` from
 * `apps/api/src/lib/claim-stage.ts`. Used to gate UI affordances (drop
 * targets, bulk actions) before issuing the PATCH. Server still validates
 * authoritatively. Keep in sync with F10.
 */
export function validateClientStageTransition(args: {
  from: ClaimStage;
  to: ClaimStage;
  role: Role;
}): ClientStageTransition {
  const fromIdx = CLAIM_STAGES_LITERAL.indexOf(args.from);
  const toIdx = CLAIM_STAGES_LITERAL.indexOf(args.to);
  if (toIdx === -1 || fromIdx === -1) {
    return { ok: false, reason: 'invalid_target' };
  }
  if (toIdx === fromIdx) {
    return { ok: false, reason: 'no_op' };
  }
  if (args.from === 'submitted' && toIdx < fromIdx) {
    return { ok: false, reason: 'cannot_revert_from_submitted' };
  }
  const direction = toIdx > fromIdx ? 'forward' : 'backward';
  if (direction === 'backward' && args.role !== 'admin') {
    return { ok: false, reason: 'role_required' };
  }
  return { ok: true, from: args.from, to: args.to, direction };
}

/**
 * Compute the next selection set given a click on `targetId`. Pure so the
 * test suite can hammer the matrix of modifier-key combinations without
 * standing up a DOM.
 *
 *  - `mode: 'replace'` (plain click)  → {targetId} (single)
 *  - `mode: 'toggle'`  (cmd/ctrl)     → flip target in current set
 *  - `mode: 'range'`   (shift)        → extend from anchor through target,
 *                                       using `orderedIds` (the visual
 *                                       order across all columns)
 *
 * `anchor` is the last single-clicked id (or last range start). Falls
 * back to the target when no anchor is set.
 */
export function nextSelection(args: {
  current: Set<string>;
  anchor: string | null;
  targetId: string;
  orderedIds: readonly string[];
  mode: 'replace' | 'toggle' | 'range';
}): { selection: Set<string>; anchor: string | null } {
  const { current, anchor, targetId, orderedIds, mode } = args;
  if (mode === 'replace') {
    return { selection: new Set([targetId]), anchor: targetId };
  }
  if (mode === 'toggle') {
    const next = new Set(current);
    if (next.has(targetId)) next.delete(targetId);
    else next.add(targetId);
    return { selection: next, anchor: targetId };
  }
  // mode === 'range'
  const start = anchor ?? targetId;
  const startIdx = orderedIds.indexOf(start);
  const endIdx = orderedIds.indexOf(targetId);
  if (startIdx === -1 || endIdx === -1) {
    // Fallback: treat as single select if either id is missing from order.
    return { selection: new Set([targetId]), anchor: targetId };
  }
  const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
  const range = orderedIds.slice(lo, hi + 1);
  // Range select REPLACES the prior selection (matches Finder/GMail
  // convention; cmd-shift-click for additive ranges is out of scope).
  return { selection: new Set(range), anchor: start };
}

/**
 * Group claims by stage. Stages with no claims still appear (empty array)
 * so the kanban renders all 7 columns. Order within a column matches the
 * input order — caller is responsible for sort.
 */
export function groupClaimsByStage(claims: readonly Claim[]): Record<ClaimStage, Claim[]> {
  const out = {} as Record<ClaimStage, Claim[]>;
  for (const stage of CLAIM_STAGES_LITERAL) out[stage] = [];
  for (const c of claims) out[c.stage].push(c);
  return out;
}

/**
 * Format an ISO-8601 timestamp as a relative-time English phrase
 * ("3 mins ago", "2 days ago"). Pure for testability. Caps at "30+ days
 * ago" — older entries probably shouldn't be in the active pipeline anyway.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return '30+ days ago';
}

// --- Component -------------------------------------------------------------

export interface PipelineKanbanProps {
  claims: Claim[];
  /** Current viewer role; gates backward drag + revert context-menu item. */
  role: Role;
  /**
   * Optional name lookup for `subject_tenant_id → display name`. The eventual
   * `GET /v1/claims` response (A2) will likely embed claimant_name; until then
   * page.tsx can pass an empty map and the card falls back to the truncated id.
   */
  subjectTenantNames?: Record<string, string>;
  /**
   * Optional override of the API stub — primarily for tests / Storybook.
   * Defaults to the `_lib/api` stub.
   */
  patchStage?: typeof patchClaimStage;
}

interface ContextMenuState {
  cardId: string;
  fromStage: ClaimStage;
  x: number;
  y: number;
}

export function PipelineKanban({
  claims,
  role,
  subjectTenantNames,
  patchStage = patchClaimStage,
}: PipelineKanbanProps) {
  const grouped = useMemo(() => groupClaimsByStage(claims), [claims]);
  const orderedIds = useMemo(() => {
    // Visual order across columns: stage-major, then claim order within stage.
    const ids: string[] = [];
    for (const stage of CLAIM_STAGES_LITERAL) {
      for (const c of grouped[stage]) ids.push(c.id);
    }
    return ids;
  }, [grouped]);
  const claimById = useMemo(() => {
    const m = new Map<string, Claim>();
    for (const c of claims) m.set(c.id, c);
    return m;
  }, [claims]);

  // --- Selection state ---
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [busy, setBusy] = useState(false);

  // Drop the context menu on any background click + Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const onAnyClick = (): void => setContextMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', onAnyClick);
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('click', onAnyClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // --- Drag tracking (HTML5 native) ---
  const dragSourceRef = useRef<{ id: string; from: ClaimStage } | null>(null);
  const [dragOverStage, setDragOverStage] = useState<ClaimStage | null>(null);

  const onCardDragStart = useCallback(
    (e: ReactDragEvent<HTMLElement>, id: string, from: ClaimStage) => {
      // If the user starts a drag on a card that isn't selected, treat the
      // drag as single-card. If the card IS selected, the whole selection
      // moves together (bulk drag).
      dragSourceRef.current = { id, from };
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers require setData for a drag to register at all.
      e.dataTransfer.setData('text/plain', id);
    },
    [],
  );

  const onColumnDragOver = useCallback(
    (e: ReactDragEvent<HTMLElement>, to: ClaimStage) => {
      const src = dragSourceRef.current;
      if (!src) return;
      const result = validateClientStageTransition({ from: src.from, to, role });
      if (!result.ok) return;
      // Allow the drop.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOverStage(to);
    },
    [role],
  );

  const onColumnDragLeave = useCallback((to: ClaimStage) => {
    setDragOverStage((prev) => (prev === to ? null : prev));
  }, []);

  const runStageMutation = useCallback(
    async (ids: string[], to: ClaimStage): Promise<void> => {
      setBusy(true);
      try {
        // Issue PATCH per id in parallel. Server-side validation is
        // authoritative; failures here surface in console for now (a
        // proper toast lands when A2 wires real errors back).
        await Promise.all(
          ids
            .map((id) => claimById.get(id))
            .filter((c): c is Claim => Boolean(c))
            .map(async (c) => {
              const result = validateClientStageTransition({ from: c.stage, to, role });
              if (!result.ok) return;
              await patchStage({ id: c.id, toStage: to });
            }),
        );
      } finally {
        setBusy(false);
      }
    },
    [claimById, patchStage, role],
  );

  const onColumnDrop = useCallback(
    (e: ReactDragEvent<HTMLElement>, to: ClaimStage) => {
      e.preventDefault();
      const src = dragSourceRef.current;
      dragSourceRef.current = null;
      setDragOverStage(null);
      if (!src) return;
      const result = validateClientStageTransition({ from: src.from, to, role });
      if (!result.ok) return;
      // If the dragged card is in the selection, move the whole selection;
      // otherwise just the dragged card.
      const ids = selected.has(src.id) ? Array.from(selected) : [src.id];
      void runStageMutation(ids, to);
      // Clear selection on drop — the cards are now in their new column;
      // keeping them selected would confuse subsequent shift-click ranges.
      setSelected(new Set());
      setAnchor(null);
    },
    [role, runStageMutation, selected],
  );

  // --- Card click → select / navigate ---
  const onCardClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>, id: string): void => {
      // cmd/ctrl-click toggles; shift-click ranges; plain click on an
      // already-selected card with N > 1 selects single. Plain click on a
      // single-selection card navigates (Link's default).
      if (e.shiftKey) {
        e.preventDefault();
        const next = nextSelection({
          current: selected,
          anchor,
          targetId: id,
          orderedIds,
          mode: 'range',
        });
        setSelected(next.selection);
        setAnchor(next.anchor);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const next = nextSelection({
          current: selected,
          anchor,
          targetId: id,
          orderedIds,
          mode: 'toggle',
        });
        setSelected(next.selection);
        setAnchor(next.anchor);
        return;
      }
      // Plain click — Link handles navigation; clear selection so the next
      // shift-click anchors fresh.
      setSelected(new Set());
      setAnchor(id);
    },
    [anchor, orderedIds, selected],
  );

  const onBoardBackgroundClick = useCallback((e: ReactMouseEvent<HTMLDivElement>): void => {
    // Only clear if the click was on the bare board, not on a card or
    // toolbar. Cards stop propagation in their click handler? No — we
    // want the natural bubbling. Use `currentTarget === target` to detect.
    if (e.target === e.currentTarget) {
      setSelected(new Set());
      setAnchor(null);
    }
  }, []);

  // --- Context menu ---
  const onCardContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>, id: string, from: ClaimStage): void => {
      // Only admins have a useful context menu (revert). For non-admins,
      // do not preempt the browser's native menu — gives them at least the
      // "open in new tab" option on the link.
      if (role !== 'admin') return;
      e.preventDefault();
      setContextMenu({ cardId: id, fromStage: from, x: e.clientX, y: e.clientY });
    },
    [role],
  );

  const revertCard = useCallback(
    (id: string, fromStage: ClaimStage): void => {
      // Revert = move one stage backward (or to the closest valid prior
      // stage, but for V1 we keep it simple).
      const idx = CLAIM_STAGES_LITERAL.indexOf(fromStage);
      if (idx <= 0) return;
      const prev = CLAIM_STAGES_LITERAL[idx - 1];
      if (!prev) return;
      void runStageMutation([id], prev);
      setContextMenu(null);
    },
    [runStageMutation],
  );

  // --- Bulk actions ---
  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  const onBulkAdvance = useCallback((): void => {
    // Advance each selected card by exactly one stage (per-card target).
    void Promise.all(
      selectedIds.map(async (id) => {
        const c = claimById.get(id);
        if (!c) return;
        const idx = CLAIM_STAGES_LITERAL.indexOf(c.stage);
        if (idx === -1 || idx >= CLAIM_STAGES_LITERAL.length - 1) return;
        const next = CLAIM_STAGES_LITERAL[idx + 1];
        if (!next) return;
        await patchStage({ id: c.id, toStage: next });
      }),
    ).then(() => {
      setSelected(new Set());
      setAnchor(null);
    });
  }, [claimById, patchStage, selectedIds]);

  const onBulkRevert = useCallback((): void => {
    if (role !== 'admin') return;
    void Promise.all(
      selectedIds.map(async (id) => {
        const c = claimById.get(id);
        if (!c) return;
        const idx = CLAIM_STAGES_LITERAL.indexOf(c.stage);
        if (idx <= 0) return;
        const prev = CLAIM_STAGES_LITERAL[idx - 1];
        if (!prev) return;
        await patchStage({ id: c.id, toStage: prev });
      }),
    ).then(() => {
      setSelected(new Set());
      setAnchor(null);
    });
  }, [claimById, patchStage, role, selectedIds]);

  const onBulkClear = useCallback((): void => {
    setSelected(new Set());
    setAnchor(null);
  }, []);

  return (
    <div
      role="region"
      aria-label="Kanban view"
      className="flex flex-col gap-3"
      onClick={onBoardBackgroundClick}
    >
      {selected.size > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-3 rounded-md border bg-background p-3 shadow-sm"
        >
          <span className="text-sm font-medium" aria-live="polite">
            {selected.size} selected
          </span>
          <Button type="button" size="sm" variant="default" disabled={busy} onClick={onBulkAdvance}>
            Advance
          </Button>
          {role === 'admin' && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onBulkRevert}
            >
              Revert
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled
            // TODO(C2): assignee endpoint isn't defined yet — hidden affordance
            // to communicate intent; wire when bulk-assign route ships.
            title="Bulk assign — coming soon"
          >
            Assign…
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onBulkClear}>
            Clear
          </Button>
        </div>
      )}

      <div className="grid grid-flow-col gap-3 overflow-x-auto">
        {CLAIM_STAGES_LITERAL.map((stage) => {
          const items = grouped[stage];
          const isOver = dragOverStage === stage;
          return (
            <section
              key={stage}
              role="list"
              aria-label={`${STAGE_LABELS[stage]} column`}
              data-stage={stage}
              className={cn(
                'flex min-w-[15rem] flex-col rounded-md border bg-muted/30 p-2 transition-colors',
                isOver && 'border-primary bg-primary/5',
              )}
              onDragOver={(e) => onColumnDragOver(e, stage)}
              onDragLeave={() => onColumnDragLeave(stage)}
              onDrop={(e) => onColumnDrop(e, stage)}
            >
              <header className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {STAGE_LABELS[stage]}
                </h2>
                <span
                  aria-label={`${items.length} cards`}
                  className="rounded-full bg-background px-2 py-0.5 text-xs"
                >
                  {items.length}
                </span>
              </header>

              <div className="flex flex-col gap-2">
                {items.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">No claims</p>
                ) : (
                  items.map((claim) => {
                    const isSelected = selected.has(claim.id);
                    const claimantName = subjectTenantNames?.[claim.subject_tenant_id];
                    const cardLabel =
                      claimantName ?? `Claim ${claim.subject_tenant_id.slice(0, 8)}`;
                    return (
                      <div
                        key={claim.id}
                        role="listitem"
                        draggable
                        data-claim-id={claim.id}
                        aria-label={`Claim card: ${cardLabel}, FY ${claim.fiscal_year}, ${STAGE_LABELS[claim.stage]}`}
                        aria-selected={isSelected}
                        onDragStart={(e) => onCardDragStart(e, claim.id, claim.stage)}
                        onContextMenu={(e) => onCardContextMenu(e, claim.id, claim.stage)}
                        onClick={(e) => onCardClick(e, claim.id)}
                        className={cn(
                          'cursor-grab rounded-md border bg-background p-3 text-sm shadow-sm hover:border-primary/50 active:cursor-grabbing',
                          isSelected && 'ring-2 ring-primary ring-offset-1',
                        )}
                      >
                        <Link
                          href={`/claims/${claim.id}`}
                          className="block focus:outline-none"
                          // Prevent navigation when the click was a
                          // selection-modifier click; onCardClick called
                          // preventDefault on the synthetic event already.
                          onClick={(e) => {
                            if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault();
                          }}
                        >
                          <div className="font-medium">{cardLabel}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            FY {claim.fiscal_year}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Updated {formatRelativeTime(claim.updated_at)}
                          </div>
                        </Link>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>

      {contextMenu && role === 'admin' && (
        <div
          role="menu"
          aria-label="Card actions"
          // Position via inline style — values come from the synthetic event,
          // not from CSS classes, so they have to be inline.
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 50 }}
          className="min-w-[8rem] rounded-md border bg-popover p-1 shadow-md"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={
              contextMenu.fromStage === 'engagement' || contextMenu.fromStage === 'submitted'
            }
            onClick={() => revertCard(contextMenu.cardId, contextMenu.fromStage)}
            className="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-50"
          >
            Revert to previous stage
          </button>
        </div>
      )}
    </div>
  );
}
