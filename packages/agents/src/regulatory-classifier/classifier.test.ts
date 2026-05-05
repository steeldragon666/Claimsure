import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RegulatoryClassification } from './prompts/regulatory-classify@1.0.0.js';

/**
 * D.10 -- regulatory-classify@1.0.0 tests.
 *
 * Unit tests for the Zod schema validation. The full API integration
 * test requires an Anthropic API key and is gated on CI_ANTHROPIC_KEY.
 */

describe('RegulatoryClassification schema', () => {
  test('accepts a valid classification', () => {
    const valid = {
      event_id: '00000000-0000-4000-8000-000000000001',
      classification_kind: 'tax_alert',
      severity: 'high',
      affects_prompt_modules: ['draft-narrative@1.1.0'],
      affects_compliance_fields: ['rd_forecast.projected_spend_aud'],
      precedent_strength: 'informational',
      retroactive: false,
      summary:
        'ATO issues new guidance on R&D expenditure categorisation affecting forecast requirements for FY25 and beyond, requiring updated spend projections.',
      prompt_version: '1.0.0',
      model: 'claude-sonnet-4-5-20250514',
    };
    const result = RegulatoryClassification.safeParse(valid);
    assert.equal(result.success, true);
  });

  test('rejects missing event_id', () => {
    const invalid = {
      classification_kind: 'tax_alert',
      severity: 'high',
      affects_prompt_modules: [],
      affects_compliance_fields: [],
      precedent_strength: 'informational',
      retroactive: false,
      summary: 'A'.repeat(50),
      prompt_version: '1.0.0',
      model: 'test',
    };
    const result = RegulatoryClassification.safeParse(invalid);
    assert.equal(result.success, false);
  });

  test('rejects invalid classification_kind', () => {
    const invalid = {
      event_id: '00000000-0000-4000-8000-000000000001',
      classification_kind: 'not_a_valid_kind',
      severity: 'high',
      affects_prompt_modules: [],
      affects_compliance_fields: [],
      precedent_strength: 'informational',
      retroactive: false,
      summary: 'A'.repeat(50),
      prompt_version: '1.0.0',
      model: 'test',
    };
    const result = RegulatoryClassification.safeParse(invalid);
    assert.equal(result.success, false);
  });

  test('rejects invalid severity', () => {
    const invalid = {
      event_id: '00000000-0000-4000-8000-000000000001',
      classification_kind: 'pcg',
      severity: 'critical',
      affects_prompt_modules: [],
      affects_compliance_fields: [],
      precedent_strength: 'binding',
      retroactive: true,
      summary: 'A'.repeat(50),
      prompt_version: '1.0.0',
      model: 'test',
    };
    const result = RegulatoryClassification.safeParse(invalid);
    assert.equal(result.success, false);
  });

  test('rejects summary below min_chars (50)', () => {
    const invalid = {
      event_id: '00000000-0000-4000-8000-000000000001',
      classification_kind: 'aat_decision',
      severity: 'medium',
      affects_prompt_modules: [],
      affects_compliance_fields: [],
      precedent_strength: 'persuasive',
      retroactive: false,
      summary: 'Too short',
      prompt_version: '1.0.0',
      model: 'test',
    };
    const result = RegulatoryClassification.safeParse(invalid);
    assert.equal(result.success, false);
  });

  test('rejects summary above max_chars (800)', () => {
    const invalid = {
      event_id: '00000000-0000-4000-8000-000000000001',
      classification_kind: 'art_decision',
      severity: 'low',
      affects_prompt_modules: [],
      affects_compliance_fields: [],
      precedent_strength: 'persuasive',
      retroactive: false,
      summary: 'A'.repeat(801),
      prompt_version: '1.0.0',
      model: 'test',
    };
    const result = RegulatoryClassification.safeParse(invalid);
    assert.equal(result.success, false);
  });

  test('rejects wrong prompt_version', () => {
    const invalid = {
      event_id: '00000000-0000-4000-8000-000000000001',
      classification_kind: 'form_change',
      severity: 'informational',
      affects_prompt_modules: [],
      affects_compliance_fields: [],
      precedent_strength: 'not_applicable',
      retroactive: false,
      summary: 'A'.repeat(50),
      prompt_version: '2.0.0',
      model: 'test',
    };
    const result = RegulatoryClassification.safeParse(invalid);
    assert.equal(result.success, false);
  });

  test('accepts all valid classification_kind values', () => {
    const kinds = [
      'tax_alert',
      'pcg',
      'public_ruling',
      'disr_program_change',
      'form_change',
      'aat_decision',
      'art_decision',
      'isa_finding',
      'industry_guidance',
      'asx_disclosure',
      'other',
    ];
    for (const kind of kinds) {
      const obj = {
        event_id: '00000000-0000-4000-8000-000000000001',
        classification_kind: kind,
        severity: 'low',
        affects_prompt_modules: [],
        affects_compliance_fields: [],
        precedent_strength: 'informational',
        retroactive: false,
        summary: 'A'.repeat(50),
        prompt_version: '1.0.0',
        model: 'test',
      };
      const result = RegulatoryClassification.safeParse(obj);
      assert.equal(result.success, true, `Expected '${kind}' to be accepted`);
    }
  });

  test('accepts all valid precedent_strength values', () => {
    const strengths = ['binding', 'persuasive', 'informational', 'not_applicable'];
    for (const strength of strengths) {
      const obj = {
        event_id: '00000000-0000-4000-8000-000000000001',
        classification_kind: 'other',
        severity: 'low',
        affects_prompt_modules: [],
        affects_compliance_fields: [],
        precedent_strength: strength,
        retroactive: false,
        summary: 'A'.repeat(50),
        prompt_version: '1.0.0',
        model: 'test',
      };
      const result = RegulatoryClassification.safeParse(obj);
      assert.equal(result.success, true, `Expected '${strength}' to be accepted`);
    }
  });
});
