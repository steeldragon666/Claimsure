import type { FastifyInstance } from 'fastify';
import { registerEngagementSend } from './send.js';
import { registerEngagementSign } from './sign.js';
import { registerEngagementCountersign } from './countersign.js';
import { registerEngagementDecline } from './decline.js';
import { registerEngagementGet } from './get.js';
import { registerEngagementGetByToken } from './get-by-token.js';

/**
 * Engagement-letter route surface — Wizard Step 1 (docs/plans/wizard-step-1/).
 *
 * Six endpoints, split across two auth tiers:
 *
 * Session-required (RLS-scoped via `sql.begin` + GUC):
 *   - POST /v1/claims/:id/engagement/send
 *   - POST /v1/engagement/:id/countersign
 *   - GET  /v1/engagement/:id
 *
 * Token-gated public (privilegedSql, no GUC, constant-time token compare):
 *   - GET  /v1/engagement/by-token/:token
 *   - POST /v1/engagement/:token/sign
 *   - POST /v1/engagement/:token/decline
 *
 * Each handler lives in its own file for blame-isolation; this index
 * is a thin barrel.
 *
 * **Path-collision note:** `GET /v1/engagement/:id` and a naive
 * `GET /v1/engagement/:token` would collide in Fastify's radix router
 * (same shape). We disambiguate by prefixing the GET-by-token form with
 * `/by-token/`. The action POSTs (`/sign`, `/decline`, `/countersign`)
 * are already disambiguated by their literal sub-paths.
 */
export function registerEngagementRoutes(app: FastifyInstance): void {
  registerEngagementSend(app);
  registerEngagementGet(app);
  registerEngagementCountersign(app);
  registerEngagementGetByToken(app);
  registerEngagementSign(app);
  registerEngagementDecline(app);
}
