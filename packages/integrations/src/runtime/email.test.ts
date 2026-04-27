import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail } from './email.js';

test('sendEmail (console-stub): resolves and logs JSON line', async () => {
  // Stub console.log so the test doesn't pollute the runner output.
  const originalLog = console.log;
  let captured: string | null = null;
  console.log = (msg: string): void => {
    captured = msg;
  };
  try {
    await sendEmail({ to: 'a@b.com', subject: 'Hi', body: 'Body', tenantId: 't1' });
  } finally {
    console.log = originalLog;
  }
  assert.ok(captured, 'console.log was called');
  const parsed = JSON.parse(captured ?? '') as Record<string, unknown>;
  assert.equal(parsed['kind'], 'email.console-stub');
  assert.equal(parsed['to'], 'a@b.com');
  assert.equal(parsed['subject'], 'Hi');
  assert.equal(parsed['body'], 'Body');
  assert.equal(parsed['tenant_id'], 't1');
});

test('sendEmail (console-stub): omits tenant_id when not provided', async () => {
  const originalLog = console.log;
  let captured: string | null = null;
  console.log = (msg: string): void => {
    captured = msg;
  };
  try {
    await sendEmail({ to: 'a@b.com', subject: 'Hi', body: 'Body' });
  } finally {
    console.log = originalLog;
  }
  assert.ok(captured);
  const parsed = JSON.parse(captured ?? '') as Record<string, unknown>;
  assert.ok(!('tenant_id' in parsed));
});
