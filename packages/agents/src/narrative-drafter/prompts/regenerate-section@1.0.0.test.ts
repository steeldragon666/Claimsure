import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrompt } from '../../runtime/prompt-registry.js';
import { SECTION_KINDS } from '../types.js';
// Import for side-effect: register the prompt.
import { draftNarrativeToolSchema } from './regenerate-section@1.0.0.js';

const VALID_UUID_A = '11111111-1111-4111-8111-111111111111';

test('regenerate-section@1.0.0 is registered with the emit_segment tool', () => {
  const p = getPrompt('regenerate-section@1.0.0');
  assert.equal(p.name, 'regenerate-section');
  assert.equal(p.version, '1.0.0');
  assert.equal(p.tool.name, 'emit_segment');
  assert.ok(p.system.length > 0, 'system prompt must be non-empty');
  // Regeneration-specific framing.
  assert.ok(
    p.system.includes('existing_sections'),
    'system prompt mentions existing_sections context block',
  );
  assert.ok(
    p.system.includes('target_section_kind'),
    'system prompt mentions the target_section_kind constraint',
  );
  // All four section kinds are still referenced (the model needs to know what
  // target_section_kind values are legal).
  for (const kind of SECTION_KINDS) {
    assert.ok(p.system.includes(kind), `system prompt mentions ${kind}`);
  }
});

test('tool schema accepts a valid prose segment', () => {
  const parsed = draftNarrativeToolSchema.parse({
    section_kind: 'hypothesis',
    segment_index: 0,
    type: 'prose',
    text: 'Bridge into the regenerated hypothesis.',
  });
  assert.equal(parsed.type, 'prose');
});

test('tool schema accepts a valid claim segment with citing_events', () => {
  const parsed = draftNarrativeToolSchema.parse({
    section_kind: 'hypothesis',
    segment_index: 1,
    type: 'claim',
    text: 'The team hypothesised sample-efficient convergence below 1M timesteps.',
    citing_events: [VALID_UUID_A],
  });
  assert.equal(parsed.type, 'claim');
});

test('all four section_kind values are accepted on the tool schema', () => {
  for (const kind of SECTION_KINDS) {
    const parsed = draftNarrativeToolSchema.parse({
      section_kind: kind,
      segment_index: 0,
      type: 'prose',
      text: 'ok',
    });
    assert.equal(parsed.section_kind, kind);
  }
});

test('rejects claim missing citing_events', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'experiments_and_results',
    segment_index: 0,
    type: 'claim',
    text: 'A claim without citations.',
  });
  assert.equal(r.success, false);
});

test('rejects claim with empty citing_events', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'experiments_and_results',
    segment_index: 0,
    type: 'claim',
    text: 'A claim with empty citations.',
    citing_events: [],
  });
  assert.equal(r.success, false);
});

test('rejects prose with citing_events', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'uncertainty',
    segment_index: 0,
    type: 'prose',
    text: 'A bridge segment.',
    citing_events: [VALID_UUID_A],
  });
  assert.equal(r.success, false);
});

test('rejects invalid section_kind', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'rogue_section',
    segment_index: 0,
    type: 'prose',
    text: 'ok',
  });
  assert.equal(r.success, false);
});

test('rejects negative segment_index', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'new_knowledge',
    segment_index: -1,
    type: 'prose',
    text: 'ok',
  });
  assert.equal(r.success, false);
});

test('rejects empty text', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'new_knowledge',
    segment_index: 0,
    type: 'prose',
    text: '',
  });
  assert.equal(r.success, false);
});

test('rejects text longer than 2000 chars', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'new_knowledge',
    segment_index: 0,
    type: 'prose',
    text: 'x'.repeat(2001),
  });
  assert.equal(r.success, false);
});

test('rejects citing_events with a non-UUID entry', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'hypothesis',
    segment_index: 0,
    type: 'claim',
    text: 'A claim citing a malformed UUID.',
    citing_events: ['not-a-uuid'],
  });
  assert.equal(r.success, false);
});
