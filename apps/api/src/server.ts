// MUST be the first import — force-loads .env values, overriding any
// shell-leaked empty placeholders (notably ANTHROPIC_API_KEY="" from
// Claude Desktop / MCP runtimes on Windows).
import './force-env.js';

// MUST be the first import — registers OTel auto-instrumentations before
// any module that fastify/pino/postgres-js depends on is loaded.
import { sdk } from './tracer-init.js';

// Sentry must init AFTER the OTel SDK starts (above) and BEFORE Fastify
// or any module that uses http/postgres is imported. If SENTRY_DSN is
// unset this is a no-op (Sentry SDK never initialises). See ./sentry-init.ts.
import { initSentry, Sentry } from './sentry-init.js';
initSentry();

import { buildApp } from './app.js';
import { evaluate as defaultEvaluate } from '@cpa/agents/suggestion-evaluator';
import { generatePullRequest } from '@cpa/integrations/github-app';
import { buildContractTestRunner } from './lib/contract-test-runner.js';
import { getBoss, stopBoss } from './lib/pg-boss-client.js';
import { registerRifDailyScrapeJob } from './jobs/rif-daily-scrape.js';
import { registerGoogleDrivePollJob } from './jobs/google-drive-poll.js';
import { registerClaimFinalisationJob } from './jobs/claim-finalisation.js';
import { registerClaimActivityProposalJob } from './jobs/claim-activity-proposal.js';
import { registerClaimEvidenceBindingJob } from './jobs/claim-evidence-binding.js';
import { registerDocumentExtractJob } from './jobs/document-extract.js';
import { registerGenerateApplicationJob } from './jobs/generate-application.js';
import { registerEngagementReminderTickJob } from './jobs/engagement-reminder-tick.js';
import { registerIpSearchReportRenderPdfJob } from './jobs/ip-search-report-render-pdf.js';
import { getPublicBaseUrl, publicUrl } from './lib/public-base-url.js';
import { assertDistinctProductionSecrets, readSecretEnv } from './lib/production-secrets.js';

const repoRoot = process.env['REPO_ROOT'] ?? process.cwd();
const appBaseUrl = getPublicBaseUrl();
const sessionSecret = readSecretEnv('SESSION_JWT_SECRET', {
  devFallback: 'dev-only-32-bytes-of-entropy-pad!',
});
const verificationSecret = readSecretEnv('SIGNUP_VERIFICATION_SECRET', {
  devFallback: process.env['SESSION_JWT_SECRET'] ?? 'dev-only-signup-verification-pad!!',
});
assertDistinctProductionSecrets(
  'SESSION_JWT_SECRET',
  sessionSecret,
  'SIGNUP_VERIFICATION_SECRET',
  verificationSecret,
);
const cookieName = process.env['SESSION_COOKIE_NAME'] ?? 'cpa_session';
const cookieSecure = process.env['NODE_ENV'] === 'production';
const ttlSeconds = Number(process.env['SESSION_TTL_SECONDS'] ?? 24 * 60 * 60);

async function sendSignupVerificationEmail(to: string, token: string): Promise<void> {
  const verifyUrl = publicUrl(`/verify-email?token=${encodeURIComponent(token)}`);
  const { createResendClient, createEmailSender } = await import('@cpa/email');
  const resendApiKey = process.env['RESEND_API_KEY'];
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  const client = createResendClient({ apiKey: resendApiKey });
  const sender = createEmailSender(client, {
    fromAddress:
      process.env['SIGNUP_FROM_ADDRESS'] ??
      process.env['BETA_FROM_ADDRESS'] ??
      'ArchiveOne <noreply@archiveone.com.au>',
  });

  await sender.send({
    to,
    subject: 'Verify your ArchiveOne workspace signup',
    text: `Complete your ArchiveOne workspace signup:\n\n${verifyUrl}\n\nThis link expires in 24 hours.`,
    html: `<p>Complete your ArchiveOne workspace signup:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours.</p>`,
  });
}

