import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import './prompts/synthesize-register@1.0.0.js';
import { synthesizeRegisterToolSchema } from './prompts/synthesize-register@1.0.0.js';
import { isoYearWeek, StubRegisterSynthesizer } from './stub.js';
import type { CompressedEvent, SynthesizerInput } from './types.js';
import { MAX_PROPOSED_ACTIVITIES } from './types.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const ev = (overrides: Partial<CompressedEvent> = {}): CompressedEvent => ({
  id: randomUUID(),
  kind: 'HYPOTHESIS',
  captured_at: '2024-07-15T10:00:00Z',
  summary: 's',
  subject_tenant_id: TENANT_A,
  ...overrides,
});

const input = (events: CompressedEvent[], events_truncated = false): SynthesizerInput => ({
  project: {
    id: randomUUID(),
    name: 'P',
    industry_sector: null,
    started_at: '2024-07-01T00:00:00Z',
    fiscal_year: 2025,
  },
  events,
  existing_activities: [],
  events_truncated,
});

const s = new StubRegisterSynthesizer();

test('isoYearWeek: 2024-01-01 (Mon) is week 1 of 2024', () => {
  const w = isoYearWeek('2024-01-01T00:00:00Z');
  assert.equal(w.year, 2024);
  assert.equal(w.week, 1);
  assert.equal(w.weekStartIso, '2024-01-01');
});

test('isoYearWeek: 2024-01-07 (Sun) is still week 1 of 2024', () => {
  const w = isoYearWeek('2024-01-07T23:59:00Z');
  assert.equal(w.year, 2024);
  assert.equal(w.week, 1);
  assert.equal(w.weekStartIso, '2024-01-01');
});

test('isoYearWeek: 2024-12-30 (Mon) is week 1 of 2025', () => {
  const w = isoYearWeek('2024-12-30T00:00:00Z');
  assert.equal(w.year, 2025);
  assert.equal(w.week, 1);
});

test('isoYearWeek: 2023-01-01 (Sun) is week 52 of 2022', () => {
  const w = isoYearWeek('2023-01-01T12:00:00Z');
  assert.equal(w.year, 2022);
  assert.equal(w.week, 52);
});

test('isoYearWeek: 2020-12-31 (Thu) is week 53 of 2020', () => {
  const w = isoYearWeek('2020-12-31T00:00:00Z');
  assert.equal(w.year, 2020);
  assert.equal(w.week, 53);
});

test('single event → 1 proposed activity, 1 clustered event id', async () => {
  const events = [ev({ id: randomUUID() })];
  const out = await s.synthesize(input(events));
  assert.equal(out.proposed_activities.length, 1);
  assert.equal(out.proposed_activities[0].clustered_event_ids.length, 1);
  assert.equal(out.proposed_activities[0].clustered_event_ids[0], events[0].id);
  assert.equal(out.unclustered_event_ids.length, 0);
  assert.equal(out.total_input_events, 1);
});

test('two events same week + same subject → one proposed activity', async () => {
  const events = [
    ev({ captured_at: '2024-07-15T08:00:00Z' }), // Mon
    ev({ captured_at: '2024-07-19T17:00:00Z' }), // Fri same week
  ];
  const out = await s.synthesize(input(events));
  assert.equal(out.proposed_activities.length, 1);
  assert.equal(out.proposed_activities[0].clustered_event_ids.length, 2);
  assert.equal(out.unclustered_event_ids.length, 0);
});

test('two events different weeks → two proposed activities', async () => {
  const events = [
    ev({ captured_at: '2024-07-15T08:00:00Z' }), // wk 29
    ev({ captured_at: '2024-07-22T08:00:00Z' }), // wk 30
  ];
  const out = await s.synthesize(input(events));
  assert.equal(out.proposed_activities.length, 2);
  assert.equal(out.proposed_activities[0].clustered_event_ids.length, 1);
  assert.equal(out.proposed_activities[1].clustered_event_ids.length, 1);
});

