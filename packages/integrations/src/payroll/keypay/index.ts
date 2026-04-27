// KeyPay integration (T-B12 / T-B13).
//
// Imported via the `@cpa/integrations/payroll/keypay` subpath or the
// namespaced `payroll/index.ts` re-export.
export * from './types.js';
export { listEmployees, listTimesheets } from './client.js';
// employee-sync + time-entry-pull added in B13
