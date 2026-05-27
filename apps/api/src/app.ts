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
import { registerActivityRegister } from './routes/activity-register.js';
import { registerNarrative } from './routes/narrative.js';
import { registerNarrativeAccept } from './routes/narrative-accept.js';
import { registerPendingNarrative } from './routes/pending-narrative.js';
import { registerPipelineStatus } from './routes/pipeline-status.js';
import { registerProposedActivities } from './routes/proposed-activities.js';
import { registerGenerateApplication } from './routes/generate-application.js';
import { registerInsights } from './routes/insights.js';
import { registerClaimBudget } from './routes/claim-budget.js';
import { registerPortalFields } from './routes/portal-fields.js';
import { registerApplyRules } from './routes/apply-rules.js';
import { registerArtefactLinks } from './routes/artefact-links.js';
import { registerAuth0Auth } from './routes/auth/auth0.js';
import { registerGoogleAuth } from './routes/auth/google.js';
import { registerMicrosoftAuth } from './routes/auth/microsoft.js';
import { registerDevLogin } from './routes/auth/dev-login.js';
import { registerSignout } from './routes/auth/signout.js';
import { healthRoutes } from './routes/health.js';
import { registerAuditScore } from './routes/audit-score.js';
import { registerAuditTimeline } from './routes/audit-timeline.js';
import { registerMultiEntityComparison } from './routes/multi-entity-comparison.js';
import { registerBrandConfig } from './routes/brand-config.js';
import { registerClaimantMagicLinkRedeem } from './routes/claimant-magic-link.js';
import { registerClaimantStatus } from './routes/claimant-status.js';
import { registerClaimants } from './routes/claimants.js';
import { registerClaimPdf } from './routes/claim-pdf.js';
import { registerClaimWorkflow } from './routes/claim-workflow.js';
import { registerClaims } from './routes/claims.js';
import { registerEmployees } from './routes/employees.js';
import { registerMagicLinkRedeem } from './routes/magic-link.js';
import { registerMedia } from './routes/media.js';
import { registerMobileEvents } from './routes/mobile-events.js';
import { registerRefreshRoute } from './routes/mobile-session.js';
import { registerEvents } from './routes/events.js';
import { registerExpenditures } from './routes/expenditures.js';
import { registerIntegrations } from './routes/integrations.js';
import { registerProjects } from './routes/projects.js';
import { registerSigning, registerDocuSignWebhookPlugin } from './routes/signing.js';
import { registerGithubWebhookPlugin } from './routes/webhooks/github.js';
import { registerSubjectTenants } from './routes/subject-tenants.js';
import { registerTimeEntries } from './routes/time-entries.js';
import { registerMappingRules } from './routes/mapping-rules.js';
import { registerPreviewRules } from './routes/preview-rules.js';
import {
  registerPromptSuggestions,
  type PromptSuggestionsRouteDeps,
} from './routes/prompt-suggestions.js';
import { registerBilling, type BillingRouteDeps } from './routes/billing.js';
import { registerBillingPlan } from './routes/billing-plan.js';
import { registerBillingPortal } from './routes/billing-portal.js';
import { registerInvoices } from './routes/invoices.js';
import {
  registerBillingWebhookPlugin,
  type BillingWebhookRouteDeps,
} from './routes/billing-webhook.js';
import { registerSignupRoutes, type SignupRouteDeps } from './routes/auth/signup.js';
import { registerTenantActivationGate } from './middleware/auth.js';
import { registerCompliance } from './routes/compliance.js';
import { registerIntelligence } from './routes/intelligence.js';
import { registerListTenants } from './routes/tenants/list.js';
import { registerSwitchTenant } from './routes/tenants/switch.js';
import { registerAddUser } from './routes/users/add.js';
import { registerGetUser } from './routes/users/get.js';
import { registerListUsers } from './routes/users/list.js';
import { registerRemoveUser } from './routes/users/remove.js';
import { registerUpdateUser } from './routes/users/update.js';
import { registerWhoami } from './routes/whoami.js';
import { registerFederation } from './routes/federation/index.js';
import { registerCloudSync } from './routes/cloud-sync.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerConsultantChain } from './routes/consultant/chain.js';
import { registerConsultantKpis } from './routes/consultant/kpis.js';
import { registerConsultantSignals } from './routes/consultant/signals.js';
import { publicUrl } from './lib/public-base-url.js';

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
/**
 * Optional dependency-injection bag for buildApp. Production callers
 * (server.ts) leave this empty and let the app read env vars at request
 * time. Tests pass mocks here — particularly for the prompt-suggestions
 * generate-pr endpoint (Task B.5), which calls Anthropic + GitHub.
 */
