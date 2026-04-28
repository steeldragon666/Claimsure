/**
 * Xero Accounting integration (T-B1).
 *
 * Imported via the `@cpa/integrations/xero-accounting` subpath export.
 * B1 ships the OAuth scaffolding and a shared HTTP helper; subsequent
 * tasks (B2-B12) layer resource-specific list/create methods on top.
 *
 * **SECURITY — plaintext-token boundary**: `exchangeCode` and
 * `refreshAccessToken` return `OAuthTokens` with PLAINTEXT access and
 * refresh tokens. Callers MUST encrypt with `encryptToken()` from
 * `@cpa/integrations/runtime` before persisting to
 * `integration_connection.encrypted_credentials_blob`. The route layer
 * owns that encryption step — this module never touches the DB.
 */
export * from './types.js';
export * from './oauth.js';
export { parseXeroDate, xeroAccountingGet, type XeroAccountingClientOptions } from './client.js';

// TODO(p4-cleanup): post-swimlane integration follow-ups identified by
// the B1 code-quality review:
//   1. Extract `parseXeroDate` and `XeroTokenResponse` to a shared
//      `runtime/xero-date.ts` (or `xero-shared/`) module so both
//      xero-accounting and xero-payroll consume one source of truth.
//      Currently duplicated.
//   2. Update payroll error prefixes to include "payroll" so logs
//      distinguish the two modules. Currently payroll says "xero" while
//      accounting says "xero accounting".
// Both touch xero-payroll which is outside Swimlane B's scope. Track
// in a cross-cutting cleanup PR after the swimlanes merge.
