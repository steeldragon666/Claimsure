'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * P7 Theme C Tasks C.3 + C.5 — Narrative version diff component.
 *
 * Displays narrative draft versions sequentially with forensic metadata
 * (first_recorded_at, content_hash) visible on each version card.
 * Supports selecting two versions for side-by-side comparison.
 *
 * Generation kind badges:
 *   initial      → blue
 *   section_regen → amber
 *   manual_edit  → slate
 */

export interface NarrativeVersionEntry {
  id: string;
  version: number;
  generation_kind: string;
  content_hash: string;
  created_at: string;
  segments_text?: string;
}

/** Truncate a hex hash to 8 chars for readability. */
export function truncateVersionHash(hash: string): string {
  return hash.length > 8 ? hash.slice(0, 8) : hash;
}

const GEN_KIND_CLASSES: Record<string, string> = {
  initial: 'bg-blue-50 text-blue-700 border-blue-200',
  section_regen: 'bg-amber-50 text-amber-700 border-amber-200',
  manual_edit: 'bg-slate-50 text-slate-700 border-slate-200',
};

function genKindBadgeClass(kind: string): string {
  return GEN_KIND_CLASSES[kind] ?? 'bg-muted text-muted-foreground border-border';
}

export function NarrativeVersionDiff({ versions }: { versions: NarrativeVersionEntry[] }) {
  const [selected, setSelected] = useState<[string | null, string | null]>([null, null]);

  if (versions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="narrative-diff-empty">
        No narrative versions available.
      </p>
    );
  }

  const toggleSelect = (id: string) => {
    setSelected(([a, b]) => {
      if (a === id) return [null, b];
      if (b === id) return [a, null];
      if (!a) return [id, b];
      if (!b) return [a, id];
      return [id, b]; // replace first selection
    });
  };

  const [versionA, versionB] = [
    versions.find((v) => v.id === selected[0]),
    versions.find((v) => v.id === selected[1]),
  ];

  return (
    <div className="space-y-4" data-testid="narrative-version-diff">
      {/* Version list */}
      <div className="space-y-2">
        {versions.map((v) => {
          const isSelected = selected[0] === v.id || selected[1] === v.id;
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => toggleSelect(v.id)}
              className={cn(
                'w-full text-left rounded border px-3 py-2 text-sm transition-colors',
                isSelected
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-card hover:bg-muted/50',
              )}
              data-testid={`narrative-version-${v.version}`}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-medium">v{v.version}</span>
                <span
                  className={cn(
                    'inline-flex rounded-full border px-1.5 py-0 text-[10px] font-medium',
                    genKindBadgeClass(v.generation_kind),
                  )}
                >
                  {v.generation_kind}
                </span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {truncateVersionHash(v.content_hash)}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground" data-testid="first-recorded-at">
                First recorded: {new Date(v.created_at).toLocaleString()}
              </div>
            </button>
          );
        })}
      </div>

      {/* Side-by-side diff (when two versions selected) */}
      {versionA && versionB && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="version-comparison">
          <VersionPanel version={versionA} label="A" />
          <VersionPanel version={versionB} label="B" />
        </div>
      )}
    </div>
  );
}

function VersionPanel({ version, label }: { version: NarrativeVersionEntry; label: string }) {
  return (
    <div className="rounded border border-border p-3 space-y-2 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-muted-foreground font-medium">Version {label}</span>
        <span className="font-medium">v{version.version}</span>
        <span className="ml-auto font-mono text-xs">
          {truncateVersionHash(version.content_hash)}
        </span>
      </div>
      {version.segments_text ? (
        <pre className="whitespace-pre-wrap text-xs bg-muted rounded p-2 max-h-64 overflow-y-auto">
          {version.segments_text}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground italic">Segment text not loaded.</p>
      )}
    </div>
  );
}
