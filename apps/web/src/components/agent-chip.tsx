'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Design system signature component — AgentChip.
 *
 * Distinguishes agent contributions from consultant authorship inline.
 * Renders next to narrative segments authored by an LLM agent so the
 * audit trail shows attribution + version pin without ambiguity.
 *
 * Format: "Drafted by <agentName> · <versionPin>"
 *   Example: "Drafted by Agent C · draft-narrative@1.1.0"
 *
 * Visual:  text label, patina border, monospace version pin
 * Sizes:   md only (no dense variant; this should always be readable)
 * States:  default | clickable (onClick provided)
 * Tooltip: hover reveals model name + prompt module path (when supplied)
 *
 * See docs/design/system.md §"Agent-attribution chip".
 */

export interface AgentChipProps {
  /** Display name of the agent (e.g. "Agent C", "Drafter"). */
  agentName: string;
  /** Version pin (e.g. "v1.1.0" or "draft-narrative@1.1.0"). */
  versionPin: string;
  /** Underlying model identifier for hover tooltip (e.g. "claude-opus-4-7"). */
  modelName?: string;
  /** Repo-relative path to the prompt module file for hover tooltip. */
  promptModulePath?: string;
  className?: string;
  onClick?: () => void;
}

// ---------- Pure helpers ----------

export function formatAgentLabel(opts: { agentName: string; versionPin: string }): string {
  if (!opts.agentName) {
    throw new Error('formatAgentLabel: agentName is required (no anonymous agent attributions)');
  }
  if (!opts.versionPin) {
    throw new Error(
      'formatAgentLabel: versionPin is required (every agent contribution must be reproducible)',
    );
  }
  return `Drafted by ${opts.agentName} · ${opts.versionPin}`;
}

// ---------- Component ----------

export function AgentChip({
  agentName,
  versionPin,
  modelName,
  promptModulePath,
  className,
  onClick,
}: AgentChipProps) {
  const label = formatAgentLabel({ agentName, versionPin });

  // Tooltip text — appears on title attribute hover. Shows model + prompt
  // module path when provided. Browsers handle native title delays; this
  // is intentionally a passive disclosure (no Radix popover) because the
  // tooltip data is not interactive.
  const tooltipParts = [
    modelName && `model: ${modelName}`,
    promptModulePath && `path: ${promptModulePath}`,
  ].filter(Boolean);
  const title = tooltipParts.length > 0 ? tooltipParts.join('\n') : undefined;

  const baseClasses = cn(
    'inline-flex items-center gap-1.5 rounded-full text-sm px-2.5 py-1',
    // body text + mono version pin: the version segment is wrapped in a
    // <span> below with font-mono, while the prefix uses font-body.
    'font-body border border-[hsl(var(--brand-accent))] bg-[hsl(var(--brand-accent-subtle))] text-[hsl(var(--brand-accent-strong))]',
    onClick &&
      'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--brand-accent))] focus-visible:ring-offset-2 hover:bg-[hsl(var(--brand-accent-subtle))]',
    className,
  );

  // Render the prefix in body font and the version pin in mono — visually
  // distinguishes the human-readable prefix from the machine-readable pin.
  const prefix = `Drafted by ${agentName} · `;

  if (onClick) {
    return (
      <button
        type="button"
        className={baseClasses}
        onClick={onClick}
        title={title}
        aria-label={label}
      >
        <span aria-hidden="true">{prefix}</span>
        <span aria-hidden="true" className="font-mono tabular-nums">
          {versionPin}
        </span>
      </button>
    );
  }

  return (
    <span className={baseClasses} title={title} aria-label={label}>
      <span aria-hidden="true">{prefix}</span>
      <span aria-hidden="true" className="font-mono tabular-nums">
        {versionPin}
      </span>
    </span>
  );
}
