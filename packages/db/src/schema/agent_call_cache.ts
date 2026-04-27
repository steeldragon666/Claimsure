import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Content-addressed cache for classifier (and future) agent calls.
 *
 * Keyed by a hex SHA-256 over the agent input (prompt template version +
 * normalized input payload). Same input across tenants legitimately shares
 * a cache entry — there is no tenant scoping and NO RLS on this table.
 *
 * Stored alongside the cached `output` JSON: token usage and the model
 * identifier the call was served from, so cost/quality regressions can be
 * audited against historical runs.
 *
 * Lifecycle: append-only and idempotent — the first writer wins; subsequent
 * identical calls hit the cache. Stale entries are evicted by TTL job
 * (lands later); for now `created_at` is the only retention signal.
 *
 * Naming convention: camelCase TS / snake_case SQL (per T5/T6 chain).
 */
export const agentCallCache = pgTable('agent_call_cache', {
  // hex SHA-256 over (agentName, promptVersion, normalized input payload).
  idempotencyKey: text('idempotency_key').primaryKey(),
  agentName: text('agent_name').notNull(),
  promptVersion: text('prompt_version').notNull(),
  output: jsonb('output').notNull(),
  tokensIn: integer('tokens_in').notNull(),
  tokensOut: integer('tokens_out').notNull(),
  model: text('model').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
