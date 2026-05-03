import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getPrompt, listPrompts } from '../../runtime/prompt-registry.js';
import { SECTION_KINDS } from '../types.js';
// Import for side-effect: register both v1.0.0 (backward-compat assertion)
// and v1.1.0 (this version).
import {
  PROMPT_VERSION as V1_1_0_VERSION,
  SYSTEM_PROMPT as V1_1_0_SYSTEM_PROMPT,
  draftNarrativeInputSchema,
  draftNarrativeToolSchema,
} from './draft-narrative@1.1.0.js';
import * as v1_0_0 from './draft-narrative@1.0.0.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

/* ------------------------------------------------------------------ */
/* Spec test (a) — prior_fy_context is OPTIONAL                        */
/* ------------------------------------------------------------------ */

test('v1.1.0 input schema accepts an input WITHOUT prior_fy_context (single-FY drafts)', () => {
  // Single-FY drafts (the FY24 first-time case) have no prior context.
  // The schema must accept that and remain backward-compatible-shaped.
  const result = draftNarrativeInputSchema.safeParse({
    activity: { name: 'X', kind: 'core' },
    clustered_events: [],
  });
  assert.equal(result.success, true);
});

test('v1.1.0 input schema accepts an input WITH prior_fy_context', () => {
  const result = draftNarrativeInputSchema.safeParse({
    activity: { name: 'X', kind: 'core' },
    clustered_events: [],
    prior_fy_context: {
      proposed_id: VALID_UUID,
      prior_fys: [
        {
          fy_label: 'FY24',
          hypothesis_segment_excerpts: ['FY24 hypothesis verbatim.'],
          design_segment_excerpts: ['FY24 design verbatim.'],
          transition_classification: 'continuation',
        },
      ],
    },
  });
  assert.equal(result.success, true);
});

/* ------------------------------------------------------------------ */
/* Spec test (b) — system prompt references prior_fy_context AND       */
/*                  carries an explicit consistency mandate.           */
/* ------------------------------------------------------------------ */

test('v1.1.0 system prompt explicitly references prior_fy_context', () => {
  assert.match(V1_1_0_SYSTEM_PROMPT, /prior_fy_context/);
});

test('v1.1.0 system prompt mentions design_segment_excerpts and hypothesis_segment_excerpts (Q-Map=A)', () => {
  assert.match(V1_1_0_SYSTEM_PROMPT, /design_segment_excerpts/);
  assert.match(V1_1_0_SYSTEM_PROMPT, /hypothesis_segment_excerpts/);
  // The Q-Map=A binding must be documented in the prompt itself so
  // the model understands the design-doc field name maps to
  // experiments_and_results in the codebase.
  assert.match(V1_1_0_SYSTEM_PROMPT, /experiments_and_results/);
});

test('v1.1.0 system prompt carries an explicit consistency mandate', () => {
  // Both halves of the consistency-mandate contract:
  //   1. consistency / consistent language
  //   2. explicit instruction to flag contradictions in
  //      consultant_review_notes
  assert.match(V1_1_0_SYSTEM_PROMPT, /consisten/i);
  assert.match(V1_1_0_SYSTEM_PROMPT, /consultant_review_notes/);
  // Defence-in-depth: the prompt also instructs the model NOT to
  // paraphrase or quote prior-year text.
  assert.match(V1_1_0_SYSTEM_PROMPT, /not\s+(quote|paraphrase)/i);
});

/* ------------------------------------------------------------------ */
/* Spec test (c) — v1.0.0 still importable for backward-compat        */
/* ------------------------------------------------------------------ */

test('v1.0.0 module remains importable and untouched', () => {
  // Backward compat: existing FY24 narratives reference v1.0.0 — it
  // MUST remain registered and importable. The v1.0.0 module exports
  // SYSTEM_PROMPT and draftNarrativeToolSchema; verify both surface.
  assert.ok(typeof v1_0_0.SYSTEM_PROMPT === 'string');
  assert.ok(v1_0_0.SYSTEM_PROMPT.length > 0);
  assert.ok(v1_0_0.draftNarrativeToolSchema, 'v1.0.0 must still export draftNarrativeToolSchema');
});

/* ------------------------------------------------------------------ */
/* Happy path with prior_fy_context — shape verification              */
/* ------------------------------------------------------------------ */

test('v1.1.0 input schema preserves prior_fy_context shape after parse', () => {
  const ctx = {
    proposed_id: VALID_UUID,
    prior_fys: [
      {
        fy_label: 'FY24',
        hypothesis_segment_excerpts: ['h0', 'h1'],
        design_segment_excerpts: ['d0'],
        transition_classification: 'pivot',
      },
      {
        fy_label: 'FY25',
        hypothesis_segment_excerpts: [],
        design_segment_excerpts: [],
        transition_classification: null,
      },
    ],
  };
  const parsed = draftNarrativeInputSchema.parse({
    clustered_events: [],
    prior_fy_context: ctx,
  });
  assert.deepEqual(parsed.prior_fy_context, ctx);
});

