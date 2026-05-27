/**
 * Sentry browser-runtime config for Next.js.
 *
 * Loaded automatically by `@sentry/nextjs` on the client. The DSN must be
 * exposed to the browser via NEXT_PUBLIC_SENTRY_DSN; SENTRY_DSN (without
 * the NEXT_PUBLIC_ prefix) is server-only and is not visible here.
 *
 * No-op when NEXT_PUBLIC_SENTRY_DSN is unset.
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (!dsn) {
  console.warn('[sentry/client] NEXT_PUBLIC_SENTRY_DSN not set — Sentry is disabled');
} else {
  const env = process.env.NODE_ENV ?? 'development';
  Sentry.init({
    dsn,
    environment: env,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? 'unknown',
    tracesSampleRate: env === 'production' ? 0.1 : 1.0,
    beforeSend(event) {
      // Browser PII scrubbing mirrors the server side.
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
      // Drop noise from browser extensions injecting into the page.
      const frames = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
      if (
        frames.some(
          (f) =>
            f.filename?.startsWith('chrome-extension://') ||
            f.filename?.startsWith('moz-extension://'),
        )
      ) {
        return null;
      }
      return event;
    },
  });
}
