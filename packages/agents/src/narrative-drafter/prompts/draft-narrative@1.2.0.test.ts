import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getPrompt, listPrompts } from '../../runtime/prompt-registry.js';
// Import for side-effect: register v1.0.0, v1.1.0, and v1.2.0.
import {
  PROMPT_VERSION as V1_2_0_VERSION,
  SYSTEM_PROMPT as V1_2_0_SYSTEM_PROMPT,
  draftNarrativeInputSchema,
  emitPortalFieldsToolSchema,
  EMIT_PORTAL_FIELDS_TOOL_NAME,
} from './draft-narrative@1.2.0.js';
import * as v1_1_0 from './draft-narrative@1.1.0.js';
import * as v1_0_0 from './draft-narrative@1.0.0.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

/* ------------------------------------------------------------------ */
/* Spec test (a) — v1.2.0 input schema                                */
/* ------------------------------------------------------------------ */

test('v1.2.0 input schema accepts core activity_kind', () => {
  const result = draftNarrativeInputSchema.safeParse({
    activity_kind: 'core',
    clustered_events: [],
  });
  assert.equal(result.success, true);
});

test('v1.2.0 input schema accepts supporting activity_kind', () => {
  const result = draftNarrativeInputSchema.safeParse({
    activity_kind: 'supporting',
    clustered_events: [],
  });
  assert.equal(result.success, true);
});

test('v1.2.0 input schema accepts prior_fy_context (optional)', () => {
  const result = draftNarrativeInputSchema.safeParse({
    activity_kind: 'core',
    clustered_events: [],
    prior_fy_context: {
      proposed_id: VALID_UUID,
      prior_fys: [
        {
          fy_label: 'FY24',
          hypothesis_segment_excerpts: ['h0'],
          design_segment_excerpts: ['d0'],
          transition_classification: 'continuation',
        },
      ],
    },
  });
  assert.equal(result.success, true);
});

/* ------------------------------------------------------------------ */
/* Spec test (b) — emit_portal_fields tool schema: core (13 fields)   */
/* ------------------------------------------------------------------ */

test('v1.2.0 tool schema accepts valid core portal fields (all 13)', () => {
  const valid = {
    activity_kind: 'core',
    fields: {
      activity_name: 'Test core activity',
      description: 'A detailed description of the core R&D activity.',
      outcome_unknown_methods: ['no_applicable_literature', 'expert_advice'],
      sources_investigated: 'Literature review of published papers.',
      why_competent_professional_couldnt_know: 'No published method achieves this.',
      hypothesis: 'The team hypothesised that X would lead to Y.',
      experiment: 'A controlled experiment was conducted.',
      evaluation: 'Results were evaluated against the hypothesis.',
      conclusions: 'The hypothesis was partially supported.',
      evidence_kept_categories: ['hypothesis_design', 'results_evaluation'],
      new_knowledge_purpose: 'To fill the gap in understanding of X.',
      expenditure_estimate_aud: 250000,
      related_supporting_activity_ids: [],
    },
  };
  assert.doesNotThrow(() => emitPortalFieldsToolSchema.parse(valid));
});

test('v1.2.0 tool schema rejects core fields with description exceeding 4000 chars', () => {
  const invalid = {
    activity_kind: 'core',
    fields: {
      activity_name: 'X',
      description: 'a'.repeat(4001),
      outcome_unknown_methods: ['no_applicable_literature'],
      sources_investigated: 'a',
      why_competent_professional_couldnt_know: 'a',
      hypothesis: 'a',
      experiment: 'a',
      evaluation: 'a',
      conclusions: 'a',
      evidence_kept_categories: ['hypothesis_design'],
      new_knowledge_purpose: 'a',
      expenditure_estimate_aud: 0,
      related_supporting_activity_ids: [],
    },
  };
  assert.throws(() => emitPortalFieldsToolSchema.parse(invalid));
});

/* ------------------------------------------------------------------ */
/* Spec test (c) — emit_portal_fields tool schema: supporting (9)     */
/* ------------------------------------------------------------------ */

test('v1.2.0 tool schema accepts valid supporting portal fields (all 9)', () => {
  const valid = {
    activity_kind: 'supporting',
    fields: {
      activity_name: 'Test supporting activity',
      description: 'Supporting activity description.',
      supports_core_activity_ids: [VALID_UUID],
      how_supports_core_rd: 'Directly supports by providing data.',
      who_performed_work: 'r_and_d_company_only',
      dates_conducted: { start: '2024-07-01', end: '2025-06-30' },
      expenditure_estimate_aud: 100000,
      produces_good_or_service: false,
      dominant_purpose: {
        is_dominant_purpose: true,
        explanation: 'Primary purpose is R&D support.',
      },
      evidence_kept: 'Lab notebooks and test results.',
    },
  };
  assert.doesNotThrow(() => emitPortalFieldsToolSchema.parse(valid));
});

