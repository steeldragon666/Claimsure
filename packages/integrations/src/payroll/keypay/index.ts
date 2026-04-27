// KeyPay integration (T-B12 / T-B13).
//
// Imported via the `@cpa/integrations/payroll/keypay` subpath or the
// namespaced `payroll/index.ts` re-export.
export * from './types.js';
export { listEmployees, listTimesheets } from './client.js';
export { syncEmployees } from './employee-sync.js';
export type { SqlClient, SyncEmployeesOpts, SyncEmployeesResult } from './employee-sync.js';
export { pullTimesheets } from './time-entry-pull.js';
export type { PullTimesheetsOpts, PullTimesheetsResult } from './time-entry-pull.js';
