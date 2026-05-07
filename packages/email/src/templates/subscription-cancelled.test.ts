import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionCancelledEmail } from './subscription-cancelled.js';

test('subscriptionCancelledEmail: returns correct subject', () => {
  const result = subscriptionCancelledEmail({
    name: 'Alice',
    firmName: 'Acme R&D',
  });
  assert.ok(
    result.subject.toLowerCase().includes('cancel') ||
      result.subject.toLowerCase().includes('ended') ||
      result.subject.toLowerCase().includes('subscription'),
    'subject must mention cancellation or subscription',
  );
});

test('subscriptionCancelledEmail: HTML contains name and firm name', () => {
  const result = subscriptionCancelledEmail({
    name: 'Bob',
    firmName: 'Beta Corp',
  });
  assert.ok(result.html.includes('Bob'), 'HTML must include name');
  assert.ok(result.html.includes('Beta Corp'), 'HTML must include firm name');
});

test('subscriptionCancelledEmail: plain text contains key info', () => {
  const result = subscriptionCancelledEmail({
    name: 'Carol',
    firmName: 'Gamma Ltd',
  });
  assert.ok(result.text.includes('Carol'), 'text must include name');
  assert.ok(result.text.includes('Gamma Ltd'), 'text must include firm name');
});

test('subscriptionCancelledEmail: HTML and text are non-empty strings', () => {
  const result = subscriptionCancelledEmail({
    name: 'Dave',
    firmName: 'Delta Pty',
  });
  assert.ok(typeof result.html === 'string' && result.html.length > 0, 'HTML must be non-empty');
  assert.ok(typeof result.text === 'string' && result.text.length > 0, 'text must be non-empty');
});

test('subscriptionCancelledEmail: escapes special chars in name', () => {
  const result = subscriptionCancelledEmail({
    name: '<script>alert(1)</script>',
    firmName: 'Safe Corp',
  });
  assert.ok(!result.html.includes('<script>'), 'HTML must escape script tags');
});
