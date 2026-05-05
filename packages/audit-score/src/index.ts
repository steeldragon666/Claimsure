export type {
  ScoreInput,
  ScoreResult,
  ScoreRule,
  ScoreRuleBreakdown,
  ScoreRuleResult,
  SqlClient,
} from './types.js';
export { SCORING_RULES, TOTAL_MAX_PTS } from './rules.js';
export { computeScore } from './score.js';

export {
  calculateClawback,
  calculateClawbackSummary,
  ATO_GIC_RATE,
  RDTI_OFFSET_RATE_SMALL,
  RDTI_OFFSET_RATE_LARGE,
  COMPANY_TAX_RATE,
} from './clawback-calculator.js';
export type { ClawbackInput, ClawbackResult, ClawbackSummary } from './clawback-calculator.js';
