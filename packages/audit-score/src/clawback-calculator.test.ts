import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateClawback,
  calculateClawbackSummary,
  ATO_GIC_RATE,
  RDTI_OFFSET_RATE_SMALL,
  RDTI_OFFSET_RATE_LARGE,
  COMPANY_TAX_RATE,
} from './clawback-calculator.js';

test('calculateClawback: small entity, 0 years since lodgement → no interest', () => {
  const result = calculateClawback({
    activity_id: 'a1',
    activity_title: 'Activity 1',
    claimed_expenditure_aud: 100_000,
    is_small_entity: true,
    years_since_lodgement: 0,
  });
  const expectedOffset = 100_000 * (RDTI_OFFSET_RATE_SMALL - COMPANY_TAX_RATE);
  assert.equal(result.offset_amount_aud, Math.round(expectedOffset * 100) / 100);
  assert.equal(result.interest_aud, 0);
  assert.equal(result.clawback_aud, result.claim_drop_aud);
});

test('calculateClawback: large entity, 4 years → interest accrues', () => {
  const result = calculateClawback({
    activity_id: 'a2',
    activity_title: 'Activity 2',
    claimed_expenditure_aud: 500_000,
    is_small_entity: false,
    years_since_lodgement: 4,
  });
  const expectedOffset = 500_000 * (RDTI_OFFSET_RATE_LARGE - COMPANY_TAX_RATE);
  const expectedInterest = expectedOffset * ATO_GIC_RATE * 4;
  assert.equal(result.offset_rate, RDTI_OFFSET_RATE_LARGE);
  assert.equal(result.interest_aud, Math.round(expectedInterest * 100) / 100);
  assert.ok(
    result.clawback_aud > result.claim_drop_aud,
    'clawback must exceed claim drop when interest > 0',
  );
});

test('calculateClawbackSummary: aggregates correctly', () => {
  const summary = calculateClawbackSummary([
    {
      activity_id: 'a1',
      activity_title: 'A1',
      claimed_expenditure_aud: 100_000,
      is_small_entity: true,
      years_since_lodgement: 2,
    },
    {
      activity_id: 'a2',
      activity_title: 'A2',
      claimed_expenditure_aud: 200_000,
      is_small_entity: true,
      years_since_lodgement: 2,
    },
  ]);
  assert.equal(summary.total_claimed_aud, 300_000);
  assert.equal(summary.activities.length, 2);
  assert.ok(summary.total_clawback_aud > summary.total_claim_drop_aud);
});

test('calculateClawback: zero expenditure → zero everything', () => {
  const result = calculateClawback({
    activity_id: 'a0',
    activity_title: 'Zero',
    claimed_expenditure_aud: 0,
    is_small_entity: true,
    years_since_lodgement: 4,
  });
  assert.equal(result.offset_amount_aud, 0);
  assert.equal(result.claim_drop_aud, 0);
  assert.equal(result.interest_aud, 0);
  assert.equal(result.clawback_aud, 0);
});
