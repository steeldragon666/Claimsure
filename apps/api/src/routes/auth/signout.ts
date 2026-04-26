import type { FastifyInstance } from 'fastify';

export interface SignoutConfig {
  cookieName: string;
  cookieSecure: boolean;
}

/**
 * Register POST /v1/auth/signout — clears the session cookie.
 *
 * Stateless: no DB write, no token revocation list. The 24h JWT
 * lifetime (W2 design Q3) caps a stolen-cookie blast radius
 * regardless of whether signout was called. Server-side
 * revocation is a P3+ concern (refresh-token rotation lands
 * with it).
 *
 * Returns 204 No Content on success — even if the user wasn't
 * authenticated. Idempotent.
 */
export function registerSignout(app: FastifyInstance, cfg: SignoutConfig): void {
  app.post('/v1/auth/signout', async (_req, reply) => {
    void reply.header(
      'set-cookie',
      `${cfg.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cfg.cookieSecure ? '; Secure' : ''}`,
    );
    return reply.status(204).send();
  });
}
