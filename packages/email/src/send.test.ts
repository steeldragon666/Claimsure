import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableError, withRetry } from './client.js';
import { RateLimiter } from './send.js';
import { welcomeEmail } from './templates/welcome.js';
import { inviteEmail } from './templates/invite.js';
import { magicLinkEmail } from './templates/magic-link.js';
import { claimStatusEmail } from './templates/claim-status.js';

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe('isRetryableError', () => {
  test('returns true for 429 (rate limit)', () => {
    assert.equal(isRetryableError({ statusCode: 429 }), true);
  });

  test('returns true for 500 (server error)', () => {
    assert.equal(isRetryableError({ statusCode: 500 }), true);
  });

  test('returns true for 502 (bad gateway)', () => {
    assert.equal(isRetryableError({ statusCode: 502 }), true);
  });

  test('returns false for 400 (client error)', () => {
    assert.equal(isRetryableError({ statusCode: 400 }), false);
  });

  test('returns false for 401 (unauthorized)', () => {
    assert.equal(isRetryableError({ statusCode: 401 }), false);
  });

  test('returns false for 422 (validation)', () => {
    assert.equal(isRetryableError({ statusCode: 422 }), false);
  });

  test('returns true for FetchError (network)', () => {
    assert.equal(isRetryableError({ name: 'FetchError' }), true);
  });

  test('returns true for TypeError (network)', () => {
    assert.equal(isRetryableError({ name: 'TypeError' }), true);
  });

  test('returns false for null', () => {
    assert.equal(isRetryableError(null), false);
  });

  test('returns false for undefined', () => {
    assert.equal(isRetryableError(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  test('returns result on first success', async () => {
    const result = await withRetry(() => Promise.resolve('ok'), 3, 1);
    assert.equal(result, 'ok');
  });

  test('retries on retryable error and succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('rate limited') as Error & { statusCode: number };
          err.statusCode = 429;
          throw err;
        }
        return Promise.resolve('recovered');
      },
      3,
      1, // 1ms delay for test speed
    );
    assert.equal(result, 'recovered');
    assert.equal(attempts, 3);
  });

  test('throws immediately on non-retryable error', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withRetry(
          () => {
            attempts++;
            const err = new Error('bad request') as Error & { statusCode: number };
            err.statusCode = 400;
            throw err;
          },
          3,
          1,
        ),
      { message: 'bad request' },
    );
    assert.equal(attempts, 1, 'should not retry on 400');
  });

  test('throws after exhausting retries', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withRetry(
          () => {
            attempts++;
            const err = new Error('server error') as Error & { statusCode: number };
            err.statusCode = 500;
            throw err;
          },
          2,
          1,
        ),
      { message: 'server error' },
    );
    assert.equal(attempts, 3, 'initial + 2 retries');
  });
});

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  test('allows burst up to maxPerSecond', async () => {
    const limiter = new RateLimiter(5);
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    const elapsed = Date.now() - start;
    // All 5 should complete nearly instantly (well under 100ms)
    assert.ok(elapsed < 100, `burst took ${elapsed}ms, expected < 100ms`);
  });
});

// ---------------------------------------------------------------------------
// Template smoke tests — verify structure, not pixel-perfect rendering
// ---------------------------------------------------------------------------

describe('welcomeEmail template', () => {
  test('produces subject, html, and text', () => {
    const result = welcomeEmail({
      name: 'Jane',
      firmName: 'Acme R&D',
      dashboardUrl: 'https://app.cpaplatform.com',
    });
    assert.ok(result.subject.includes('Jane'));
    assert.ok(result.html.includes('Jane'));
    assert.ok(result.html.includes('Acme R&amp;D'));
    assert.ok(result.text.includes('Acme R&D'));
    assert.ok(result.html.includes('https://app.cpaplatform.com'));
    assert.ok(result.text.includes('https://app.cpaplatform.com'));
  });

  test('escapes HTML in user-provided data', () => {
    const result = welcomeEmail({
      name: '<script>alert("xss")</script>',
      firmName: 'Test & Co',
      dashboardUrl: 'https://example.com',
    });
    assert.ok(!result.html.includes('<script>'));
    assert.ok(result.html.includes('&lt;script&gt;'));
  });
});

