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
import { healthRoutes } from './routes/health.js';

/**
 * The concrete app type — `FastifyInstance` parameterised with our
 * `ZodTypeProvider` so route response/body validation is zod-aware.
 *
 * The Logger generic is widened to `FastifyBaseLogger` (Fastify's own
 * interface) rather than the underlying pino type. Pino satisfies the
 * structural shape, but referencing pino here would leak its type-only
 * dependency from `@cpa/observability` into our public `buildApp`
 * signature — `tsc` rejects that as non-portable. `FastifyBaseLogger`
 * captures everything we use (`info`, `error`, `child`).
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
    disableRequestLogging: false,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(healthRoutes);

  return app as unknown as App;
}
