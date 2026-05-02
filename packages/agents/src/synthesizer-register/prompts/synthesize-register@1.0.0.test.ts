import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import './synthesize-register@1.0.0.js';
import { synthesizeRegisterToolSchema } from './synthesize-register@1.0.0.js';
import { getPrompt, listPrompts } from '../../runtime/prompt-registry.js';
import { MAX_PROPOSED_ACTIVITIES } from '../types.js';

const okActivity = (overrides: Record<string, unknown> = {}) => ({
  proposed_id: randomUUID(),
  name: 'Sparse reward curriculum study on robotics benchmarks',
  kind: 'core',
  statutory_anchor: 's.355-25',
  rationale: 'Forms a complete experimental loop addressing a non-obvious outcome.',
  clustered_event_ids: [randomUUID()],
  confidence: 0.85,
  proposed_hypothesis: 'Curriculum halves sample complexity.',
  proposed_uncertainty: 'Variance impact was unknown in advance.',
  ...overrides,
});

const okPayload = (overrides: Record<string, unknown> = {}) => ({
  proposed_activities: [okActivity()],
  unclustered_event_ids: [randomUUID()],
  total_input_events: 10,
  events_truncated: false,
  synthesizer_notes: 'Two clusters considered; merged on shared hypothesis.',
  ...overrides,
});

test('registry contains synthesize-register@1.0.0', () => {
  assert.ok(listPrompts().includes('synthesize-register@1.0.0'));
  const p = getPrompt('synthesize-register@1.0.0');
  assert.equal(p.name, 'synthesize-register');
  assert.equal(p.version, '1.0.0');
  assert.equal(p.tool.name, 'synthesize_register');
  assert.match(p.tool.description, /Division 355/);
  assert.match(p.system, /s\.355-25/);
  assert.match(p.system, /s\.355-30/);
  assert.match(p.system, /dominant-purpose/i);
});

test('happy-path payload parses', () => {
  const a1 = okActivity({
    proposed_hypothesis: null,
    proposed_uncertainty: null,
  });
  const a2 = okActivity({
    kind: 'supporting',
    statutory_anchor: 's.355-30',
    name: 'Feature store pipeline build supporting curriculum experiments',
  });
  const out = synthesizeRegisterToolSchema.parse(
    okPayload({
      proposed_activities: [a1, a2],
      unclustered_event_ids: [randomUUID()],
      total_input_events: 10,
      events_truncated: false,
    }),
  );
  assert.equal(out.proposed_activities.length, 2);
  assert.equal(out.unclustered_event_ids.length, 1);
  assert.equal(out.total_input_events, 10);
  assert.equal(out.events_truncated, false);
  assert.ok(out.synthesizer_notes.length > 0);
  assert.equal(out.proposed_activities[0].proposed_hypothesis, null);
  assert.equal(out.proposed_activities[0].proposed_uncertainty, null);
});

test('rejects empty clustered_event_ids', () => {
  const bad = okPayload({
    proposed_activities: [okActivity({ clustered_event_ids: [] })],
  });
  assert.throws(() => synthesizeRegisterToolSchema.parse(bad));
});

test('rejects bad UUID in proposed_id', () => {
  const bad = okPayload({
    proposed_activities: [okActivity({ proposed_id: 'not-a-uuid' })],
  });
  assert.throws(() => synthesizeRegisterToolSchema.parse(bad));
});

test('rejects bad UUID in clustered_event_ids', () => {
  const bad = okPayload({
    proposed_activities: [okActivity({ clustered_event_ids: ['not-a-uuid'] })],
  });
  assert.throws(() => synthesizeRegisterToolSchema.parse(bad));
});

test('rejects kind not in enum', () => {
  const bad = okPayload({
    proposed_activities: [okActivity({ kind: 'ineligible' })],
  });
  assert.throws(() => synthesizeRegisterToolSchema.parse(bad));
});

test('rejects statutory_anchor not in enum', () => {
  const bad = okPayload({
    proposed_activities: [okActivity({ statutory_anchor: 's.355-99' })],
  });
  assert.throws(() => synthesizeRegisterToolSchema.parse(bad));
});

test('rejects confidence out of [0,1]', () => {
  assert.throws(() =>
    synthesizeRegisterToolSchema.parse(
      okPayload({ proposed_activities: [okActivity({ confidence: 1.5 })] }),
    ),
  );
  assert.throws(() =>
    synthesizeRegisterToolSchema.parse(
      okPayload({ proposed_activities: [okActivity({ confidence: -0.1 })] }),
    ),
  );
});

test(`rejects > ${MAX_PROPOSED_ACTIVITIES} proposed_activities`, () => {
  const tooMany = Array.from({ length: MAX_PROPOSED_ACTIVITIES + 1 }, () => okActivity());
  assert.throws(() =>
    synthesizeRegisterToolSchema.parse(okPayload({ proposed_activities: tooMany })),
  );
});

test(`accepts exactly ${MAX_PROPOSED_ACTIVITIES} proposed_activities`, () => {
  const atCap = Array.from({ length: MAX_PROPOSED_ACTIVITIES }, () => okActivity());
  const out = synthesizeRegisterToolSchema.parse(okPayload({ proposed_activities: atCap }));
  assert.equal(out.proposed_activities.length, MAX_PROPOSED_ACTIVITIES);
});

test('accepts proposed_hypothesis=null and proposed_uncertainty=null', () => {
  const out = synthesizeRegisterToolSchema.parse(
    okPayload({
      proposed_activities: [okActivity({ proposed_hypothesis: null, proposed_uncertainty: null })],
    }),
  );
  assert.equal(out.proposed_activities[0].proposed_hypothesis, null);
  assert.equal(out.proposed_activities[0].proposed_uncertainty, null);
});

test('schema does NOT include model / prompt_version / idempotency_key', () => {
  const withMeta = {
    ...okPayload(),
    model: 'claude-sonnet',
    prompt_version: '1.0.0',
    idempotency_key: 'k',
  };
  // Zod default is strip-extra; metadata fields silently drop rather than fail
  // — but the parsed shape must NOT carry them.
  const out = synthesizeRegisterToolSchema.parse(withMeta) as Record<string, unknown>;
  assert.equal('model' in out, false);
  assert.equal('prompt_version' in out, false);
  assert.equal('idempotency_key' in out, false);
});

test('canonical core ↔ s.355-25 pairing accepted', () => {
  const out = synthesizeRegisterToolSchema.parse(
    okPayload({
      proposed_activities: [okActivity({ kind: 'core', statutory_anchor: 's.355-25' })],
    }),
  );
  assert.equal(out.proposed_activities[0].kind, 'core');
  assert.equal(out.proposed_activities[0].statutory_anchor, 's.355-25');
});

test('canonical supporting ↔ s.355-30 pairing accepted', () => {
  const out = synthesizeRegisterToolSchema.parse(
    okPayload({
      proposed_activities: [okActivity({ kind: 'supporting', statutory_anchor: 's.355-30' })],
    }),
  );
  assert.equal(out.proposed_activities[0].kind, 'supporting');
  assert.equal(out.proposed_activities[0].statutory_anchor, 's.355-30');
});

test('rejects empty proposed_activities ALSO ok (zero clusters allowed)', () => {
  // The shared schema permits an empty register (synthesizer concluded no
  // coherent activity). We test acceptance, not rejection.
  const out = synthesizeRegisterToolSchema.parse(okPayload({ proposed_activities: [] }));
  assert.equal(out.proposed_activities.length, 0);
});
