import type {
  ExpenditureClassifier,
  ExpenditureClassifierInput,
  ExpenditureClassifierOutput,
  ExpenditureDecision,
  ExpenditureStatutoryAnchor,
} from './types.js';

type StubMatch = {
  decision: ExpenditureDecision;
  statutory_anchor: ExpenditureStatutoryAnchor;
  confidence: number;
};

/**
 * Patterns are checked IN ORDER; first match wins.
 *
 * Order matters when a vendor name + description spans multiple categories
 * (e.g. an AWS line described as "research compute"). The chosen precedence
 * is INELIGIBLE-first because the §355-25(2)(a) ordinary-business exclusion
 * is a hard gate — a Stripe / GitHub / Atlassian invoice is excluded even if
 * the project description happens to mention "research". Consultants told us
 * to err toward calling those out as ineligible at the stub layer rather than
 * letting the eligible regex catch a SaaS line item.
 */
const PATTERNS: Array<[RegExp, StubMatch]> = [
  // CLEARLY INELIGIBLE — generic SaaS / hosting / commodity software.
  [
    /atlassian|github|stripe|aws|datadog|cloudflare|sentry|notion|slack|zoom/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.92 },
  ],
  // INELIGIBLE — insurance, broker, risk transfer.
  [
    /\b(aon\s+(?:risk|insur|aviation)|marsh(?:\s+(?:insur|aviation|risk))?|nrma|qbe|insurance\s+(?:premium|renewal))\b/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.9 },
  ],
  // INELIGIBLE — tax, accounting, audit, statutory advisory.
  [
    /\b(?:pwc(?:\s+tax)?|ey\s+tax|kpmg(?:\s+tax)?|deloitte(?:\s+tax)?|grant\s+thornton|bdo(?:\s+(?:tax|accounting))?)\b|\b(?:tax|board)\s+(?:prep|advisor(?:y)?|return|pack)\b/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.9 },
  ],
  // INELIGIBLE — corporate travel.
  [
    /\b(?:webjet|qantas|virgin\s+aus|jetstar|flight\s+centre)\b/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.9 },
  ],
  // INELIGIBLE — fuel cards, petrol, vehicle running costs.
  [
    /\b(?:caltex|starcard|bp\s+(?:fuel|diesel)|shell\s+(?:card|fuel))\b/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.9 },
  ],
  // INELIGIBLE — non-R&D SaaS (sales / marketing / collab tools).
  [
    /\b(?:salesforce|hubspot|monday\.?com|asana|miro|figma)\b/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.9 },
  ],
  // INELIGIBLE — Australian telco accounts.
  [
    /\b(?:telstra|optus|vodafone(?:\s+aus)?|tpg\s+telecom)\b/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.9 },
  ],
  // INELIGIBLE — coworking / rent / office lease.
  [
    /\b(?:wework|hub\s+australia)\b|\b(?:office|premises)\s+(?:lease|rent)\b/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.9 },
  ],
  // INELIGIBLE — retail / general hardware stores.
  [
    /\b(?:officeworks|bunnings|jb\s+hi-?fi)\b/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.9 },
  ],
  // INELIGIBLE — general legal services (patent / legal review is
  // caught by the §355-30 pattern below — order matters).
  [
    /\b(?:latitude\s+legal|general\s+counsel|company\s+secretarial)\b/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.85 },
  ],
  // INELIGIBLE — aviation regulator / permit fees (admin, not R&D).
  [
    /\bcasa\s+permit\b/i,
    { decision: 'ineligible', statutory_anchor: 'ineligible', confidence: 0.85 },
  ],
  // CLEARLY ELIGIBLE under §355-25 — research / lab / experimental vocabulary.
  [
    /research|laboratory|prototype|experiment|reagent|specimen|sigma[\s-]?aldrich|fisher scientific|thermo fisher|mass spectrometer/i,
    { decision: 'eligible', statutory_anchor: 's.355-25', confidence: 0.88 },
  ],
  // ELIGIBLE under §355-30 — supporting (scoping/feasibility/training/PM for R&D).
  [
    /scoping|feasibility|training|patent|legal review/i,
    { decision: 'eligible', statutory_anchor: 's.355-30', confidence: 0.78 },
  ],
];

/**
 * Deterministic regex-based expenditure classifier used in CI and as the
 * always-available fallback. Runs zero API calls and produces stable output
 * for the same input.
 *
 * The default classification when no rule matches is `needs_review` with
 * 0.50 confidence — conservative on purpose so unseen vendors land on a
 * consultant's queue rather than being silently called eligible/ineligible.
 *
 * `suggested_activity_id` is always null in the stub; activity matching is a
 * model-side judgement we do not approximate with regex.
 */
export class StubExpenditureClassifier implements ExpenditureClassifier {
  // Async signature is required by the ExpenditureClassifier interface even
  // though this implementation never awaits — keeps the interface symmetric
  // with HaikuExpenditureClassifier.
  // eslint-disable-next-line @typescript-eslint/require-await
  async classify(input: ExpenditureClassifierInput): Promise<ExpenditureClassifierOutput> {
    const haystack = `${input.expenditure.vendor_name} ${input.expenditure.description ?? ''}`;
    let match: StubMatch = {
      decision: 'needs_review',
      // best-guess anchor when needs_review — runtime downgrade ignores it
      statutory_anchor: 'ineligible',
      confidence: 0.5,
    };
    for (const [re, m] of PATTERNS) {
      if (re.test(haystack)) {
        match = m;
        break;
      }
    }
    return {
      expenditure_id: input.expenditure_id,
      decision: match.decision,
      eligibility_probability: match.confidence,
      statutory_anchor: match.statutory_anchor,
      suggested_activity_id: null,
      rationale: `Stub match: ${match.decision} (vendor "${input.expenditure.vendor_name}").`,
      uncertainty_reason: match.decision === 'needs_review' ? 'No stub pattern matched.' : null,
      model: 'stub-v1.0.0',
      prompt_version: 'stub-v1.0.0',
      tokens_in: 0,
      tokens_out: 0,
    };
  }
}
