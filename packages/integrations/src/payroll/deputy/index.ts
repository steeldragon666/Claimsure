// Deputy integration (T-B15 / T-B16).
//
// Imported via the `@cpa/integrations/payroll/deputy` subpath or the
// namespaced `payroll/index.ts` re-export.
export * from './types.js';
export * from './oauth.js';
export { listEmployees, listTimesheets } from './client.js';
export type { DeputyClientOptions } from './client.js';
