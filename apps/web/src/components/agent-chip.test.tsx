import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgentLabel, type AgentChipProps } from './agent-chip.js';

/**
 * Design system signature components — AgentChip.
 *
 * Distinguishes agent contributions from consultant authorship in the UI.
 * See docs/design/system.md §"Agent-attribution chip".
 *
 * Format: "Drafted by <agentName> · <versionPin>"
 * Sizes:  md only (no dense variant — readability is mandatory here)
 * States: default | clickable (when onClick provided)
 *
 * Test discipline: pure helpers + type contracts; visual tests in Playwright.
 */

// ---------- formatAgentLabel ----------

test('formatAgentLabel: standard format with agent name + version pin', () => {
  assert.equal(
    formatAgentLabel({ agentName: 'Agent C', versionPin: 'v1.1.0' }),
    'Drafted by Agent C · v1.1.0',
  );
});

test('formatAgentLabel: full prompt-module-style version', () => {
  assert.equal(
    formatAgentLabel({ agentName: 'Drafter', versionPin: 'draft-narrative@1.1.0' }),
    'Drafted by Drafter · draft-narrative@1.1.0',
  );
});

test('formatAgentLabel: rejects empty agentName', () => {
  // Defensive: an empty agent name is a programming error, not a UI state.
  assert.throws(() => formatAgentLabel({ agentName: '', versionPin: 'v1.0.0' }), /agentName/i);
});

test('formatAgentLabel: rejects empty versionPin', () => {
  // Same defensive: every agent contribution must be reproducible — no
  // anonymous version pins.
  assert.throws(() => formatAgentLabel({ agentName: 'Agent C', versionPin: '' }), /versionPin/i);
});

// ---------- AgentChipProps type contract ----------

test('AgentChipProps: minimal required props compile', () => {
  const minimal: AgentChipProps = {
    agentName: 'Agent C',
    versionPin: 'v1.1.0',
  };
  assert.equal(minimal.agentName, 'Agent C');
});

test('AgentChipProps: full prop set compiles', () => {
  const full: AgentChipProps = {
    agentName: 'Drafter',
    versionPin: 'draft-narrative@1.1.0',
    modelName: 'claude-opus-4-7',
    promptModulePath: 'packages/agents/src/narrative-drafter/prompts/draft-narrative@1.1.0.ts',
    className: 'extra',
    onClick: () => {},
  };
  assert.equal(full.modelName, 'claude-opus-4-7');
});
