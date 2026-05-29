import { z } from 'zod';
import { Iso8601, Uuid } from './primitives.js';

/**
 * Integration provider enum (T-B3).
 *
 * Mirrors `INTEGRATION_PROVIDERS` in @cpa/db/schema/integration_connection.ts.
 * Both are TS-level enums over the plain-text `provider` column (no DB CHECK
 * constraint), so adding a provider must touch BOTH lists to keep the API
 * contract (this file) and the table typing (db) in sync.
 */
export const INTEGRATION_PROVIDERS = [
  'docusign',
  'employment_hero',
  'keypay',
  'deputy',
  'xero_accounting',
  'xero_payroll',
  'myob_accounting',
] as const;
export const integrationProvider = z.enum(INTEGRATION_PROVIDERS);
export type IntegrationProvider = z.infer<typeof integrationProvider>;

export const INTEGRATION_SYNC_STATES = ['idle', 'syncing', 'failed'] as const;
export const integrationSyncState = z.enum(INTEGRATION_SYNC_STATES);
export type IntegrationSyncState = z.infer<typeof integrationSyncState>;

/**
 * Public shape of an `integration_connection` row over the API.
 *
 * Tokens are NEVER returned — only metadata (which provider, sync
 * state, last error). The DB stores ciphertext-only, but even decrypted
 * tokens stay server-side: callers wanting to make API calls go through
 * server-side worker queues, not direct token exposure.
 */
export const integrationConnection = z.object({
  id: Uuid,
  tenant_id: Uuid,
  // The client (claimant) this connection belongs to. null for firm-level
  // providers (e.g. DocuSign); set for per-client ones (Xero/MYOB accounting).
  subject_tenant_id: Uuid.nullable(),
  provider: integrationProvider,
  expires_at: Iso8601,
  scopes: z.array(z.string()).nullable(),
  external_account_id: z.string().nullable(),
  last_synced_at: Iso8601.nullable(),
  sync_state: integrationSyncState,
  last_error: z.string().nullable(),
  created_at: Iso8601,
  updated_at: Iso8601,
});
export type IntegrationConnection = z.infer<typeof integrationConnection>;

/**
 * GET /v1/integrations response: list of active connections in the active firm.
 */
export const listIntegrationsResponse = z.object({
  integrations: z.array(integrationConnection),
});
export type ListIntegrationsResponse = z.infer<typeof listIntegrationsResponse>;
