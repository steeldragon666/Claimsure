import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAdvance, type WorkflowSnapshot } from './workflow.js';

const empty: WorkflowSnapshot = {
  eventsClassified: 0,
  proposedActivitiesPending: 0,
  proposedActivitiesTotal: 0,
  agreedActivitiesTotal: 0,
  agreedActivitiesWithoutBinding: 0,
  narrativeSectionsApproved: 0,
};

test('canAdvance step 1 requires at least one classified event', () => {
  assert.equal(canAdvance(1, empty).ok, false);
  assert.equal(canAdvance(1, { ...empty, eventsClassified: 1 }).ok, true);
});

test('canAdvance step 2 requires all proposed activities resolved', () => {
  // some pending → blocked
  const r1 = canAdvance(2, { ...empty, proposedActivitiesTotal: 4, proposedActivitiesPending: 2 });
  assert.equal(r1.ok, false);
  // all resolved → allowed (even if zero proposed)
  const r2 = canAdvance(2, { ...empty, proposedActivitiesTotal: 4, proposedActivitiesPending: 0 });
  assert.equal(r2.ok, true);
});

test('canAdvance step 3 requires every agreed activity bound to evidence', () => {
  const r1 = canAdvance(3, {
    ...empty,
    agreedActivitiesTotal: 3,
    agreedActivitiesWithoutBinding: 1,
  });
  assert.equal(r1.ok, false);
  const r2 = canAdvance(3, {
    ...empty,
    agreedActivitiesTotal: 3,
    agreedActivitiesWithoutBinding: 0,
  });
  assert.equal(r2.ok, true);
});

test('canAdvance step 4 requires 4 approved narrative sections', () => {
  assert.equal(canAdvance(4, { ...empty, narrativeSectionsApproved: 3 }).ok, false);
  assert.equal(canAdvance(4, { ...empty, narrativeSectionsApproved: 4 }).ok, true);
});

test('canAdvance step 5 is terminal — always returns ok=false with terminal reason', () => {
  const r = canAdvance(5, empty);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /terminal/i);
});
