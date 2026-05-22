import type { BrowserContext } from '@playwright/test';
import { signSession } from '@cpa/auth';

export interface SessionUser {
  id: string;
  email: string;
  primaryIdp: 'microsoft' | 'google' | 'email' | 'auth0';
  activeTenantId: string | null;
  activeRole: 'admin' | 'consultant' | 'viewer' | null;
  availableTenants: Array<{
    tenantId: string;
    name: string;
    slug: string;
    role: 'admin' | 'consultant' | 'viewer';
  }>;
}

const SESSION_SECRET = process.env['SESSION_JWT_SECRET'] ?? 'dev-only-32-bytes-of-entropy-pad!';

/**
 * Drop a valid cpa_session cookie into the BrowserContext so subsequent
 * navigations are authenticated. Must be called BEFORE page.goto.
 *
 * The OIDC dance is already covered by W2's nock integration tests; e2e
 * focuses on browser-only concerns (cookie persistence, JS state across
 * navigations, optimistic UI). This fixture lets us skip the redirect
 * pageant by directly minting and injecting a JWT the API will accept.
 *
 * Cookie attributes match the production session cookie set by the
 * Fastify /v1/auth/<idp>/callback handler.
 */
export async function signInAs(context: BrowserContext, user: SessionUser): Promise<void> {
  const jwt = await signSession(
    {
      sub: user.id,
      email: user.email,
      primaryIdp: user.primaryIdp,
      activeTenantId: user.activeTenantId,
      activeRole: user.activeRole,
      availableTenants: user.availableTenants,
    },
    SESSION_SECRET,
    { ttlSeconds: 3600 },
  );

  await context.addCookies([
    {
      name: 'cpa_session',
      value: jwt,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
