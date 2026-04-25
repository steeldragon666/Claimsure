import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.literal('api'),
  uptimeSeconds: z.number().nonnegative(),
});

// Fastify plugins may be sync or async. This one has no awaits so it's
// declared sync — eslint's `require-await` flags an `async` keyword with
// no `await` expression. Returning `void` is valid for Fastify plugins.
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
      uptimeSeconds: Math.floor(process.uptime()),
    }),
  );
}