describe('inviteEmail template', () => {
  test('produces subject, html, and text with role description', () => {
    const result = inviteEmail({
      inviteeName: 'Bob',
      inviterName: 'Alice',
      firmName: 'Test Firm',
      role: 'consultant',
      acceptUrl: 'https://app.cpaplatform.com/invite/accept?token=abc',
    });
    assert.ok(result.subject.includes('Alice'));
    assert.ok(result.subject.includes('Test Firm'));
    assert.ok(result.html.includes('consultant'));
    assert.ok(result.html.includes('assigned claimants'));
    assert.ok(result.text.includes('https://app.cpaplatform.com/invite/accept?token=abc'));
  });

  test('includes custom expiry', () => {
    const result = inviteEmail({
      inviteeName: 'Bob',
      inviterName: 'Alice',
      firmName: 'Test',
      role: 'viewer',
      acceptUrl: 'https://example.com',
      expiresInDays: 3,
    });
    assert.ok(result.html.includes('3 days'));
    assert.ok(result.text.includes('3 days'));
  });
});

describe('magicLinkEmail template', () => {
  test('produces subject, html, and text for claimant portal', () => {
    const result = magicLinkEmail({
      name: 'Charlie',
      magicLinkUrl: 'https://app.cpaplatform.com/magic?token=xyz',
      portalType: 'claimant',
    });
    assert.ok(result.subject.includes('Claimant Portal'));
    assert.ok(result.html.includes('Charlie'));
    assert.ok(result.html.includes('https://app.cpaplatform.com/magic?token=xyz'));
    assert.ok(result.text.includes('https://app.cpaplatform.com/magic?token=xyz'));
  });

  test('handles missing name gracefully', () => {
    const result = magicLinkEmail({
      magicLinkUrl: 'https://example.com/magic?token=abc',
      portalType: 'consultant',
    });
    assert.ok(result.html.includes('Hi,'));
    assert.ok(result.subject.includes('CPA Platform'));
  });

  test('uses custom expiry minutes', () => {
    const result = magicLinkEmail({
      magicLinkUrl: 'https://example.com/magic?token=abc',
      portalType: 'claimant',
      expiresInMinutes: 30,
    });
    assert.ok(result.html.includes('30 minutes'));
    assert.ok(result.text.includes('30 minutes'));
  });
});

describe('claimStatusEmail template', () => {
  test('produces subject with claimant name and new stage label', () => {
    const result = claimStatusEmail({
      recipientName: 'Dana',
      claimantName: 'Widget Corp',
      firmName: 'CPA Firm',
      previousStage: 'activity_capture',
      newStage: 'narrative_drafting',
      claimUrl: 'https://app.cpaplatform.com/claims/123',
    });
    assert.ok(result.subject.includes('Widget Corp'));
    assert.ok(result.subject.includes('Narrative Drafting'));
    assert.ok(result.html.includes('Activity Capture'));
    assert.ok(result.html.includes('Narrative Drafting'));
    assert.ok(result.text.includes('Activity Capture'));
    assert.ok(result.text.includes('Narrative Drafting'));
  });

  test('includes optional note', () => {
    const result = claimStatusEmail({
      recipientName: 'Dana',
      claimantName: 'Widget Corp',
      firmName: 'CPA Firm',
      previousStage: 'internal_review',
      newStage: 'signing_ready',
      claimUrl: 'https://example.com',
      note: 'All narratives approved by reviewer.',
    });
    assert.ok(result.html.includes('All narratives approved by reviewer.'));
    assert.ok(result.text.includes('All narratives approved by reviewer.'));
  });

  test('handles unknown stage gracefully', () => {
    const result = claimStatusEmail({
      recipientName: 'Dana',
      claimantName: 'Widget Corp',
      firmName: 'CPA Firm',
      previousStage: 'custom_stage',
      newStage: 'another_stage',
      claimUrl: 'https://example.com',
    });
    // Falls back to the raw stage string.
    assert.ok(result.html.includes('custom_stage'));
    assert.ok(result.html.includes('another_stage'));
  });
});
