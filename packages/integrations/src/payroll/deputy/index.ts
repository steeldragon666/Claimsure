// Deputy integration (T-B15 / T-B16).
//
// Imported via the `@cpa/integrations/payroll/deputy` subpath or the
// namespaced `payroll/index.ts` re-export.
export * from './types.js';
export * from './oauth.js';
export { listEmployees, listTimesheets } from './client.js';
export type { DeputyClientOptions } from './client.js';
export { syncEmployees } from './employee-sync.js';
export type { SqlClient, SyncEmployeesOpts, SyncEmployeesResult } from './employee-sync.js';
export { pullTimesheets } from './time-entry-pull.js';
export type { PullTimesheetsOpts, PullTimesheetsResult } from './time-entry-pull.js';
