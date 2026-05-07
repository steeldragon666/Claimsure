import type { FastifyInstance } from 'fastify';
import { registerFederationAuditHook } from './audit-hook.js';
import { registerFederationInvitations } from './invitations.js';
import { registerFederationRevocation } from './revocation.js';
import { registerFederationShares } from './shares.js';

/**
 * P9 Phase 3 — Federation route barrel.
 *
 * Follows the registerX(app) pattern from billing.ts et al.
 * Registered in app.ts inside an app.register() scope.
 */
export function registerFederation(app: FastifyInstance): void {
  registerFederationAuditHook(app);
  registerFederationInvitations(app);
  registerFederationRevocation(app);
  registerFederationShares(app);
}
