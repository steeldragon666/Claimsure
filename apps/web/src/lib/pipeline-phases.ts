/**
 * Pipeline phase registry — single source of truth for how the platform
 * describes its async agent stages to the user.
 *
 * The platform fires off 4-5 specialized AI agents per claim (extraction,
 * classification, synthesis, narrative drafting, application drafting).
 * Each stage takes seconds to minutes. Without explicit narration the user
 * sees a green upload checkmark and then... silence — "Rubik's cube" UX.
 *
 * This file is the prose layer. It maps a backend `phase` discriminator
 * (returned by `GET /v1/subject-tenants/:id/pipeline-status`) to:
 *   - a short user-facing label (banner heading)
 *   - a longer "what's happening" paragraph (under the heading)
 *   - the model that's running (transparency)
 *   - the per-item cost estimate (for ETA math)
 *   - a "why this takes time" compliance explanation (expandable)
 *
 * To refine the copy, edit this file. No other source has the strings.
 */

export type PipelinePhase =
  | 'idle'
  | 'extracting'
  | 'extraction_complete'
  | 'narrative_pending'
  | 'narrative_approved'
  | 'generating_application';

export interface PhaseDescriptor {
  phase: PipelinePhase;
  /** Banner heading. Shown in display serif. ~6-8 words. */
  label: string;
  /** Paragraph under the heading. 1-3 sentences. Plain English + model name. */
  description: string;
  /** Anthropic model being used (or "n/a" for idle/manual phases). */
  model: string;
  /** Average wall-clock seconds per processed item. Used for ETA math. */
  secondsPerItem: number;
  /** Statutory framing — why this phase exists for compliance. */
  whyThisTakesTime: string;
}

export const PHASES: Record<PipelinePhase, PhaseDescriptor> = {
  idle: {
    phase: 'idle',
    label: 'Ready for evidence',
    description:
      'Drop documents (DOCX, PDF, XLSX), photos, or voice notes into the upload area. The pipeline will start automatically.',
    model: 'n/a',
    secondsPerItem: 0,
    whyThisTakesTime: '',
  },

  extracting: {
    phase: 'extracting',
    label: 'Analyzing your evidence',
    description:
      'Claude Haiku is reading each document and (a) extracting the text, (b) classifying it into Division 355 R&D event kinds — DESIGN, OBSERVATION, NEW_KNOWLEDGE, ITERATION, UNCERTAINTY, TIME_LOG, EXPENDITURE_NOTE, SUPPORTING — and (c) proposing R&D activities the document evidences, with hypothesis text, technical uncertainty statements, and source excerpts.',
    model: 'claude-haiku-4-5',
    secondsPerItem: 3.5,
    whyThisTakesTime:
      'Every document goes through a structured tool-use call that returns proposed activities, proposed invoice records, a document summary, and a statutory anchor (§355-25 or §355-30). We use Haiku for this stage because it is fast enough to handle batches of 20+ documents in under a minute, but rigorous enough to produce reasoning that holds up under AusIndustry review. Skipping this stage would force you to manually classify every piece of evidence.',
  },

  extraction_complete: {
    phase: 'extraction_complete',
    label: 'Evidence analyzed — drafting your narrative',
    description:
      'All evidence is classified. Claude Sonnet is now synthesizing the classifications across all documents into a coherent narrative draft with proposed R&D activities (core + supporting). This is the step that takes the longest because it reads the entire evidence corpus and produces a single, internally-consistent story.',
    model: 'claude-sonnet-4-5',
    secondsPerItem: 0.8,
    whyThisTakesTime:
      'The AusIndustry portal requires per-activity hypothesis statements with falsifiable acceptance criteria, source-citation literature reviews, and pre-registered failure documentation. Producing these directly from raw evidence requires deep reading — Sonnet processes the full event chain (sometimes 100,000+ tokens) and writes the narrative in one continuous pass to keep the story internally consistent.',
  },

  narrative_pending: {
    phase: 'narrative_pending',
    label: 'Narrative ready for your review',
    description:
      'The AI has drafted a 2-3 sentence summary of what it found across your evidence, plus a set of proposed activities and invoices it would create for you. Read the summary, exclude any proposals you do not want, and click Approve to bulk-create the activities + expenditures.',
    model: 'n/a',
    secondsPerItem: 0,
    whyThisTakesTime:
      'A consultant-in-the-loop approval gate is required by our compliance design: the AI suggests, you confirm. Low-confidence proposals (below 0.80) get flagged with a 🤖 chip on the Activities tab so you can review them before submission. The approval moment is captured as a NARRATIVE_APPROVED chain event for audit trail.',
  },

  narrative_approved: {
    phase: 'narrative_approved',
    label: 'Activities created — ready for attribution',
    description:
      'Your activities and expenditures have been created. The wizard next routes you to evidence attribution, where you confirm which uploaded documents belong to which R&D activity. This is straightforward — most binding is already proposed by the AI; you just confirm or adjust.',
    model: 'n/a',
    secondsPerItem: 0,
    whyThisTakesTime:
      'Attribution is the contemporaneous-evidence test in action: every claimed activity must have at least one piece of dated evidence linking back to it. AusIndustry auditors look for this nexus.',
  },

  generating_application: {
    phase: 'generating_application',
    label: 'Building your AusIndustry application',
    description:
      'Claude Sonnet is drafting the portal-ready application: all 13 AusIndustry fields per core activity (activity name, R&D description, outcome-unknown rationale, sources investigated, competent-professional analysis, hypothesis, experiment description, evaluation methodology, conclusions, evidence kept, new-knowledge purpose + description, expenditure, related supporting activities), plus the activity register, nexus matrix, expenditure schedule, and compliance checklist.',
    model: 'claude-sonnet-4-5',
    secondsPerItem: 8.0,
    whyThisTakesTime:
      'A real AusIndustry application carries roughly 25,000 words of structured prose with embedded literature citations, falsifiable hypotheses, documented failures, and quantitative results. Producing this at the quality bar AusIndustry expects requires Sonnet (rather than Haiku) and per-activity passes — ~8s per activity ×  5-10 activities ≈ 60-90s total. We chose this over a one-shot generation because section-by-section drafting lets the model reference earlier sections (e.g. Field 9 conclusions cite Field 6 hypotheses by name).',
  },
};

/**
 * Compute a human-readable ETA from a count of pending items + the phase's
 * per-item cost. Returns null when no work is in flight.
 */
export function estimateEtaSeconds(phase: PipelinePhase, itemsPending: number): number | null {
  const desc = PHASES[phase];
  if (desc.secondsPerItem === 0 || itemsPending === 0) return null;
  return Math.max(5, Math.round(desc.secondsPerItem * itemsPending));
}

/**
 * Format an ETA seconds value as "~30 sec", "~1 min 20 sec", etc.
 */
export function formatEta(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 60) return `~${seconds} sec`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `~${m} min` : `~${m} min ${s} sec`;
}
