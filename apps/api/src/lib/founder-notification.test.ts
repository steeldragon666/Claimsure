import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOverrideLink,
  parseFounderRecipients,
  renderFounderNotification,
  sendFounderNotification,
  type FounderNotificationInput,
  type FounderNotificationSender,
} from './founder-notification.js';
import type { SignupPipelineResult } from './signup-pipeline.js';

const SECRET = 'test-override-secret-32+bytes-of-entropy-here!!';
const BASE_URL = 'https://archiveone.example.com';

function baseAudit(): SignupPipelineResult['audit'] {
  return {
    adminOverrideHit: false,
    rateLimitCountInWindow: 0,
    emailShapeOk: true,
    abrLookup: null,
    claudeConfidence: 0.85,
    claudeDecision: 'approve',
    claudeRationale: 'looks legitimate',
    claudeRedFlags: null,
    classifierModel: 'claude-sonnet-test',
    promptVersion: 'evaluate-signup@1.0.0',
    tokensIn: 100,
    tokensOut: 30,
    elapsedMs: 1234,
  };
}

function approveInput(): FounderNotificationInput {
  return {
    decisionId: '11111111-1111-1111-1111-111111111111',
    email: 'applicant@example.com',
    firmName: 'Vantage Industries',
    displayName: 'Jane Doe',
    clientIp: '203.0.113.10',
    userAgent: 'Mozilla/5.0',
    outcome: { decision: 'approve', reason: 'claude_approve' },
    audit: baseAudit(),
  };
}

function denyInput(): FounderNotificationInput {
  return {
    ...approveInput(),
    audit: { ...baseAudit(), claudeDecision: 'deny', claudeConfidence: 0.92 },
    outcome: { decision: 'deny', reason: 'claude_deny' },
  };
}

class RecordingSender implements FounderNotificationSender {
  public calls: { to: string | string[]; subject: string; text: string; html: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async send(input: {
    to: string | string[];
    subject: string;
    html: string;
    text: string;
  }): Promise<{ id: string }> {
    this.calls.push(input);
    return { id: `msg-${this.calls.length}` };
  }
}

test('parseFounderRecipients: undefined / empty / whitespace → []', () => {
  assert.deepEqual(parseFounderRecipients(undefined), []);
  assert.deepEqual(parseFounderRecipients(''), []);
  assert.deepEqual(parseFounderRecipients('   '), []);
});

test('parseFounderRecipients: comma-separated trimmed list', () => {
  assert.deepEqual(parseFounderRecipients('a@x.com, b@y.com  ,c@z.com'), [
    'a@x.com',
    'b@y.com',
    'c@z.com',
  ]);
});

test('renderFounderNotification: approve subject format', () => {
  const rendered = renderFounderNotification(approveInput(), null);
  assert.equal(rendered.subject, '[ArchiveOne signup] approve: Vantage Industries');
  assert.match(rendered.text, /Decision: approve \(claude_approve\)/);
  assert.match(rendered.text, /Applicant email: applicant@example.com/);
  assert.ok(!rendered.text.includes('1-click approve override'));
});

test('renderFounderNotification: deny subject format', () => {
  const rendered = renderFounderNotification(denyInput(), null);
  assert.equal(rendered.subject, '[ArchiveOne signup] deny: Vantage Industries');
  assert.match(rendered.text, /Decision: deny \(claude_deny\)/);
});

test('renderFounderNotification: claude_deny + overrideLink → body contains link', () => {
  const link = buildOverrideLink({
    decisionId: '11111111-1111-1111-1111-111111111111',
    applicantEmail: 'applicant@example.com',
    secret: SECRET,
    publicBaseUrl: BASE_URL,
  });
  const rendered = renderFounderNotification(denyInput(), link);
  assert.match(rendered.text, /1-click approve override:/);
  assert.ok(rendered.text.includes(link));
  assert.ok(rendered.html.includes(link));
});

test('renderFounderNotification: escapes HTML in user-supplied fields', () => {
  const input: FounderNotificationInput = {
    ...approveInput(),
    firmName: '<script>alert(1)</script>',
    displayName: 'A & B',
  };
  const rendered = renderFounderNotification(input, null);
  assert.ok(!rendered.html.includes('<script>'));
  assert.ok(rendered.html.includes('&lt;script&gt;'));
  assert.ok(rendered.html.includes('A &amp; B'));
});

test('buildOverrideLink: contains decisionId path segment and token query', () => {
  const link = buildOverrideLink({
    decisionId: '11111111-1111-1111-1111-111111111111',
    applicantEmail: 'applicant@example.com',
    secret: SECRET,
    publicBaseUrl: BASE_URL,
  });
  assert.ok(link.startsWith(`${BASE_URL}/v1/admin/signup-decisions/`));
  assert.ok(link.includes('/approve?token='));
});

test('sendFounderNotification: no-op when recipients is empty', async () => {
  const sender = new RecordingSender();
  await sendFounderNotification(sender, approveInput(), {
    recipients: [],
    overrideSecret: SECRET,
    publicBaseUrl: BASE_URL,
  });
  assert.equal(sender.calls.length, 0);
});

test('sendFounderNotification: sends to all recipients on approve', async () => {
  const sender = new RecordingSender();
  await sendFounderNotification(sender, approveInput(), {
    recipients: ['founder1@example.com', 'founder2@example.com'],
    overrideSecret: SECRET,
    publicBaseUrl: BASE_URL,
  });
  assert.equal(sender.calls.length, 1);
  assert.deepEqual(sender.calls[0]!.to, ['founder1@example.com', 'founder2@example.com']);
  assert.match(sender.calls[0]!.subject, /approve:/);
  assert.ok(!sender.calls[0]!.text.includes('1-click approve override'));
});

test('sendFounderNotification: includes override link on claude_deny', async () => {
  const sender = new RecordingSender();
  await sendFounderNotification(sender, denyInput(), {
    recipients: ['founder@example.com'],
    overrideSecret: SECRET,
    publicBaseUrl: BASE_URL,
  });
  assert.equal(sender.calls.length, 1);
  assert.match(sender.calls[0]!.text, /1-click approve override:/);
});

test('sendFounderNotification: does NOT include override link on rate_limit deny', async () => {
  const sender = new RecordingSender();
  const input: FounderNotificationInput = {
    ...denyInput(),
    outcome: { decision: 'deny', reason: 'rate_limit' },
  };
  await sendFounderNotification(sender, input, {
    recipients: ['founder@example.com'],
    overrideSecret: SECRET,
    publicBaseUrl: BASE_URL,
  });
  assert.equal(sender.calls.length, 1);
  assert.ok(!sender.calls[0]!.text.includes('1-click approve override'));
});
