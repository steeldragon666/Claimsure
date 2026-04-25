import { startTracing } from '@cpa/observability';
import { buildApp } from './app.js';

const sdk = startTracing({ serviceName: 'api', serviceVersion: '0.0.0' });

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
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('app.close() timeout after 25s')), 25_000),
      ),
    ]);
  } catch (err) {
    app.log.error(err, 'shutdown forced');
  }
  await sdk.shutdown();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