const app = buildApp({
  promptSuggestions: {
    evaluate: (input) =>
      defaultEvaluate({ suggestion: input.suggestion, repoRoot: input.repoRoot }),
    choreograph: (opts) => generatePullRequest(opts),
    runContractTest: buildContractTestRunner({ repoRoot }),
  },
  signup: {
    sessionSecret,
    verificationSecret,
    cookieName,
    cookieSecure,
    ttlSeconds,
    sendVerificationEmail: sendSignupVerificationEmail,
    allowManualVerification:
      process.env['SIGNUP_EMAIL_MODE'] === 'manual' || process.env['NODE_ENV'] !== 'production',
    verificationBaseUrl: appBaseUrl,
  },
});

// Port resolution: prefer PORT (Railway/Fly/Render/Heroku inject this) →
// API_PORT (local convention, lets you run web on 5173 + api on 3000 without
// collision) → 3000 (Dockerfile EXPOSE matches).
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3000);

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
    await registerGoogleDrivePollJob(boss);
    app.log.info('google-drive-poll job registered');
    await registerClaimFinalisationJob(boss);
    app.log.info('claim-finalisation job registered');
    await registerClaimActivityProposalJob(boss);
    app.log.info('claim-activity-proposal job registered');
    await registerClaimEvidenceBindingJob(boss);
    app.log.info('claim-evidence-binding job registered');
    await registerDocumentExtractJob(boss);
    app.log.info('document-extract job registered');
    await registerGenerateApplicationJob(boss);
    app.log.info('generate-application job registered');
    // Wizard Step 1 Task 04 — daily engagement-letter reminder + auto-expire
    // tick. Lazy-imports the @cpa/email transport so the dependency only
    // resolves in the boot path (test harness uses NODE_ENV=test which
    // short-circuits this whole block above).
    const { createResendClient, createEmailSender } = await import('@cpa/email');
    const resendApiKey = process.env['RESEND_API_KEY'];
    if (resendApiKey !== undefined && resendApiKey.length > 0) {
      const reminderClient = createResendClient({ apiKey: resendApiKey });
      const reminderSender = createEmailSender(reminderClient, {
        fromAddress:
          process.env['ENGAGEMENT_FROM_ADDRESS'] ??
          process.env['BETA_FROM_ADDRESS'] ??
          'ArchiveOne <noreply@archiveone.com.au>',
      });
      await registerEngagementReminderTickJob(boss, reminderSender);
      app.log.info('engagement-reminder-tick job registered');
    } else {
      app.log.warn(
        'RESEND_API_KEY unset — engagement-reminder-tick job not registered (configure to enable)',
      );
    }
    await registerIpSearchReportRenderPdfJob(boss);
    app.log.info('ip-search-report-render-pdf job registered');
  } catch (err) {
    // Pino async transport can swallow this when process.exit(1) fires before
    // flush (observed on Railway boot crashes). Write to stderr synchronously
    // FIRST so the underlying error is always visible in container logs,
    // then also log via Pino for structured-log consumers.
    console.error('[BOOT FAILURE] pg-boss start failed:', err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    app.log.error(err, 'pg-boss start failed');
    await sdk.shutdown();
    process.exit(1);
  }
}

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info({ port }, 'api listening');
} catch (err) {
  console.error('[BOOT FAILURE] app.listen failed:', err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  app.log.error(err);
  await sdk.shutdown();
  process.exit(1);
}

// Global safety net: anything that escapes the try/catches above (e.g.
// synchronous throws inside instrumentation hooks, unhandledRejections
// from async middleware) still gets surfaced before the process dies.
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  if (err.stack) console.error(err.stack);
  Sentry.captureException(err);
  // Best-effort flush before exit; bounded so we never hang the container.
  void Sentry.close(2000).finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  if (reason instanceof Error && reason.stack) console.error(reason.stack);
  Sentry.captureException(reason);
  void Sentry.close(2000).finally(() => process.exit(1));
});

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
