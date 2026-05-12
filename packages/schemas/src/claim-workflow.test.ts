import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowState, WorkflowStepNumber } from './claim-workflow.js';

test('WorkflowState accepts a fresh wizard state', () => {
  const r = WorkflowState.safeParse({
    initialized_at: '2026-05-12T00:00:00Z',
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  });
  assert.equal(r.success, true);
});

test('WorkflowState accepts a populated step', () => {
  const r = WorkflowState.safeParse({
    initialized_at: '2026-05-12T00:00:00Z',
    steps: {
      '1': { agreed_at: '2026-05-12T01:00:00Z', agreed_by: '00000000-0000-4000-8000-000000000001' },
      '2': null,
      '3': null,
      '4': null,
      '5': null,
    },
  });
  assert.equal(r.success, true);
});

test('WorkflowState rejects missing step keys', () => {
  const r = WorkflowState.safeParse({
    initialized_at: '2026-05-12T00:00:00Z',
    steps: { '1': null, '2': null }, // missing 3,4,5
  });
  assert.equal(r.success, false);
});

test('WorkflowState rejects unknown step keys', () => {
  const r = WorkflowState.safeParse({
    initialized_at: '2026-05-12T00:00:00Z',
    steps: {
      '1': null,
      '2': null,
      '3': null,
      '4': null,
      '5': null,
      '6': null, // unknown step number — caller or migration out of sync
    },
  });
  assert.equal(r.success, false);
});

test('WorkflowStepNumber accepts 1..5 only', () => {
  for (const n of [1, 2, 3, 4, 5]) assert.equal(WorkflowStepNumber.safeParse(n).success, true);
  assert.equal(WorkflowStepNumber.safeParse(0).success, false);
  assert.equal(WorkflowStepNumber.safeParse(6).success, false);
});
