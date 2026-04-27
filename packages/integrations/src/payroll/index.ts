// Payroll integrations namespace.
//
// Each provider lives in its own subdirectory and is exposed here under
// a namespace alias so callers can do `payroll.employmentHero.syncEmployees(...)`
// without name collisions across providers (employee/timesheet types repeat).
//
// Per-provider deep imports also work via subpath exports declared in
// `package.json` — e.g. `@cpa/integrations/payroll/employment-hero`.
export * as employmentHero from './employment-hero/index.js';
export * as keypay from './keypay/index.js';
export * as deputy from './deputy/index.js';