test('v1.1.0 input rejects an invalid prior_fy_context (bad fy_label format)', () => {
  const result = draftNarrativeInputSchema.safeParse({
    clustered_events: [],
    prior_fy_context: {
      proposed_id: VALID_UUID,
      prior_fys: [
        {
          fy_label: 'FY2024', // four-digit form rejected
          hypothesis_segment_excerpts: [],
          design_segment_excerpts: [],
          transition_classification: null,
        },
      ],
    },
  });
  assert.equal(result.success, false);
});

/* ------------------------------------------------------------------ */
/* Schema strictness — extra fields rejected on prior_fy_context       */
/* ------------------------------------------------------------------ */

test('v1.1.0 input rejects extra fields inside prior_fy_context (.strict on the block)', () => {
  const result = draftNarrativeInputSchema.safeParse({
    clustered_events: [],
    prior_fy_context: {
      proposed_id: VALID_UUID,
      prior_fys: [],
      rogue_field: 'oops',
    },
  });
  assert.equal(result.success, false);
});

test('v1.1.0 input rejects empty-string entries in hypothesis_segment_excerpts', () => {
  // Empty-text guard: a corrupted/in-progress prior-FY draft with
  // narrative_segment.text = '' must NOT silently leak in. The schema
  // tightens the inner string to .min(1).
  const result = draftNarrativeInputSchema.safeParse({
    clustered_events: [],
    prior_fy_context: {
      proposed_id: VALID_UUID,
      prior_fys: [
        {
          fy_label: 'FY24',
          hypothesis_segment_excerpts: [''],
          design_segment_excerpts: [],
          transition_classification: null,
        },
      ],
    },
  });
  assert.equal(result.success, false);
});

test('v1.1.0 input rejects empty-string entries in design_segment_excerpts', () => {
  // Q-Map=A binding parity: same empty-text guard on the design side.
  const result = draftNarrativeInputSchema.safeParse({
    clustered_events: [],
    prior_fy_context: {
      proposed_id: VALID_UUID,
      prior_fys: [
        {
          fy_label: 'FY24',
          hypothesis_segment_excerpts: [],
          design_segment_excerpts: [''],
          transition_classification: null,
        },
      ],
    },
  });
  assert.equal(result.success, false);
});

test('v1.1.0 input rejects extra fields inside a prior_fys[] entry (.strict on entry)', () => {
  const result = draftNarrativeInputSchema.safeParse({
    clustered_events: [],
    prior_fy_context: {
      proposed_id: VALID_UUID,
      prior_fys: [
        {
          fy_label: 'FY24',
          hypothesis_segment_excerpts: [],
          design_segment_excerpts: [],
          transition_classification: null,
          rogue_field: 'oops',
        },
      ],
    },
  });
  assert.equal(result.success, false);
});

/* ------------------------------------------------------------------ */
/* Registry — v1.1.0 is a DISTINCT entry from v1.0.0                   */
/* ------------------------------------------------------------------ */

test('registry contains both draft-narrative@1.0.0 and draft-narrative@1.1.0', () => {
  const keys = listPrompts();
  assert.ok(
    keys.includes('draft-narrative@1.0.0'),
    `expected v1.0.0 in registry, got ${keys.join(', ')}`,
  );
  assert.ok(
    keys.includes('draft-narrative@1.1.0'),
    `expected v1.1.0 in registry, got ${keys.join(', ')}`,
  );
});

test('getPrompt returns DISTINCT entries for v1.0.0 and v1.1.0', () => {
  const v100 = getPrompt('draft-narrative@1.0.0');
  const v110 = getPrompt('draft-narrative@1.1.0');
  assert.equal(v100.version, '1.0.0');
  assert.equal(v110.version, '1.1.0');
  assert.equal(V1_1_0_VERSION, '1.1.0');
  // Both register under the same name and tool name (the wire-format
  // emit_segment shape is unchanged) but DIFFERENT system prompts.
  assert.equal(v100.name, v110.name);
  assert.equal(v100.tool.name, v110.tool.name);
  assert.notEqual(v100.system, v110.system);
});

/* ------------------------------------------------------------------ */
/* Tool schema — same as v1.0.0 (wire shape is unchanged)              */
/* ------------------------------------------------------------------ */

test('v1.1.0 emits via the same emit_segment tool schema as v1.0.0 (wire shape unchanged)', () => {
  // Defence-in-depth: the wire-format tool schema is shared, so a
  // v1.1.0 segment payload must validate against the same schema.
  const parsed = draftNarrativeToolSchema.parse({
    section_kind: 'hypothesis',
    segment_index: 0,
    type: 'prose',
    text: 'A prose bridge.',
  });
  assert.equal(parsed.type, 'prose');

  // Sanity-check: the prompt mentions all four sections, just like
  // v1.0.0 — multi-cycle context is additive, not replacing the
  // four-section emit protocol.
  for (const kind of SECTION_KINDS) {
    assert.ok(V1_1_0_SYSTEM_PROMPT.includes(kind), `v1.1.0 system prompt mentions ${kind}`);
  }
});

/* ------------------------------------------------------------------ */
/* Reference to randomUUID just to anchor it as imported (silences a   */
/* TS6133 if the harness ever switches to noUnusedLocals); some tests  */
/* import randomUUID for fixture parity with sibling test files.       */
/* ------------------------------------------------------------------ */
test('test scaffolding sanity — randomUUID is callable', () => {
  assert.equal(typeof randomUUID(), 'string');
});
