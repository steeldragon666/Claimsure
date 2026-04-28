import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createLogger } from '@cpa/observability';
import { sessionPlugin } from '@cpa/auth';
import { registerHostnameTenantResolver } from './middleware/hostname-tenant-resolver.js';
import { registerActivities } from './routes/activities.js';
import { registerActivityPdf } from './routes/activity-pdf.js';
import { registerArtefactLinks } from './routes/artefact-links.js';
import { registerGoogleAuth } from './routes/auth/google.js';
import { registerMicrosoftAuth } from './routes/auth/microsoft.js';
import { registerSignout } from './routes/auth/signout.js';
import { healthRoutes } from './routes/health.js';
import { registerAuditScore } from './routes/audit-score.js';
import { registerBrandConfig } from './routes/brand-config.js';
import { registerClaimantMagicLinkRedeem } from './routes/claimant-magic-link.js';
import { registerClaimantStatus } from './routes/claimant-status.js';
import { registerClaims } from './routes/claims.js';
import { registerEmployees } from './routes/employees.js';
import { registerMagicLinkRedeem } from './routes/magic-link.js';
import { registerMedia } from './routes/media.js';
import { registerMobileEvents } from './routes/mobile-events.js';
import { registerRefreshRoute } from './routes/mobile-session.js';
import { registerEvents } from './routes/events.js';
import { registerIntegrations } from './routes/integrations.js';
import { registerProjects } from './routes/projects.js';
import { registerSigning, registerDocuSignWebhookPlugin } from './routes/signing.js';
import { registerSubjectTenants } from './routes/subject-tenants.js';
import { registerTimeEntries } from './routes/time-entries.js';
import { registerListTenants } from './routes/tenants/list.js';
import { registerSwitchTenant } from './routes/tenants/switch.js';
import { registerAddUser } from './routes/users/add.js';
import { registerGetUser } from './routes/users/get.js';
import { registerListUsers } from './routes/users/list.js';
import { registerRemoveUser } from './routes/users/remove.js';
import { registerUpdateUser } from './routes/users/update.js';
import { registerWhoami } from './routes/whoami.js';

const DEFAULT_DEV_SESSION_SECRET = 'dev-only-32-bytes-of-entropy-pad!';
const DEFAULT_SESSION_COOKIE_NAME = 'cpa_session';
const DEFAULT_SESSION_TTL_SECONDS = 86400; // 24h per W2 design Q3
const DEFAULT_POST_LOGIN_REDIRECT = '/';

/**
 * The Fastify app type, widened to FastifyBaseLogger for portability
 * (pino satisfies FastifyBaseLogger structurally). This widening is
 * what lets us return a stable type from buildApp() without leaking
 * pino through the public surface.
 *
 * The Logger generic is widened to `FastifyBaseLogger` (Fastify's own
 * interface) rather than the underlying pino type. Pino satisfies the
 * structural shape, but referencing pino here would leak its type-only
 * dependency from `@cpa/observability` into our public `buildApp`
 * signature — `tsc` rejects that as non-portable. `FastifyBaseLogger`
 * captures everything we use (`info`, `error`, `child`).
 *
 * Tests import this directly: `import { buildApp, type App } from '../app.js';`
 * No barrel — apps don't expose internal types as a package surface.
 */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/**
 * Build the Fastify app instance.
 *
 * Pure factory — does NOT start listening. Tests call this directly and
 * use `app.inject()` for in-process request/response. The bootstrap
 * (`server.ts`) calls `app.listen()` separately.
 *
 * The cast at the end widens Fastify's pino-specific instance type to
 * `App` (which uses `FastifyBaseLogger`). Pino is structurally
 * compatible — Fastify just narrows the generic when you pass
 * `loggerInstance`, which would otherwise leak the pino dependency
 * through our public signature.
 */