test('v1.2.0 tool schema rejects supporting fields with empty supports_core_activity_ids', () => {
  const invalid = {
    activity_kind: 'supporting',
    fields: {
      activity_name: 'X',
      description: 'a',
      supports_core_activity_ids: [],
      how_supports_core_rd: 'a',
      who_performed_work: 'r_and_d_company_only',
      dates_conducted: { start: '2024-07-01', end: '2025-06-30' },
      expenditure_estimate_aud: 0,
      produces_good_or_service: false,
      dominant_purpose: { is_dominant_purpose: true, explanation: 'a' },
      evidence_kept: 'a',
    },
  };
  assert.throws(() => emitPortalFieldsToolSchema.parse(invalid));
});

/* ------------------------------------------------------------------ */
/* Spec test (d) — system prompt covers portal field structure         */
/* ------------------------------------------------------------------ */

test('v1.2.0 system prompt references emit_portal_fields', () => {
  assert.match(V1_2_0_SYSTEM_PROMPT, /emit_portal_fields/);
});

test('v1.2.0 system prompt documents all 13 core fields', () => {
  const coreFields = [
    'activity_name',
    'description',
    'outcome_unknown_methods',
    'sources_investigated',
    'why_competent_professional_couldnt_know',
    'hypothesis',
    'experiment',
    'evaluation',
    'conclusions',
    'evidence_kept_categories',
    'new_knowledge_purpose',
    'expenditure_estimate_aud',
    'related_supporting_activity_ids',
  ];
  for (const field of coreFields) {
    assert.ok(
      V1_2_0_SYSTEM_PROMPT.includes(field),
      `system prompt must document core field: ${field}`,
    );
  }
});

test('v1.2.0 system prompt documents all 9 supporting fields', () => {
  const supportingFields = [
    'supports_core_activity_ids',
    'how_supports_core_rd',
    'who_performed_work',
    'dates_conducted',
    'produces_good_or_service',
    'dominant_purpose',
    'evidence_kept',
  ];
  for (const field of supportingFields) {
    assert.ok(
      V1_2_0_SYSTEM_PROMPT.includes(field),
      `system prompt must document supporting field: ${field}`,
    );
  }
});

test('v1.2.0 system prompt mentions 4000-char and 200-char limits', () => {
  assert.match(V1_2_0_SYSTEM_PROMPT, /4000/);
  assert.match(V1_2_0_SYSTEM_PROMPT, /200/);
});

test('v1.2.0 system prompt mentions multi-cycle context', () => {
  assert.match(V1_2_0_SYSTEM_PROMPT, /prior_fy_context/);
});

/* ------------------------------------------------------------------ */
/* Spec test (e) — backward compatibility: v1.0.0 + v1.1.0 untouched */
/* ------------------------------------------------------------------ */

test('v1.0.0 module remains importable and untouched', () => {
  assert.ok(typeof v1_0_0.SYSTEM_PROMPT === 'string');
  assert.ok(v1_0_0.SYSTEM_PROMPT.length > 0);
});

test('v1.1.0 module remains importable and untouched', () => {
  assert.ok(typeof v1_1_0.SYSTEM_PROMPT === 'string');
  assert.ok(v1_1_0.SYSTEM_PROMPT.length > 0);
});

/* ------------------------------------------------------------------ */
/* Registry — all three versions registered                           */
/* ------------------------------------------------------------------ */

test('registry contains draft-narrative@1.0.0, @1.1.0, and @1.2.0', () => {
  const keys = listPrompts();
  assert.ok(keys.includes('draft-narrative@1.0.0'), `missing v1.0.0, got ${keys.join(', ')}`);
  assert.ok(keys.includes('draft-narrative@1.1.0'), `missing v1.1.0, got ${keys.join(', ')}`);
  assert.ok(keys.includes('draft-narrative@1.2.0'), `missing v1.2.0, got ${keys.join(', ')}`);
});

test('getPrompt returns v1.2.0 with emit_portal_fields tool', () => {
  const v120 = getPrompt('draft-narrative@1.2.0');
  assert.equal(v120.version, '1.2.0');
  assert.equal(v120.name, 'draft-narrative');
  assert.equal(v120.tool.name, EMIT_PORTAL_FIELDS_TOOL_NAME);
});

test('v1.2.0 tool name differs from v1.1.0 (different output protocol)', () => {
  const v110 = getPrompt('draft-narrative@1.1.0');
  const v120 = getPrompt('draft-narrative@1.2.0');
  assert.notEqual(v110.tool.name, v120.tool.name);
});

/* ------------------------------------------------------------------ */
/* Scaffolding sanity                                                  */
/* ------------------------------------------------------------------ */

test('v1.2.0 version constant is 1.2.0', () => {
  assert.equal(V1_2_0_VERSION, '1.2.0');
});

test('test scaffolding sanity — randomUUID is callable', () => {
  assert.equal(typeof randomUUID(), 'string');
});