test('two events same week different subjects → two proposed activities', async () => {
  const events = [
    ev({ captured_at: '2024-07-15T08:00:00Z', subject_tenant_id: TENANT_A }),
    ev({ captured_at: '2024-07-15T09:00:00Z', subject_tenant_id: TENANT_B }),
  ];
  const out = await s.synthesize(input(events));
  assert.equal(out.proposed_activities.length, 2);
});

test(`> ${MAX_PROPOSED_ACTIVITIES} buckets cap at ${MAX_PROPOSED_ACTIVITIES}; rest go to unclustered`, async () => {
  // Generate one event per ISO week across enough weeks to exceed the cap.
  // 35 weeks > MAX (30), guarantees overflow.
  const events: CompressedEvent[] = [];
  const start = new Date('2024-01-01T00:00:00Z'); // 2024-W01
  for (let i = 0; i < 35; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i * 7);
    events.push(ev({ id: randomUUID(), captured_at: d.toISOString() }));
  }
  const out = await s.synthesize(input(events));
  assert.equal(out.proposed_activities.length, MAX_PROPOSED_ACTIVITIES);
  assert.equal(out.unclustered_event_ids.length, 35 - MAX_PROPOSED_ACTIVITIES);
});

test('empty input → empty register, empty unclustered', async () => {
  const out = await s.synthesize(input([]));
  assert.equal(out.proposed_activities.length, 0);
  assert.equal(out.unclustered_event_ids.length, 0);
  assert.equal(out.total_input_events, 0);
  assert.match(out.synthesizer_notes, /no events/i);
});

test('determinism: same input twice → identical output (incl. proposed_id UUIDs)', async () => {
  const events = [
    ev({ id: 'a0000000-0000-4000-8000-000000000001', captured_at: '2024-07-15T10:00:00Z' }),
    ev({ id: 'a0000000-0000-4000-8000-000000000002', captured_at: '2024-07-22T10:00:00Z' }),
  ];
  const i = input(events);
  const out1 = await s.synthesize(i);
  const out2 = await s.synthesize(i);
  assert.deepStrictEqual(out1, out2);
});

test('all output metadata fields stamped', async () => {
  const out = await s.synthesize(input([ev()]));
  assert.equal(out.model, 'stub-v1.0.0');
  assert.equal(out.prompt_version, 'synthesize-register@1.0.0');
  assert.equal(out.tokens_in, 0);
  assert.equal(out.tokens_out, 0);
});

test('events_truncated propagates from input → output', async () => {
  const out = await s.synthesize(input([ev()], true));
  assert.equal(out.events_truncated, true);
});

test('output passes the synthesize_register Zod schema', async () => {
  const events = [
    ev({ id: randomUUID(), captured_at: '2024-07-15T10:00:00Z' }),
    ev({ id: randomUUID(), captured_at: '2024-07-22T10:00:00Z', subject_tenant_id: TENANT_B }),
  ];
  const out = await s.synthesize(input(events));
  // Strip the impl-stamped metadata before parsing — those fields are
  // server-injected at emission time and aren't part of the tool schema.
  const toParse = {
    proposed_activities: out.proposed_activities,
    unclustered_event_ids: out.unclustered_event_ids,
    total_input_events: out.total_input_events,
    events_truncated: out.events_truncated,
    synthesizer_notes: out.synthesizer_notes,
  };
  assert.doesNotThrow(() => synthesizeRegisterToolSchema.parse(toParse));
});

test('stub uses kind=core, anchor=s.355-25, confidence=0.50, hypothesis/uncertainty=null', async () => {
  const out = await s.synthesize(input([ev()]));
  const a = out.proposed_activities[0];
  assert.equal(a.kind, 'core');
  assert.equal(a.statutory_anchor, 's.355-25');
  assert.equal(a.confidence, 0.5);
  assert.equal(a.proposed_hypothesis, null);
  assert.equal(a.proposed_uncertainty, null);
});
