import type { Classifier, ClassifierInput, ClassifierOutput, ClassifiableKind } from './types.js';

type Rule = {
  pattern: RegExp;
  kind: ClassifiableKind;
  confidence: number;
  rationale: string;
  anchor: string | null;
};

/**
 * Order matters — earlier rules win.
 *
 * The plan-spec ordering put TIME_LOG first, but "We hypothesised the catalyst
 * would last 200 hours" and "Ran the test rig at 50C for 12 hours" both
 * contain a "<n> hours" duration that would short-circuit to TIME_LOG before
 * the substantive R&D-category rule could fire. Move TIME_LOG to the bottom
 * of the rule list so it only matches when no other R&D vocabulary is
 * present — i.e. pure time records like "Spent 4 hours debugging".
 *
 * Non-R&D-content rules (ASSOCIATE_FLAG, EXPENDITURE_NOTE, INELIGIBLE) also
 * precede TIME_LOG so a sentence like "Director's spouse spent 4 hours"
 * classifies as ASSOCIATE_FLAG rather than TIME_LOG.
 */
const STUB_RULES: Rule[] = [
  {
    pattern: /\b(associate|related party|spouse|director'?s? (?:wife|husband|spouse|family))/i,
    kind: 'ASSOCIATE_FLAG',
    confidence: 0.85,
    rationale: 'Stub: associate / related-party vocabulary',
    anchor: null,
  },
  {
    pattern: /\$\s?\d|invoice|paid\s+\$|expense (?:was|of|incurred)|cost (?:was|of|incurred)/i,
    kind: 'EXPENDITURE_NOTE',
    confidence: 0.8,
    rationale: 'Stub: expenditure vocabulary',
    anchor: null,
  },
  {
    pattern: /\b(routine|standard|business as usual|bau|just our normal|usual practice)\b/i,
    kind: 'INELIGIBLE',
    confidence: 0.72,
    rationale: 'Stub: ordinary-business vocabulary',
    anchor: '§355-25(2)(a)',
  },
  {
    pattern:
      /\b(hypothes[ie][sz]e?d?|posit(?:ed|ing)?|theoris[ed]|theoriz[ed]|predict(?:ed|ion))\b/i,
    kind: 'HYPOTHESIS',
    confidence: 0.85,
    rationale: 'Stub: hypothesis-formation vocabulary',
    anchor: '§355-25(1)(a)',
  },
  {
    pattern: /\b(experiment|trial|run\s+(?:a|the)\s+test|test\s+rig|measur(?:ed|ement))\b/i,
    kind: 'EXPERIMENT',
    confidence: 0.85,
    rationale: 'Stub: experimental vocabulary',
    anchor: '§355-25(1)(a)',
  },
  {
    pattern: /\b(observ(?:ed|ation)|noticed|recorded|logged that)\b/i,
    kind: 'OBSERVATION',
    confidence: 0.78,
    rationale: 'Stub: observational vocabulary',
    anchor: '§355-25(1)(a)',
  },
  {
    pattern: /\b(iter(?:ate|ation)|refin(?:e|ed)|revis(?:e|ed)|adjust(?:ed)?)\b/i,
    kind: 'ITERATION',
    confidence: 0.75,
    rationale: 'Stub: iteration vocabulary',
    anchor: '§355-25(1)(a)',
  },
  {
    pattern: /\b(uncertain(?:ty)?|unsure|unknown|unclear|ambiguous|edge case)\b/i,
    kind: 'UNCERTAINTY',
    confidence: 0.8,
    rationale: 'Stub: uncertainty vocabulary',
    anchor: '§355-25(1)(a)',
  },
  {
    pattern: /\b(learned|discover(?:ed|y)|insight|finding|conclud(?:e|ed))\b/i,
    kind: 'NEW_KNOWLEDGE',
    confidence: 0.78,
    rationale: 'Stub: new-knowledge vocabulary',
    anchor: '§355-25(1)(a)',
  },
  {
    pattern: /\b(design|architecture|blueprint|schematic|spec(?:ification)?)\b/i,
    kind: 'DESIGN',
    confidence: 0.78,
    rationale: 'Stub: design vocabulary',
    anchor: null,
  },
  {
    pattern: /\b(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b|\btime spent\b)/i,
    kind: 'TIME_LOG',
    confidence: 0.92,
    rationale: 'Stub: time-quantity vocabulary',
    anchor: null,
  },
];

/**
 * Deterministic regex-based classifier used in CI and as the always-available
 * fallback. Runs zero API calls and produces stable output for the same input.
 *
 * The default classification when no rule matches is SUPPORTING with a low
 * (0.50) confidence — this corresponds to Division 355-30 supporting-activity
 * status and is intentionally conservative so consultants review borderline
 * cases rather than the system silently calling them ineligible.
 */
export class StubClassifier implements Classifier {
  // Async signature is required by the Classifier interface even though this
  // implementation never awaits — keeps the interface symmetric with HaikuClassifier.
  // eslint-disable-next-line @typescript-eslint/require-await
  async classify({ raw_text }: ClassifierInput): Promise<ClassifierOutput> {
    for (const rule of STUB_RULES) {
      if (rule.pattern.test(raw_text)) {
        return {
          kind: rule.kind,
          confidence: rule.confidence,
          rationale: rule.rationale,
          statutory_anchor: rule.anchor,
          model: 'stub-v1.0.0',
          prompt_version: 'classify@1.0.0',
          tokens_in: 0,
          tokens_out: 0,
        };
      }
    }
    return {
      kind: 'SUPPORTING',
      confidence: 0.5,
      rationale: 'Stub: no specific match; defaulting to SUPPORTING per §355-30',
      statutory_anchor: '§355-30',
      model: 'stub-v1.0.0',
      prompt_version: 'classify@1.0.0',
      tokens_in: 0,
      tokens_out: 0,
    };
  }
}
