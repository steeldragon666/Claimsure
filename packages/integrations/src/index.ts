// Barrel export for @cpa/integrations.
// runtime/* hosts the cross-cutting helpers (oauth, retry, rate-limit,
// webhook-verify, email, types). Per-provider clients (deepgram,
// docusign, payroll/*, xero-accounting, github-app) live in their own
// subpath exports — import from '@cpa/integrations/deepgram',
// '@cpa/integrations/github-app', etc. directly.
export * from './runtime/index.js';
