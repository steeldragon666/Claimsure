// MUST be the first import — registers OTel auto-instrumentations before
// any module that fastify/pino/postgres-js depends on is loaded.
import { sdk } from './tracer-init.js';

// TODO(P9.1): Initialize Sentry SDK here using process.env.SENTRY_DSN_API
// SENTRY_DSN_API is already injected by cloudrun-deploy.sh via Secret Manager.
// Prerequisites before activating:
//   pnpm --filter @cpa/api add @sentry/node @sentry/opentelemetry
// Then replace this comment with:
//   import * as Sentry from '@sentry/node';
//   import { buildApiSentryOptions } from '../../../tools/monitoring/sentry-config.js';
//   Sentry.init(buildApiSentryOptions());
// Sentry must init AFTER the OTel SDK starts (above) and BEFORE Fastify loads.
// See tools/monitoring/sentry-config.ts for the canonical options reference.

import { buildApp } from './app.js';
import { evaluate as defaultEvaluate } from '@cpa/agents/suggestion-evaluator';
import { generatePullRequest } from '@cpa/integrations/github-app';
import { buildContractTestRunner } from './lib/contract-test-runner.js';
import { getBoss, stopBoss } from './lib/pg-boss-client.js';
import { registerRifDailyScrapeJob } from './jobs/rif-daily-scrape.js';

const repoRoot = process.env['REPO_ROOT'] ?? process.cwd();

const app = buildApp({
  promptSuggestions: {
    evaluate: (input) =>
      defaultEvaluate({ suggestion: input.suggestion, repoRoot: input.repoRoot }),
    choreograph: (opts) => generatePullRequest(opts),
    runContractTest: buildContractTestRunner({ repoRoot }),
  },
});

const port = Number(process.env.API_PORT ?? 3000);

// pg-boss bootstrap (Task D.0). Lives here in the listening bootstrap
// rather than inside buildApp() because buildApp() is a synchronous
// factory consumed by app.inject()-based tests that must not touch the
// pgboss schema. NODE_ENV=test is the standard guard the test runner
// already sets — see apps/api/package.json `test` script.
if (process.env['NODE_ENV'] !== 'test') {
  try {
    const boss = await getBoss();
    app.log.info('pg-boss started');
    // Register cron jobs
    await registerRifDailyScrapeJob(boss);
    app.log.info('rif-daily-scrape job registered');
  } catch (err) {
    app.log.error(err, 'pg-boss start failed');
    await sdk.shutdown();
    process.exit(1);
  }
}

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
  // Stop pg-boss BEFORE app.close() so any in-flight worker handler
  // gets to finish and ack its job. graceful: true (set in stopBoss())
  // means boss waits for active handlers to return before disconnecting.
  // Errors here should not block app.close() — log and continue.
  try {
    await stopBoss();
  } catch (err) {
    app.log.error(err, 'pg-boss stop error');
  }
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
