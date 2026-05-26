import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../../lib/render-template.js';

/**
 * Pure-function tests for the engagement-letter template renderer.
 * Lives in the engagement/ folder rather than lib/ so the colocation
 * makes the call-site → test mapping obvious; this is the only template
 * surface this helper is in service of.
 */

test('renderTemplate: substitutes known placeholders', () => {
  const out = renderTemplate('Hello {{name}}, year {{year}}.', {
    name: 'Acme Co',
    year: '2025',
  });
  assert.equal(out, 'Hello Acme Co, year 2025.');
});

test('renderTemplate: leaves unknown placeholders intact (no silent erasure)', () => {
  const out = renderTemplate('Hello {{name}}, fee {{fee_pct}}.', { name: 'Acme Co' });
  assert.equal(out, 'Hello Acme Co, fee {{fee_pct}}.');
});

test('renderTemplate: allows whitespace inside braces', () => {
  const out = renderTemplate('A={{ a }} B={{  b  }}', { a: '1', b: '2' });
  assert.equal(out, 'A=1 B=2');
});

test('renderTemplate: ignores invalid placeholder syntax', () => {
  // `{{ foo.bar }}` is not a supported identifier — leave it literal.
  // `{{ }}` is empty — likewise.
  const out = renderTemplate('A={{foo.bar}} B={{}}', { 'foo.bar': 'x' });
  assert.equal(out, 'A={{foo.bar}} B={{}}');
});

test('renderTemplate: handles repeated placeholders', () => {
  const out = renderTemplate('{{x}} and {{x}}', { x: 'twice' });
  assert.equal(out, 'twice and twice');
});

test('renderTemplate: empty string and empty vars are safe', () => {
  assert.equal(renderTemplate('', {}), '');
  assert.equal(renderTemplate('no placeholders here', {}), 'no placeholders here');
});

test('renderTemplate: works with null-prototype vars (hasOwnProperty robustness)', () => {
  const vars = Object.create(null) as Record<string, string>;
  vars['name'] = 'NullProto';
  const out = renderTemplate('Hi {{name}}', vars);
  assert.equal(out, 'Hi NullProto');
});

test('renderTemplate: rejects non-string values (prototype keys ignored)', () => {
  // `toString` lives on the prototype, not as own property — must
  // not match.
  const out = renderTemplate('Hi {{toString}}', {});
  assert.equal(out, 'Hi {{toString}}');
});
