import type { PromptDefinition } from './types.js';

const PROMPTS = new Map<string, PromptDefinition<unknown>>();

/**
 * Register a prompt under `name@version`. Re-registering an identical key is
 * a no-op (first registration wins) so prompt files imported as side-effects
 * from multiple paths don't clobber each other.
 */
export function registerPrompt<O>(p: PromptDefinition<O>): void {
  const key = `${p.name}@${p.version}`;
  if (PROMPTS.has(key)) {
    // Idempotent — repeat registration of same prompt is a no-op.
    return;
  }
  PROMPTS.set(key, p);
}

/**
 * Look up a prompt by `name@version`. Throws when the key is unknown — callers
 * should ensure the prompt module is imported (and therefore registered) at
 * startup.
 */
export function getPrompt<O>(key: string): PromptDefinition<O> {
  const p = PROMPTS.get(key);
  if (!p) throw new Error(`prompt not registered: ${key}`);
  return p as PromptDefinition<O>;
}

/** Sorted list of all registered `name@version` keys. */
export function listPrompts(): string[] {
  return [...PROMPTS.keys()].sort();
}
