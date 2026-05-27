import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signFounderApproveToken, verifyFounderApproveToken } from './founder-override-token.js';

const SECRET = 'test-founder-override-secret-32+bytes-of-entropy-here!!';
const DECISION_ID = '11111111-1111-1111-1111-111111111111';
const EMAIL = 'applicant@example.com';

test('signFounderApproveToken: sign + verify round-trip', () => {
  const token = signFounderApproveToken({
    decisionId: DECISION_ID,
    applicantEmail: EMAIL,
    secret: SECRET,
  });
  assert.ok(token.length > 0, 'token must be non-empty');
  assert.equal(
    verifyFounderApproveToken({
      token,
      decisionId: DECISION_ID,
      applicantEmail: EMAIL,
      secret: SECRET,
    }),
    true,
  );
});

test('signFounderApproveToken: deterministic — same input yields same token', () => {
  const a = signFounderApproveToken({
    decisionId: DECISION_ID,
    applicantEmail: EMAIL,
    secret: SECRET,
  });
  const b = signFounderApproveToken({
    decisionId: DECISION_ID,
    applicantEmail: EMAIL,
    secret: SECRET,
  });
  assert.equal(a, b);
});

test('verifyFounderApproveToken: rejects a tampered token', () => {
  const token = signFounderApproveToken({
    decisionId: DECISION_ID,
    applicantEmail: EMAIL,
    secret: SECRET,
  });
  // Flip a character somewhere in the middle — same length, different bytes.
  const mid = Math.floor(token.length / 2);
  const flipped = token[mid] === 'a' ? 'b' : 'a';
  const tampered = token.slice(0, mid) + flipped + token.slice(mid + 1);
  assert.equal(
    verifyFounderApproveToken({
      token: tampered,
      decisionId: DECISION_ID,
      applicantEmail: EMAIL,
      secret: SECRET,
    }),
    false,
  );
});

test('verifyFounderApproveToken: rejects a token signed with a different secret', () => {
  const token = signFounderApproveToken({
    decisionId: DECISION_ID,
    applicantEmail: EMAIL,
    secret: 'a-completely-different-secret-also-32+bytes-long!!',
  });
  assert.equal(
    verifyFounderApproveToken({
      token,
      decisionId: DECISION_ID,
      applicantEmail: EMAIL,
      secret: SECRET,
    }),
    false,
  );
});

test('verifyFounderApproveToken: rejects when decisionId differs', () => {
  const token = signFounderApproveToken({
    decisionId: DECISION_ID,
    applicantEmail: EMAIL,
    secret: SECRET,
  });
  assert.equal(
    verifyFounderApproveToken({
      token,
      decisionId: '22222222-2222-2222-2222-222222222222',
      applicantEmail: EMAIL,
      secret: SECRET,
    }),
    false,
  );
});

test('verifyFounderApproveToken: rejects when applicantEmail differs', () => {
  const token = signFounderApproveToken({
    decisionId: DECISION_ID,
    applicantEmail: EMAIL,
    secret: SECRET,
  });
  assert.equal(
    verifyFounderApproveToken({
      token,
      decisionId: DECISION_ID,
      applicantEmail: 'different@example.com',
      secret: SECRET,
    }),
    false,
  );
});

test('verifyFounderApproveToken: rejects an empty token', () => {
  assert.equal(
    verifyFounderApproveToken({
      token: '',
      decisionId: DECISION_ID,
      applicantEmail: EMAIL,
      secret: SECRET,
    }),
    false,
  );
});

test('verifyFounderApproveToken: rejects a wrong-length token without throwing', () => {
  // A short string can't pass timingSafeEqual (which requires equal lengths).
  // The wrapper must check length non-secretly first.
  assert.doesNotThrow(() => {
    verifyFounderApproveToken({
      token: 'tooshort',
      decisionId: DECISION_ID,
      applicantEmail: EMAIL,
      secret: SECRET,
    });
  });
});

test('signFounderApproveToken: applicant email is case-insensitive', () => {
  const lower = signFounderApproveToken({
    decisionId: DECISION_ID,
    applicantEmail: 'applicant@example.com',
    secret: SECRET,
  });
  const upper = signFounderApproveToken({
    decisionId: DECISION_ID,
    applicantEmail: 'APPLICANT@example.com',
    secret: SECRET,
  });
  assert.equal(lower, upper);
});

test('signFounderApproveToken: empty secret throws', () => {
  assert.throws(() => {
    signFounderApproveToken({
      decisionId: DECISION_ID,
      applicantEmail: EMAIL,
      secret: '',
    });
  });
});
