/**
 * At-risk + clawback calculator for Theme D compliance.
 *
 * Given an activity's claimed expenditure + offset model, computes:
 *   - "If rejected today" claim drop
 *   - "If rejected after 4 years" clawback (claim drop + interest at ATO
 *     general interest charge rate)
 *
 * The ATO General Interest Charge (GIC) rate is compounded daily per
 * Part IIA of the Taxation Administration Act 1953. For simplicity this
 * calculator uses simple interest over the period. The rate is updated
 * quarterly by the ATO; the constant below is the FY24-25 indicative rate.
 */

/** ATO General Interest Charge rate (annualised). Updated quarterly. */
export const ATO_GIC_RATE = 0.1122; // 11.22% p.a. as at FY24-25

/** R&D Tax Incentive offset rate for aggregated turnover < $20M. */
export const RDTI_OFFSET_RATE_SMALL = 0.435; // 43.5%

/** R&D Tax Incentive offset rate for aggregated turnover >= $20M. */
export const RDTI_OFFSET_RATE_LARGE = 0.385; // 38.5% (base rate + 10% increment)

/** Company tax rate used for offset calculation. */
export const COMPANY_TAX_RATE = 0.25; // 25% base rate for base-rate entities

export interface ClawbackInput {
  /** Activity identifier. */
  activity_id: string;
  /** Activity title for display. */
  activity_title: string;
  /** Total claimed R&D expenditure for this activity (AUD). */
  claimed_expenditure_aud: number;
  /** Whether the entity has aggregated turnover < $20M. */
  is_small_entity: boolean;
  /** Years since claim was lodged (for interest calculation). */
  years_since_lodgement: number;
}

export interface ClawbackResult {
  activity_id: string;
  activity_title: string;
  /** Original claimed expenditure. */
  claimed_expenditure_aud: number;
  /** The R&DTI offset rate applied. */
  offset_rate: number;
  /** Offset amount = claimed_expenditure * (offset_rate - company_tax_rate). */
  offset_amount_aud: number;
  /** If rejected today, this is the amount owed back to ATO. */
  claim_drop_aud: number;
  /** Interest accrued at ATO GIC rate over years_since_lodgement. */
  interest_aud: number;
  /** Total clawback = claim_drop + interest. */
  clawback_aud: number;
  /** Years used for interest calculation. */
  years_since_lodgement: number;
}

export function calculateClawback(input: ClawbackInput): ClawbackResult {
  const offsetRate = input.is_small_entity ? RDTI_OFFSET_RATE_SMALL : RDTI_OFFSET_RATE_LARGE;
  const netBenefitRate = offsetRate - COMPANY_TAX_RATE;
  const offsetAmount = input.claimed_expenditure_aud * netBenefitRate;
  const claimDrop = offsetAmount; // If rejected, entire offset is reversed
  const interest = claimDrop * ATO_GIC_RATE * input.years_since_lodgement;
  const clawback = claimDrop + interest;

  return {
    activity_id: input.activity_id,
    activity_title: input.activity_title,
    claimed_expenditure_aud: input.claimed_expenditure_aud,
    offset_rate: offsetRate,
    offset_amount_aud: Math.round(offsetAmount * 100) / 100,
    claim_drop_aud: Math.round(claimDrop * 100) / 100,
    interest_aud: Math.round(interest * 100) / 100,
    clawback_aud: Math.round(clawback * 100) / 100,
    years_since_lodgement: input.years_since_lodgement,
  };
}

export interface ClawbackSummary {
  total_claimed_aud: number;
  total_claim_drop_aud: number;
  total_interest_aud: number;
  total_clawback_aud: number;
  activities: ClawbackResult[];
}

export function calculateClawbackSummary(inputs: ClawbackInput[]): ClawbackSummary {
  const results = inputs.map(calculateClawback);
  return {
    total_claimed_aud: results.reduce((s, r) => s + r.claimed_expenditure_aud, 0),
    total_claim_drop_aud: results.reduce((s, r) => s + r.claim_drop_aud, 0),
    total_interest_aud: results.reduce((s, r) => s + r.interest_aud, 0),
    total_clawback_aud: results.reduce((s, r) => s + r.clawback_aud, 0),
    activities: results,
  };
}
