import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEvidenceKinds,
  parseClaimantIds,
  parseLimit,
  serializeEvidenceParams,
  DEFAULT_EVIDENCE_LIMIT,
  type EvidenceUrlParams,
} from './url-params.js';

// parseEvidenceKinds --------------------------------------------------------

test('parseEvidenceKinds: null returns undefined (no filter)', () => {
  assert.equal(parseEvidenceKinds(null), undefined);
});

test('parseEvidenceKinds: empty string returns undefined', () => {
  assert.equal(parseEvidenceKinds(''), undefined);
});

test('parseEvidenceKinds: single valid kind returns array', () => {
  assert.deepEqual(parseEvidenceKinds('HYPOTHESIS'), ['HYPOTHESIS']);
});

test('parseEvidenceKinds: CSV of valid kinds returns array', () => {
  assert.deepEqual(parseEvidenceKinds('HYPOTHESIS,OBSERVATION'), ['HYPOTHESIS', 'OBSERVATION']);
});

test('parseEvidenceKinds: strips invalid kinds, keeping only valid ones', () => {
  assert.deepEqual(parseEvidenceKinds('HYPOTHESIS,BOGUS,OBSERVATION'), [
    'HYPOTHESIS',
    'OBSERVATION',
  ]);
});

test('parseEvidenceKinds: all invalid returns undefined', () => {
  assert.equal(parseEvidenceKinds('BOGUS,FAKE'), undefined);
});

// parseClaimantIds ----------------------------------------------------------

test('parseClaimantIds: null returns undefined', () => {
  assert.equal(parseClaimantIds(null), undefined);
});

test('parseClaimantIds: empty string returns undefined', () => {
  assert.equal(parseClaimantIds(''), undefined);
});

test('parseClaimantIds: single UUID returns array', () => {
  assert.deepEqual(parseClaimantIds('00000000-0000-4000-8000-000000000001'), [
    '00000000-0000-4000-8000-000000000001',
  ]);
});

test('parseClaimantIds: CSV of UUIDs returns array', () => {
  const a = '00000000-0000-4000-8000-000000000001';
  const b = '00000000-0000-4000-8000-000000000002';
  assert.deepEqual(parseClaimantIds(`${a},${b}`), [a, b]);
});

test('parseClaimantIds: strips non-UUID values', () => {
  const a = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(parseClaimantIds(`${a},not-a-uuid`), [a]);
});

test('parseClaimantIds: all invalid returns undefined', () => {
  assert.equal(parseClaimantIds('bad,values'), undefined);
});

// parseLimit ----------------------------------------------------------------

test('parseLimit: null returns default', () => {
  assert.equal(parseLimit(null), DEFAULT_EVIDENCE_LIMIT);
});

test('parseLimit: valid number returns that number', () => {
  assert.equal(parseLimit('25'), 25);
});

test('parseLimit: below 1 clamps to 1', () => {
  assert.equal(parseLimit('0'), 1);
  assert.equal(parseLimit('-5'), 1);
});

test('parseLimit: above 200 clamps to 200', () => {
  assert.equal(parseLimit('999'), 200);
});

test('parseLimit: non-numeric returns default', () => {
  assert.equal(parseLimit('abc'), DEFAULT_EVIDENCE_LIMIT);
});

// serializeEvidenceParams ---------------------------------------------------

test('serializeEvidenceParams: empty params returns empty string', () => {
  assert.equal(serializeEvidenceParams({}), '');
});

test('serializeEvidenceParams: kinds serializes as CSV', () => {
  const params: Partial<EvidenceUrlParams> = { kinds: ['HYPOTHESIS', 'OBSERVATION'] };
  assert.equal(serializeEvidenceParams(params), 'kinds=HYPOTHESIS%2COBSERVATION');
});

test('serializeEvidenceParams: claimant_ids serializes as CSV', () => {
  const a = '00000000-0000-4000-8000-000000000001';
  const b = '00000000-0000-4000-8000-000000000002';
  const params: Partial<EvidenceUrlParams> = { claimant_ids: [a, b] };
  const qs = serializeEvidenceParams(params);
  assert.ok(qs.includes('claimant_ids='));
  // Verify round-trip: the serialized value contains both UUIDs comma-separated.
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get('claimant_ids'), `${a},${b}`);
});

test('serializeEvidenceParams: limit omitted when default', () => {
  const params: Partial<EvidenceUrlParams> = { limit: DEFAULT_EVIDENCE_LIMIT };
  assert.equal(serializeEvidenceParams(params), '');
});

test('serializeEvidenceParams: limit included when non-default', () => {
  const params: Partial<EvidenceUrlParams> = { limit: 10 };
  const sp = new URLSearchParams(serializeEvidenceParams(params));
  assert.equal(sp.get('limit'), '10');
});

test('serializeEvidenceParams: cursor is passed through', () => {
  const params: Partial<EvidenceUrlParams> = { cursor: 'abc123' };
  const sp = new URLSearchParams(serializeEvidenceParams(params));
  assert.equal(sp.get('cursor'), 'abc123');
});

test('serializeEvidenceParams: full round-trip with multiple params', () => {
  const params: Partial<EvidenceUrlParams> = {
    kinds: ['HYPOTHESIS'],
    claimant_ids: ['00000000-0000-4000-8000-000000000001'],
    limit: 25,
  };
  const qs = serializeEvidenceParams(params);
  const sp = new URLSearchParams(qs);
  assert.equal(sp.get('kinds'), 'HYPOTHESIS');
  assert.equal(sp.get('claimant_ids'), '00000000-0000-4000-8000-000000000001');
  assert.equal(sp.get('limit'), '25');
});
