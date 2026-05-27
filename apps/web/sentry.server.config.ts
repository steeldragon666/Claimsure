/**
 * Sentry server-runtime config for Next.js (Node.js).
 *
 * Loaded by `instrumentation.ts` when the Next.js server runtime is Node.
 * No-op when SENTRY_DSN is unset.
 *
 * PII scrubbing mirrors apps/api/src/sentry-init.ts so the two services
 * share one redaction contract.
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (!dsn) {
  console.warn('[sentry/server] SENTRY_DSN not set — Sentry is disabled');
} else {
  const env = process.env.NODE_ENV ?? 'development';
  Sentry.init({
    dsn,
    environment: env,
    release:
      process.env.SENTRY_RELEASE ??
      process.env.RAILWAY_GIT_COMMIT_SHA ??
      process.env.GIT_COMMIT_SHA ??
      'unknown',
    tracesSampleRate: env === 'production' ? 0.1 : 1.0,
    beforeSend(event) {
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
      }
      if (event.request) {
        delete event.request.cookies;
        if (event.request.headers) {
          for (const key of Object.keys(event.request.headers)) {
            if (key.toLowerCase() === 'authorization') {
              delete event.request.headers[key];
            }
          }
        }
      }
      return event;
    },
  });
}
