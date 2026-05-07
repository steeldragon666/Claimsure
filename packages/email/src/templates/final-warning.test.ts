import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalWarningEmail } from './final-warning.js';

test('finalWarningEmail: returns correct subject', () => {
  const result = finalWarningEmail({
    name: 'Alice',
    firmName: 'Acme R&D',
    portalUrl: 'https://billing.stripe.com/p/session/test',
    cancellationDate: '15 May 2026',
  });
  assert.ok(
    result.subject.toLowerCase().includes('warning') ||
      result.subject.toLowerCase().includes('cancel'),
    'subject must mention warning or cancellation',
  );
});

test('finalWarningEmail: HTML contains name, firm name, and cancellation date', () => {
  const result = finalWarningEmail({
    name: 'Bob',
    firmName: 'Beta Corp',
    portalUrl: 'https://billing.stripe.com/p/session/test',
    cancellationDate: '20 May 2026',
  });
  assert.ok(result.html.includes('Bob'), 'HTML must include name');
  assert.ok(result.html.includes('Beta Corp'), 'HTML must include firm name');
  assert.ok(result.html.includes('20 May 2026'), 'HTML must include cancellation date');
});

test('finalWarningEmail: HTML and text contain portal URL', () => {
  const portalUrl = 'https://billing.stripe.com/p/session/final_warning_abc';
  const result = finalWarningEmail({
    name: 'Carol',
    firmName: 'Gamma Ltd',
    portalUrl,
    cancellationDate: '25 May 2026',
  });
  assert.ok(result.html.includes(portalUrl), 'HTML must include portal URL');
  assert.ok(result.text.includes(portalUrl), 'text must include portal URL');
});

test('finalWarningEmail: plain text contains key info', () => {
  const result = finalWarningEmail({
    name: 'Dave',
    firmName: 'Delta Pty',
    portalUrl: 'https://billing.stripe.com/p/session/test',
    cancellationDate: '30 May 2026',
  });
  assert.ok(result.text.includes('Dave'), 'text must include name');
  assert.ok(result.text.includes('Delta Pty'), 'text must include firm name');
  assert.ok(result.text.includes('30 May 2026'), 'text must include cancellation date');
});

test('finalWarningEmail: escapes special chars in firm name', () => {
  const result = finalWarningEmail({
    name: 'Eve',
    firmName: '<b>Evil Corp</b>',
    portalUrl: 'https://billing.stripe.com/p/session/test',
    cancellationDate: '1 June 2026',
  });
  assert.ok(!result.html.includes('<b>Evil'), 'HTML must escape firm name tags');
});
