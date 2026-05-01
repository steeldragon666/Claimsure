import type { AgentName } from './rate-limit.js';

/**
 * Feature flags for the staged P6 rollout. Five env vars in total:
 *
 *   P6_AGENT_A_ENABLED              (default true)
 *   P6_AGENT_B_ENABLED              (default true)
 *   P6_AGENT_C_ENABLED              (default true)
 *   P6_AGENT_C_STREAMING_ENABLED    (default true)
 *   P6_AGENT_TENANT_ALLOWLIST       (default unset = all tenants)
 *
 * **Default-on by design.** These flags are a kill-switch / staged-rollout
 * REVERSE: in normal operation everything is enabled, and an operator flips
 * a flag to `false` to disable a misbehaving agent without redeploying code.
 * If we defaulted to `false` we'd risk a fresh deploy silently leaving an
 * agent off because someone forgot to set the var. Default-on means "the
 * code is the source of truth; env only overrides to disable".
 *
 * **Boolean parsing is strict.** Only the literal strings `'true'` and
 * `'false'` (case-insensitive) are accepted; anything else falls back to
 * the default. This catches typos like `=tru` or `=1` instead of silently
 * disabling an agent — a worse failure mode than the typo being ignored.
 *
 * **Allowlist semantics.** Empty or unset → null sentinel meaning "all
 * tenants allowed". A non-empty CSV restricts to exactly the listed tenant
 * ids (whitespace trimmed, empty segments dropped). UUID validation is
 * NOT performed at parse time; `isTenantAllowed` does string equality so
 * a malformed entry simply never matches anything.
 *
 * **Read once at module load.** Same pattern as `rate-limit.ts` and
 * `pricing.ts`. Production `process.env` is effectively immutable, so
 * re-reading per-call would just be wasted work. The `_reloadEnvForTests`
 * escape hatch is the only supported way to re-parse, and it exists solely
 * for the test suite.
 *
 * See design doc Section 6 (`docs/plans/2026-05-01-p6-design.md`) for the
 * three-phase rollout plan: dogfood → 3 friendly firms → all firms.
 */

/**
 * Strict boolean parser. Only `'true'`/`'false'` (case-insensitive) are
 * accepted. Unset, empty, or any other value falls back to `fallback`.
 *
 * Why strict instead of "any truthy string is true"? A typo like
 * `P6_AGENT_A_ENABLED=tru` should NOT silently disable Agent A — the
 * operator's intent was clearly to enable it. Falling back to default-on
 * preserves the kill-switch semantics: the only way to disable an agent
 * is to write the literal `false` in env.
 */
function parseBool(envValue: string | undefined, fallback: boolean): boolean {
  if (envValue === undefined) return fallback;
  const lowered = envValue.trim().toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  return fallback;
}

/**
 * Parse the CSV allowlist. Returns `null` when unset or empty (sentinel for
 * "all tenants allowed"); returns a `Set` for O(1) membership check
 * otherwise. Whitespace is trimmed around each entry; empty segments
 * (`'a,,b'`) are dropped.
 *
 * Returning a Set rather than an array is a micro-optimization: the
 * allowlist is checked on every gated call, and `Set.has` is O(1) vs
 * `Array.includes` O(N).
 */
function parseAllowlist(envValue: string | undefined): Set<string> | null {
  if (envValue === undefined) return null;
  const trimmed = envValue.trim();
  if (trimmed === '') return null;
  const entries = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return null;
  return new Set(entries);
}

type ParsedEnv = {
  agentEnabled: Record<AgentName, boolean>;
  streamingEnabled: boolean;
  /** `null` means "all tenants allowed" (allowlist disabled). */
  allowlist: Set<string> | null;
};

/**
 * Read `process.env` and produce a `ParsedEnv`. Called once at module load
 * and again by `_reloadEnvForTests`. Pure function — no side effects, no
 * I/O — which makes the test escape hatch trivial: mutate env, call
 * `_reloadEnvForTests`, observe new behavior.
 */
function loadEnv(): ParsedEnv {
  return {
    agentEnabled: {
      A: parseBool(process.env.P6_AGENT_A_ENABLED, true),
      B: parseBool(process.env.P6_AGENT_B_ENABLED, true),
      C: parseBool(process.env.P6_AGENT_C_ENABLED, true),
    },
    streamingEnabled: parseBool(process.env.P6_AGENT_C_STREAMING_ENABLED, true),
    allowlist: parseAllowlist(process.env.P6_AGENT_TENANT_ALLOWLIST),
  };
}

let cache: ParsedEnv = loadEnv();

/**
 * Whether the named P6 agent is enabled. Defaults to `true` when the
 * corresponding env var is unset — see module-level docstring for why
 * default-on is the correct policy for kill-switch flags.
 *
 * @param agent `'A'` (Haiku classifier), `'B'` (Sonnet synthesizer), or
 *              `'C'` (Sonnet streaming narrative drafter).
 */
export function isAgentEnabled(agent: AgentName): boolean {
  return cache.agentEnabled[agent];
}

/**
 * Whether Agent C should stream tokens. When `false`, callers should fall
 * back to a non-streaming `messages.create` response. This is orthogonal
 * to `isAgentEnabled('C')`: Agent C may be enabled with streaming turned
 * off (e.g. behind a load balancer that doesn't tolerate long-lived
 * connections). Defaults to `true`.
 */
export function isStreamingEnabled(): boolean {
  return cache.streamingEnabled;
}

/**
 * Whether the given tenant id passes the allowlist gate.
 *
 * Returns `true` unconditionally when `P6_AGENT_TENANT_ALLOWLIST` is unset
 * or empty (the design-doc semantics: "empty = all"). When set, only the
 * listed tenant ids pass; everything else is blocked.
 *
 * Used during staged rollout: Phase 1 sets allowlist to the dogfood firm
 * only; Phase 2 expands to ~3 friendly firms; Phase 3 unsets the var to
 * open up to all tenants.
 */
export function isTenantAllowed(tenantId: string): boolean {
  if (cache.allowlist === null) return true;
  return cache.allowlist.has(tenantId);
}

/**
 * Test-only escape hatch: re-read `process.env` and rebuild the parsed
 * cache. Mirrors the `_resetXForTests` naming convention from
 * `anthropic-client.ts` and `rate-limit.ts`.
 *
 * Production code MUST NOT call this. The whole point of caching at module
 * load is to make the env reads predictable; allowing arbitrary reloads
 * in production would be a footgun.
 */
export function _reloadEnvForTests(): void {
  cache = loadEnv();
}