export function buildApp(): App {
  const logger = createLogger({ serviceName: 'api' });

  const app = Fastify({
    loggerInstance: logger,
    // Trust X-Forwarded-* only in production where we sit behind a managed
    // load balancer (App Runner / ECS Fargate / Cloudflare). In dev, blanket
    // trust would let an attacker spoof client IPs via X-Forwarded-For.
    trustProxy: process.env.NODE_ENV === 'production',
    // Force-close idle connections at app.close() so SIGTERM doesn't hang
    // on a slow/long-poll request and let the orchestrator SIGKILL us
    // before the trace flush. In-flight requests still get to finish.
    forceCloseConnections: 'idle',
    // Audit-correlation request IDs as v4 UUIDs, matching the @cpa/schemas
    // Uuid contract. Pino's request log line includes reqId automatically.
    // P1's identity layer can swap to ULIDs later without restructuring.
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Cookie parsing for session reads. No global secret — JWTs carry their
  // own integrity via jose; cookies are just transport. Registered before
  // routes so session-aware handlers can read req.cookies.
  app.register(cookie);

  // Hostname → tenant resolver (T-F4). Runs as a global preHandler so any
  // route can read req.resolvedBrand. Registered BEFORE the session plugin
  // so even unauthenticated routes (mobile-launch brand-config GET, magic-
  // link redeem) get the resolution. The lookup goes via privilegedSql —
  // see middleware/hostname-tenant-resolver.ts for the rationale.
  app.register((instance, _opts, done) => {
    registerHostnameTenantResolver(instance);
    done();
  });

  // Session middleware: verifies cpa_session cookie, attaches req.user,
  // sets app.current_tenant_id GUC for RLS-scoped queries.
  // Production must set SESSION_JWT_SECRET (the dev default is a constant
  // string and is NOT secure for any non-local environment).
  const sessionSecret = process.env['SESSION_JWT_SECRET'] ?? DEFAULT_DEV_SESSION_SECRET;
  const cookieName = process.env['SESSION_COOKIE_NAME'] ?? DEFAULT_SESSION_COOKIE_NAME;
  app.register(sessionPlugin, { secret: sessionSecret, cookieName });

  app.register(healthRoutes);

  // Identity routes — always registered (no env dependencies):
  // - POST /v1/auth/signout: clears the session cookie (idempotent)
  // - GET  /v1/whoami: returns the current user + tenant + memberships
  // Wrapped in app.register so Fastify resolves the instance type to
  // its plugin-default shape (which the helpers accept), avoiding the
  // pino-narrowed type leak from the outer buildApp scope.
  app.register((instance, _opts, done) => {
    registerSignout(instance, {
      cookieName,
      cookieSecure: process.env['NODE_ENV'] === 'production',
    });
    done();
  });
  app.register((instance, _opts, done) => {
    registerWhoami(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerListTenants(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerSwitchTenant(instance, {
      sessionSecret,
      cookieName,
      cookieSecure: process.env['NODE_ENV'] === 'production',
      ttlSeconds,
    });
    done();
  });
  app.register((instance, _opts, done) => {
    registerListUsers(instance);
    registerGetUser(instance);
    registerAddUser(instance);
    registerUpdateUser(instance);
    registerRemoveUser(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerSubjectTenants(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerEvents(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerTimeEntries(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerEmployees(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerMagicLinkRedeem(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerClaimantMagicLinkRedeem(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerClaimantStatus(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerAuditScore(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerRefreshRoute(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerMobileEvents(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerMedia(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerBrandConfig(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerIntegrations(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerClaims(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerProjects(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerActivities(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerArtefactLinks(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerActivityPdf(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerSigning(instance);
    done();
  });
  // DocuSign Connect webhook is registered as its own plugin so the
  // application/json content-type parser is encapsulated to that one
  // route (the handler needs the raw Buffer to HMAC-verify).
  app.register((instance, _opts, done) => {
    registerDocuSignWebhookPlugin(instance);
    done();
  });

  // OIDC routes only register when both clientId AND clientSecret are
  // present. In tests + bare-bones dev, env vars are unset and the
  // routes simply don't exist; the rest of the API still works. This
  // avoids a network call to Issuer.discover during cold start when
  // we don't even have credentials configured.
  const cookieSecure = process.env['NODE_ENV'] === 'production';
  const ttlSeconds = Number(process.env['SESSION_TTL_SECONDS'] ?? DEFAULT_SESSION_TTL_SECONDS);

  const msClientId = process.env['MICROSOFT_OIDC_CLIENT_ID'];
  const msClientSecret = process.env['MICROSOFT_OIDC_CLIENT_SECRET'];
  if (msClientId && msClientSecret) {
    app.register(async (instance) => {
      await registerMicrosoftAuth(instance, {
        tenantId: process.env['MICROSOFT_OIDC_TENANT'] ?? 'common',
        clientId: msClientId,
        clientSecret: msClientSecret,
        redirectUri:
          process.env['MICROSOFT_OIDC_REDIRECT_URI'] ??
          'http://localhost:3000/v1/auth/microsoft/callback',
        sessionSecret,
        cookieName,
        cookieSecure,
        ttlSeconds,
        postLoginRedirect: DEFAULT_POST_LOGIN_REDIRECT,
      });
    });
  }

  const gClientId = process.env['GOOGLE_OIDC_CLIENT_ID'];
  const gClientSecret = process.env['GOOGLE_OIDC_CLIENT_SECRET'];
  if (gClientId && gClientSecret) {
    app.register(async (instance) => {
      await registerGoogleAuth(instance, {
        clientId: gClientId,
        clientSecret: gClientSecret,
        redirectUri:
          process.env['GOOGLE_OIDC_REDIRECT_URI'] ??
          'http://localhost:3000/v1/auth/google/callback',
        sessionSecret,
        cookieName,
        cookieSecure,
        ttlSeconds,
        postLoginRedirect: DEFAULT_POST_LOGIN_REDIRECT,
      });
    });
  }

  // Single error envelope across all routes — { error, message, requestId }.
  // Errors with a numeric `statusCode` use that; everything else 500s.
  // The shape will be formalised in @cpa/schemas in P1; for now this is
  // the convention.
  app.setErrorHandler((err, req, reply) => {
    // The typed-provider chain widens err to `unknown`; treat it as an
    // Error-shaped object with optional statusCode. All thrown values
    // we surface here originate from Fastify or our own routes, both of
    // which produce Error instances, so .name/.message are present.
    const e = err as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status >= 500) {
      app.log.error({ err: e, reqId: req.id }, 'request failed');
    } else {
      app.log.warn({ err: e, reqId: req.id }, 'request failed');
    }
    void reply.code(status).send({
      error: e.name || 'InternalServerError',
      message: e.message,
      requestId: req.id,
    });
  });

  // Double-cast through `unknown` is required because of two interacting
  // TypeScript strictness settings in tsconfig.base.json:
  //   1. `loggerInstance: pino.Logger` narrows Fastify's `Logger` generic
  //      to `pino.Logger` (not the wider `FastifyBaseLogger`).
  //   2. `exactOptionalPropertyTypes: true` prevents widening that narrow
  //      back to `FastifyBaseLogger` at the `as App` boundary.
  // We deliberately widen here so callers (incl. tests) consume `App`
  // without leaking pino through the public surface. Verified empirically:
  // direct `app as App` fails with TS2352. See P0 review item I3.
  return app as unknown as App;
}
