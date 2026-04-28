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
export {
  syncInvoices,
  type SyncInvoicesConnection,
  type SyncInvoicesOptions,
  type SyncInvoicesResult,
} from './sync-invoices.js';
export {
  syncBankTransactions,
  type SyncBankTransactionsConnection,
  type SyncBankTransactionsOptions,
  type SyncBankTransactionsResult,
} from './sync-bank-tx.js';
export {
  syncReceipts,
  type SyncReceiptsConnection,
  type SyncReceiptsOptions,
  type SyncReceiptsResult,
} from './sync-receipts.js';
export {
  syncContacts,
  type SyncContactsConnection,
  type SyncContactsOptions,
  type SyncContactsResult,
} from './sync-contacts.js';
export {
  syncAccounts,
  type SyncAccountsConnection,
  type SyncAccountsOptions,
  type SyncAccountsResult,
} from './sync-accounts.js';

// TODO(p4-cleanup): post-swimlane integration follow-ups identified by
// the B1 code-quality review:
//   1. Extract `parseXeroDate` and `XeroTokenResponse` to a shared
//      `runtime/xero-date.ts` (or `xero-shared/`) module so both
//      xero-accounting and xero-payroll consume one source of truth.
//      Currently duplicated.
//   2. Update payroll error prefixes to include "payroll" so logs
//      distinguish the two modules. Currently payroll says "xero" while
//      accounting says "xero accounting".
//   3. Extract `PAGE_SIZE`, `toDateOnly`, `toAmountString` to a shared
//      `xero-accounting/sync-shared.ts` module. These helpers are now
//      triplicated across sync-invoices.ts, sync-bank-tx.ts, and
//      sync-receipts.ts (3 copies × 3 helpers = 9 identical line-blocks).
//      Cross-cutting cleanup task can sweep all three at once.
// Both touch xero-payroll which is outside Swimlane B's scope. Track
// in a cross-cutting cleanup PR after the swimlanes merge.