export interface BuildAppOptions {
  promptSuggestions?: PromptSuggestionsRouteDeps;
  billing?: BillingRouteDeps;
  billingWebhook?: BillingWebhookRouteDeps;
  signup?: SignupRouteDeps;
}

export function buildApp(options: BuildAppOptions = {}): App {
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

  // Tenant activation gate — P9.1.7.
  // app.after() defers hook registration until after sessionPlugin has
  // initialised (plugins initialise in registration order). Both the session
  // preHandler and the gate preHandler end up in the root scope, so Fastify
  // runs them for every route — session first (index 0), gate second (index 1).
  app.after(() => {
    registerTenantActivationGate(app as unknown as FastifyInstance);
  });

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
    registerExpenditures(instance);
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
    registerClaimants(instance, options.billing ? { stripe: options.billing.stripe } : undefined);
    done();
  });
  app.register((instance, _opts, done) => {
    registerAuditScore(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerAuditTimeline(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerMultiEntityComparison(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerClaimPdf(instance);
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
    registerClaims(instance, options.billing ? { stripe: options.billing.stripe } : undefined);
    done();
  });
  app.register((instance, _opts, done) => {
    registerClaimWorkflow(instance);
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
    registerActivityRegister(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerNarrative(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerNarrativeAccept(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerPendingNarrative(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerPipelineStatus(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerProposedActivities(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerGenerateApplication(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerInsights(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerClaimBudget(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerPortalFields(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerApplyRules(instance);
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
  app.register((instance, _opts, done) => {
    registerMappingRules(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerPreviewRules(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerCompliance(instance);
    done();
  });
  app.register((instance, _opts, done) => {
    registerIntelligence(instance);
    done();
  });
  // P9.3 Federation routes — cross-tenant read sharing.
  app.register((instance, _opts, done) => {
    registerFederation(instance);
    done();
  });
  // Cloud sync connector routes (Google Drive OAuth + connection CRUD).
  app.register((instance, _opts, done) => {
    registerCloudSync(instance);
    done();
  });
  // Cross-claimant evidence feed (GET /v1/evidence).
  app.register((instance, _opts, done) => {
    registerEvidenceRoutes(instance);
    done();
  });
  // Consultant dashboard chain feed (GET /v1/consultant/chain/recent) — D3.
  app.register((instance, _opts, done) => {
    registerConsultantChain(instance);
    done();
  });
  // Consultant dashboard signals feed (GET /v1/consultant/signals) — D2.
  app.register((instance, _opts, done) => {
    registerConsultantSignals(instance);
    done();
  });
  // Consultant dashboard KPI strip (GET /v1/consultant/kpis) — D4.
  app.register((instance, _opts, done) => {
    registerConsultantKpis(instance);
    done();
  });
  // Prompt-suggestions routes require explicit deps (esp. `runContractTest`,
  // which closes the I3 skip-gate at the type level — see
  // PromptSuggestionsRouteDeps in routes/prompt-suggestions.ts). Tests that
  // do not exercise these routes call `buildApp()` without
  // `options.promptSuggestions` and simply don't get them registered.
  if (options.promptSuggestions) {
    app.register((instance, _opts, done) => {
      registerPromptSuggestions(instance, options.promptSuggestions!);
      done();
    });
  }
  if (options.billing) {
    app.register((instance, _opts, done) => {
      registerBilling(instance, options.billing!);
      registerBillingPlan(instance, options.billing!);
      registerBillingPortal(instance, options.billing!);
      registerInvoices(instance, options.billing!);
      done();
    });
  }
  if (options.billingWebhook) {
    app.register((instance, _opts, done) => {
      registerBillingWebhookPlugin(instance, options.billingWebhook!);
      done();
    });
  }
  if (options.signup) {
    app.register((instance, _opts, done) => {
      registerSignupRoutes(instance, options.signup!);
      done();
    });
  }
  // DocuSign Connect webhook is registered as its own plugin so the
  // application/json content-type parser is encapsulated to that one
  // route (the handler needs the raw Buffer to HMAC-verify).
  app.register((instance, _opts, done) => {
    registerDocuSignWebhookPlugin(instance);
    done();
  });
  // GitHub webhook receiver (Task B.6). Same encapsulation pattern as
  // the DocuSign webhook — the application/json parser is overridden to
  // give us the raw Buffer for HMAC-SHA256 verification.
  app.register((instance, _opts, done) => {
    registerGithubWebhookPlugin(instance);
    done();
  });

  const cookieSecure = process.env['NODE_ENV'] === 'production';
  const ttlSeconds = Number(process.env['SESSION_TTL_SECONDS'] ?? DEFAULT_SESSION_TTL_SECONDS);
  // External login providers are disabled while ArchiveOne uses approved
  // signup as the only public account path.
  const publicLoginRoutesEnabled = false;

  const msClientId = process.env['MICROSOFT_OIDC_CLIENT_ID'];
  const msClientSecret = process.env['MICROSOFT_OIDC_CLIENT_SECRET'];
  if (publicLoginRoutesEnabled && msClientId && msClientSecret) {
    app.register(async (instance) => {
      await registerMicrosoftAuth(instance, {
        tenantId: process.env['MICROSOFT_OIDC_TENANT'] ?? 'common',
        clientId: msClientId,
        clientSecret: msClientSecret,
        redirectUri:
          process.env['MICROSOFT_OIDC_REDIRECT_URI'] ?? publicUrl('/v1/auth/microsoft/callback'),
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
  if (publicLoginRoutesEnabled && gClientId && gClientSecret) {
    app.register(async (instance) => {
      await registerGoogleAuth(instance, {
        clientId: gClientId,
        clientSecret: gClientSecret,
        redirectUri:
          process.env['GOOGLE_OIDC_REDIRECT_URI'] ?? publicUrl('/v1/auth/google/callback'),
        sessionSecret,
        cookieName,
        cookieSecure,
        ttlSeconds,
        postLoginRedirect: DEFAULT_POST_LOGIN_REDIRECT,
      });
    });
  }

  // GET /v1/dev/login — escape-hatch route that mints a real cpa_session
  // for an existing user. ONLY registers when DEV_LOGIN_TOKEN is set
  // in the env — production deployments without that env var see a
  // 404 on this path. Designed for founder/operator emergency access
  // when OIDC isn't configured or the IdP is down.
  // See: apps/api/src/routes/auth/dev-login.ts for the full contract.
  const auth0Domain = process.env['AUTH0_DOMAIN'];
  const auth0ClientId = process.env['AUTH0_CLIENT_ID'];
  const auth0ClientSecret = process.env['AUTH0_CLIENT_SECRET'];
  if (publicLoginRoutesEnabled && auth0Domain && auth0ClientId && auth0ClientSecret) {
    app.register(async (instance) => {
      await registerAuth0Auth(instance, {
        domain: auth0Domain,
        clientId: auth0ClientId,
        clientSecret: auth0ClientSecret,
        redirectUri: process.env['AUTH0_REDIRECT_URI'] ?? publicUrl('/v1/auth/auth0/callback'),
        sessionSecret,
        cookieName,
        cookieSecure,
        ttlSeconds,
        postLoginRedirect: process.env['AUTH0_POST_LOGIN_REDIRECT'] ?? DEFAULT_POST_LOGIN_REDIRECT,
      });
    });
  }

  const devLoginToken = process.env['DEV_LOGIN_TOKEN'];
  if (publicLoginRoutesEnabled && devLoginToken) {
    app.register((instance, _opts, done) => {
      registerDevLogin(instance, {
        bypassToken: devLoginToken,
        sessionSecret,
        cookieName,
        cookieSecure,
        ttlSeconds,
      });
      done();
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
