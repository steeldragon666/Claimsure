// MUST be the first import — registers OTel auto-instrumentations before
// any module that fastify/pino/postgres-js depends on is loaded.
import { sdk } from './tracer-init.js';
import { buildApp } from './app.js';

const app = buildApp();

const port = Number(process.env.API_PORT ?? 3000);

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info({ port }, 'api listening');
} catch (err) {
  app.log.error(err);
  await sdk.shutdown();
  process.exit(1);
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  // Capture the timeout handle so it can be cleared if app.close() wins the
  // race — otherwise the unrefed timer still resolves later and leaks logs.
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('app.close() timeout after 25s')), 25_000);
      }),
    ]);
  } catch (err) {
    app.log.error(err, 'shutdown forced');
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
  // SDK shutdown errors should not block process exit; log and continue.
  try {
    await sdk.shutdown();
  } catch (err) {
    app.log.error(err, 'sdk shutdown error');
  }
  process.exit(0);
};

// Wrap signal handlers so unhandled rejections from shutdown() are surfaced
// rather than swallowed. Node listeners must return void; we attach .catch()
// instead of using `void shutdown(...)` so any failure in the handler itself
// is logged and exits non-zero (Kubernetes-friendly).
const handleSignal = (signal: string): void => {
  shutdown(signal).catch((err: unknown) => {
    app.log.error(err, 'shutdown handler unexpected error');
    process.exit(1);
  });
};

process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));
