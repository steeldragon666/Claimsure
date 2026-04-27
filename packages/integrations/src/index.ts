// Barrel export for @cpa/integrations.
// runtime/* hosts the I/O-side stubs we use in app code; the actual
// SES / Stripe / Xero wiring lands per task in C10-C11+.
export * from './runtime/email.js';
