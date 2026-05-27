import type { SignupEvaluator, SignupEvaluatorInput, SignupEvaluatorOutput } from './types.js';

/**
 * Deterministic stub signup-evaluator for CI and local dev without an
 * ANTHROPIC_API_KEY.
 *
 * Permissive-bias decision tree (ordered, first match wins):
 *
 *   1. Obvious junk → deny:
 *      - firm name is all gibberish (no vowels, or single-token random alphabet)
 *      - email local-part is exactly 'test' / 'asdf' / 'user' / 'admin'
 *
 *   2. Uncertain → review:
 *      - firm name shorter than 3 chars (typo? truncation?)
 *      - generic firm name on a personal-email domain
 *
 *   3. Otherwise → approve.
 *
 * The thresholds are intentionally loose so tests can drive specific
 * branches via crafted inputs without needing an LLM. Production should
 * never run this code path; it exists for CI determinism + offline dev.
 */

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'yahoo.com.au',
  'hotmail.com',
  'hotmail.com.au',
  'outlook.com',
  'live.com',
  'icloud.com',
]);

const GENERIC_FIRM_NAMES = new Set([
  'test',
  'asdf',
  'firm',
  'company',
  'my firm',
  'my company',
  'consulting',
]);

const OBVIOUS_BAD_LOCALPARTS = new Set(['test', 'asdf', 'user', 'admin', 'fake']);

function looksLikeGibberish(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 3) return false; // handled by 'short' branch
  // No vowels at all in a >=4-char single-token name → very likely keyboard mash.
  // Stay narrow: only single-token (no spaces) so "Acme R&D" doesn't fire.
  if (!/\s/.test(trimmed) && trimmed.length >= 4 && !/[aeiouAEIOU]/.test(trimmed)) {
    return true;
  }
  // 5+ consonants in a row → keyboard mash even with a vowel elsewhere.
  if (/[bcdfghjklmnpqrstvwxyz]{5,}/i.test(trimmed)) return true;
  return false;
}

function emailLocalPart(email: string): string {
  return (email.split('@')[0] ?? '').toLowerCase();
}

function emailDomain(email: string): string {
  return (email.split('@')[1] ?? '').toLowerCase();
}

const PROMPT_VERSION = 'evaluate-signup@1.0.0';

export class StubSignupEvaluator implements SignupEvaluator {
  // eslint-disable-next-line @typescript-eslint/require-await
  async evaluate(input: SignupEvaluatorInput): Promise<SignupEvaluatorOutput> {
    const base = {
      model: 'stub-signup-evaluator-v1.0.0',
      prompt_version: PROMPT_VERSION,
      tokens_in: 0,
      tokens_out: 0,
    };

    const localPart = emailLocalPart(input.email);
    const domain = emailDomain(input.email);
    const firmTrim = input.firm_name.trim();

    // 1. Obvious junk → deny.
    if (OBVIOUS_BAD_LOCALPARTS.has(localPart) && GENERIC_FIRM_NAMES.has(firmTrim.toLowerCase())) {
      return {
        ...base,
        decision: 'deny',
        confidence: 0.85,
        rationale: 'Stub: generic local-part + generic firm name pattern',
        red_flags: ['generic email local-part', 'generic firm name'],
      };
    }
    if (looksLikeGibberish(firmTrim)) {
      return {
        ...base,
        decision: 'deny',
        confidence: 0.8,
        rationale: 'Stub: firm name appears to be keyboard mash',
        red_flags: ['firm name has no vowels or 5+ consecutive consonants'],
      };
    }

    // 2. Uncertain → review.
    if (firmTrim.length < 3) {
      return {
        ...base,
        decision: 'review',
        confidence: 0.55,
        rationale: 'Stub: firm name shorter than 3 characters',
        red_flags: ['firm name too short'],
      };
    }
    if (PERSONAL_EMAIL_DOMAINS.has(domain) && GENERIC_FIRM_NAMES.has(firmTrim.toLowerCase())) {
      return {
        ...base,
        decision: 'review',
        confidence: 0.6,
        rationale: 'Stub: personal-email domain with generic firm name',
        red_flags: ['personal-email domain', 'generic firm name'],
      };
    }

    // 3. Default → approve.
    return {
      ...base,
      decision: 'approve',
      confidence: 0.7,
      rationale: 'Stub: signup looks plausibly legitimate',
      red_flags: [],
    };
  }
}
