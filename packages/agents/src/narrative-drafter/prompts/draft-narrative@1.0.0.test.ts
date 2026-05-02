import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrompt } from '../../runtime/prompt-registry.js';
import { SECTION_KINDS } from '../types.js';
// Import for side-effect: register the prompt.
import { draftNarrativeToolSchema } from './draft-narrative@1.0.0.js';

const VALID_UUID_A = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_B = '22222222-2222-4222-8222-222222222222';

test('draft-narrative@1.0.0 is registered with the emit_segment tool', () => {
  const p = getPrompt('draft-narrative@1.0.0');
  assert.equal(p.name, 'draft-narrative');
  assert.equal(p.version, '1.0.0');
  assert.equal(p.tool.name, 'emit_segment');
  assert.ok(p.system.length > 0, 'system prompt must be non-empty');
  // Sanity-check: the prompt mentions all four sections.
  for (const kind of SECTION_KINDS) {
    assert.ok(p.system.includes(kind), `system prompt mentions ${kind}`);
  }
});

test('tool schema accepts a valid prose segment (no citing_events)', () => {
  const parsed = draftNarrativeToolSchema.parse({
    section_kind: 'new_knowledge',
    segment_index: 0,
    type: 'prose',
    text: 'Under s.355-25(1)(a), an activity must seek new knowledge.',
  });
  assert.equal(parsed.type, 'prose');
});

test('tool schema accepts a valid claim segment (with citing_events)', () => {
  const parsed = draftNarrativeToolSchema.parse({
    section_kind: 'experiments_and_results',
    segment_index: 3,
    type: 'claim',
    text: 'The team observed convergence at 0.8M timesteps.',
    citing_events: [VALID_UUID_A, VALID_UUID_B],
  });
  assert.equal(parsed.type, 'claim');
  if (parsed.type === 'claim') {
    assert.deepEqual(parsed.citing_events, [VALID_UUID_A, VALID_UUID_B]);
  }
});

test('all four section_kind values are accepted', () => {
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
    section_kind: 'hypothesis',
    segment_index: 0,
    type: 'claim',
    text: 'A factual claim without citations.',
  });
  assert.equal(r.success, false);
});

test('rejects claim with empty citing_events array', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'hypothesis',
    segment_index: 0,
    type: 'claim',
    text: 'A factual claim with an empty citation list.',
    citing_events: [],
  });
  assert.equal(r.success, false);
});

test('rejects prose with citing_events (strict variant excludes the field)', () => {
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
    section_kind: 'not_a_real_section',
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

test('rejects non-integer segment_index', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'new_knowledge',
    segment_index: 1.5,
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
    text: 'a'.repeat(2001),
  });
  assert.equal(r.success, false);
});

test('accepts text exactly 2000 chars', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'new_knowledge',
    segment_index: 0,
    type: 'prose',
    text: 'a'.repeat(2000),
  });
  assert.equal(r.success, true);
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

test('rejects unknown extra fields (.strict)', () => {
  const r = draftNarrativeToolSchema.safeParse({
    section_kind: 'new_knowledge',
    segment_index: 0,
    type: 'prose',
    text: 'ok',
    rogue_field: 'oops',
  });
  assert.equal(r.success, false);
});
