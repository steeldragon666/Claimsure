import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentEnabled, isStreamingEnabled, isTenantAllowed, _reloadEnvForTests } from './env.js';

/**
 * Mutate process.env then re-parse the env-cache so tests run in isolation.
 * Without this helper, the second test's `process.env` mutation would not
 * be observed (the module reads env exactly once at load).
 *
 * Each test calls `setEnv(...)` which clears the four flags + the allowlist,
 * applies overrides, then forces a reload. This prevents cross-test leak
 * because the previous test's overrides are wiped before this one runs.
 */
function setEnv(overrides: Record<string, string | undefined>): void {
  for (const key of [
    'P6_AGENT_A_ENABLED',
    'P6_AGENT_B_ENABLED',
    'P6_AGENT_C_ENABLED',
    'P6_AGENT_C_STREAMING_ENABLED',
    'P6_AGENT_TENANT_ALLOWLIST',
  ]) {
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  _reloadEnvForTests();
}

// ─── isAgentEnabled ────────────────────────────────────────────────────────

test('isAgentEnabled: defaults to true when env unset', () => {
  setEnv({});
  assert.equal(isAgentEnabled('A'), true);
  assert.equal(isAgentEnabled('B'), true);
  assert.equal(isAgentEnabled('C'), true);
});

test('isAgentEnabled: returns true when explicitly =true', () => {
  setEnv({ P6_AGENT_A_ENABLED: 'true' });
  assert.equal(isAgentEnabled('A'), true);
});

test('isAgentEnabled: case-insensitive — TRUE / True / FALSE / False', () => {
  setEnv({ P6_AGENT_A_ENABLED: 'TRUE', P6_AGENT_B_ENABLED: 'False' });
  assert.equal(isAgentEnabled('A'), true);
  assert.equal(isAgentEnabled('B'), false);
});

test('isAgentEnabled: returns false when explicitly =false', () => {
  setEnv({ P6_AGENT_A_ENABLED: 'false' });
  assert.equal(isAgentEnabled('A'), false);
});

test('isAgentEnabled: malformed values fall back to default-on (true)', () => {
  // Strict parser: only 'true'/'false' (case-insensitive) accepted; anything
  // else (typos, '1', 'yes', etc.) → fallback. This prevents a typo like
  // `=tru` from silently disabling an agent.
  setEnv({
    P6_AGENT_A_ENABLED: 'tru',
    P6_AGENT_B_ENABLED: '1',
    P6_AGENT_C_ENABLED: 'yes',
  });
  assert.equal(isAgentEnabled('A'), true);
  assert.equal(isAgentEnabled('B'), true);
  assert.equal(isAgentEnabled('C'), true);
});

test('isAgentEnabled: agents are independent of each other', () => {
  setEnv({
    P6_AGENT_A_ENABLED: 'true',
    P6_AGENT_B_ENABLED: 'false',
    P6_AGENT_C_ENABLED: 'true',
  });
  assert.equal(isAgentEnabled('A'), true);
  assert.equal(isAgentEnabled('B'), false);
  assert.equal(isAgentEnabled('C'), true);
});

// ─── isStreamingEnabled ────────────────────────────────────────────────────

test('isStreamingEnabled: defaults to true when env unset', () => {
  setEnv({});
  assert.equal(isStreamingEnabled(), true);
});

test('isStreamingEnabled: honors =false', () => {
  setEnv({ P6_AGENT_C_STREAMING_ENABLED: 'false' });
  assert.equal(isStreamingEnabled(), false);
});

test('isStreamingEnabled: orthogonal to Agent C enabled flag', () => {
  // Agent C enabled but streaming disabled → fall back to non-streaming response.
  setEnv({ P6_AGENT_C_ENABLED: 'true', P6_AGENT_C_STREAMING_ENABLED: 'false' });
  assert.equal(isAgentEnabled('C'), true);
  assert.equal(isStreamingEnabled(), false);
});

// ─── isTenantAllowed ───────────────────────────────────────────────────────

test('isTenantAllowed: returns true when allowlist unset (all allowed)', () => {
  setEnv({});
  assert.equal(isTenantAllowed('any-tenant-id'), true);
});

test('isTenantAllowed: returns true when allowlist is empty string (all allowed)', () => {
  setEnv({ P6_AGENT_TENANT_ALLOWLIST: '' });
  assert.equal(isTenantAllowed('any-tenant-id'), true);
});

test('isTenantAllowed: single-tenant allowlist matches that tenant', () => {
  setEnv({ P6_AGENT_TENANT_ALLOWLIST: 'tenant-1' });
  assert.equal(isTenantAllowed('tenant-1'), true);
  assert.equal(isTenantAllowed('tenant-2'), false);
});

test('isTenantAllowed: csv allowlist matches any listed tenant', () => {
  setEnv({ P6_AGENT_TENANT_ALLOWLIST: 'tenant-1,tenant-2' });
  assert.equal(isTenantAllowed('tenant-1'), true);
  assert.equal(isTenantAllowed('tenant-2'), true);
  assert.equal(isTenantAllowed('tenant-3'), false);
});

test('isTenantAllowed: trims whitespace around csv entries', () => {
  setEnv({ P6_AGENT_TENANT_ALLOWLIST: ' tenant-1 , tenant-2 ' });
  assert.equal(isTenantAllowed('tenant-1'), true);
  assert.equal(isTenantAllowed('tenant-2'), true);
});

test('isTenantAllowed: drops empty csv segments (e.g. "a,,b")', () => {
  setEnv({ P6_AGENT_TENANT_ALLOWLIST: 'tenant-1,,tenant-2' });
  assert.equal(isTenantAllowed('tenant-1'), true);
  assert.equal(isTenantAllowed('tenant-2'), true);
  // Empty string should not match anything.
  assert.equal(isTenantAllowed(''), false);
});

// ─── _reloadEnvForTests cache behavior ─────────────────────────────────────

test('_reloadEnvForTests: env is read once at load and cached until reload', () => {
  // Establish the cache at value A.
  setEnv({ P6_AGENT_A_ENABLED: 'false' });
  assert.equal(isAgentEnabled('A'), false);

  // Mutate process.env WITHOUT calling reload — should still see cached value.
  process.env.P6_AGENT_A_ENABLED = 'true';
  assert.equal(isAgentEnabled('A'), false, 'expected cached value before reload');

  // Now reload — should pick up the new value.
  _reloadEnvForTests();
  assert.equal(isAgentEnabled('A'), true, 'expected fresh value after reload');
});
