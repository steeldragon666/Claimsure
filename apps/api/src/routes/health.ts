import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkDb, defaultRunQuery } from '../db.js';

const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.literal('api'),
  processUptimeSeconds: z.number().nonnegative(),
});

const ReadyResponse = z.object({
  status: z.enum(['ready', 'degraded']),
  checks: z.object({
    db: z.object({
      ok: z.boolean(),
      latencyMs: z.number().nonnegative(),
    }),
  }),
});

// Fastify plugins may be sync or async. This one has no awaits so it's
// declared sync — eslint's `require-await` flags an `async` keyword with
// no `await` expression. Returning `void` is valid for Fastify plugins.
// Individual route handlers may still be async (see /readyz below).
export function healthRoutes(app: FastifyInstance): void {
  app.get(
    '/healthz',
    {
      schema: {
        response: { 200: HealthResponse },
      },
    },
    () => ({
      status: 'ok' as const,
      service: 'api' as const,
      processUptimeSeconds: Math.floor(process.uptime()),
    }),
  );

  app.get(
    '/readyz',
    {
      schema: {
        response: { 200: ReadyResponse, 503: ReadyResponse },
      },
    },
    async (req, reply) => {
      const db = await checkDb(defaultRunQuery, req.log);
      const status = db.ok ? ('ready' as const) : ('degraded' as const);
      const code = db.ok ? 200 : 503;
      return reply.code(code).send({ status, checks: { db } });
    },
  );
}
