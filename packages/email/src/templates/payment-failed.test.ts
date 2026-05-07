import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentFailedEmail } from './payment-failed.js';

test('paymentFailedEmail: returns correct subject', () => {
  const result = paymentFailedEmail({
    name: 'Alice',
    firmName: 'Acme R&D',
    portalUrl: 'https://billing.stripe.com/p/session/test',
  });
  assert.ok(result.subject.toLowerCase().includes('payment'), 'subject must mention payment');
  assert.ok(
    result.subject.toLowerCase().includes('fail') ||
      result.subject.toLowerCase().includes('declined'),
    'subject must mention failure',
  );
});

test('paymentFailedEmail: HTML contains name and firm name', () => {
  const result = paymentFailedEmail({
    name: 'Bob',
    firmName: 'Beta Corp',
    portalUrl: 'https://billing.stripe.com/p/session/test',
  });
  assert.ok(result.html.includes('Bob'), 'HTML must include name');
  assert.ok(result.html.includes('Beta Corp'), 'HTML must include firm name');
});

test('paymentFailedEmail: HTML and text contain portal URL', () => {
  const portalUrl = 'https://billing.stripe.com/p/session/test_abc123';
  const result = paymentFailedEmail({
    name: 'Carol',
    firmName: 'Gamma Ltd',
    portalUrl,
  });
  assert.ok(result.html.includes(portalUrl), 'HTML must include portal URL');
  assert.ok(result.text.includes(portalUrl), 'text must include portal URL');
});

test('paymentFailedEmail: plain text contains key info', () => {
  const result = paymentFailedEmail({
    name: 'Dave',
    firmName: 'Delta Pty',
    portalUrl: 'https://billing.stripe.com/p/session/test',
  });
  assert.ok(result.text.includes('Dave'), 'text must include name');
  assert.ok(result.text.includes('Delta Pty'), 'text must include firm name');
});

test('paymentFailedEmail: escapes special chars in name', () => {
  const result = paymentFailedEmail({
    name: '<script>alert(1)</script>',
    firmName: 'Safe Corp',
    portalUrl: 'https://billing.stripe.com/p/session/test',
  });
  assert.ok(!result.html.includes('<script>'), 'HTML must escape script tags');
});
