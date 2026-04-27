import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerPrompt, getPrompt, listPrompts } from './prompt-registry.js';

test('registerPrompt + getPrompt round-trip', () => {
  registerPrompt({
    name: 'test-prompt-' + Math.random(),
    version: '1.0.0',
    system: 'sys',
    tool: { name: 'noop', description: 'd', input_schema: z.object({}) },
  });
  // Re-register same key — no throw, first wins
  registerPrompt({
    name: 'test-prompt-stable',
    version: '1.0.0',
    system: 'sys',
    tool: { name: 'noop', description: 'd', input_schema: z.object({}) },
  });
  registerPrompt({
    name: 'test-prompt-stable',
    version: '1.0.0',
    system: 'sys-2',
    tool: { name: 'noop', description: 'd', input_schema: z.object({}) },
  });
  const p = getPrompt('test-prompt-stable@1.0.0');
  // First registration wins (idempotent).
  assert.equal(p.system, 'sys');
});

test('getPrompt throws on unknown key', () => {
  assert.throws(() => getPrompt('nonexistent@9.9.9'), /prompt not registered/);
});

test('listPrompts returns sorted keys', () => {
  const keys = listPrompts();
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});
