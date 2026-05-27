/**
 * Sentry initialisation for the Fastify API.
 *
 * Imported by `./server.ts` after `./tracer-init.js` and BEFORE `./app.js`
 * so that Sentry's instrumentations can attach to http / postgres / etc.
 * before any module that uses them is loaded.
 *
 * Behaviour:
 *   - If `SENTRY_DSN` (or legacy `SENTRY_DSN_API`) is unset, this is a no-op
 *     beyond a single console.warn. The Sentry SDK is not even initialised,
 *     so it cannot impose runtime cost or send accidental events.
 *   - If set, Sentry initialises with PII scrubbing in `beforeSend`.
 *
 * PII scrubbing removes:
 *   - event.user.email
 *   - event.user.ip_address
 *   - event.request.cookies
 *   - event.request.headers.authorization (case-insensitive)
 *
 * `event.user.id` is intentionally retained — our user ids are pseudonymous
 * UUIDs and are required for grouping issues by-tenant in Sentry.
 */
import * as Sentry from '@sentry/node';

export interface SentryInitResult {
  enabled: boolean;
  dsnSource: 'SENTRY_DSN' | 'SENTRY_DSN_API' | null;
}

/**
 * Initialise Sentry. Safe to call once at process start. Returns whether
 * Sentry actually initialised (false when DSN is unset).
 */
export function initSentry(): SentryInitResult {
  const dsn = process.env['SENTRY_DSN'] ?? process.env['SENTRY_DSN_API'];
  const dsnSource = process.env['SENTRY_DSN']
    ? 'SENTRY_DSN'
    : process.env['SENTRY_DSN_API']
      ? 'SENTRY_DSN_API'
      : null;

  if (!dsn) {
    // One-line visibility so operators know error tracking is OFF without
    // having to grep the codebase. Not a hard failure.
    console.warn('[sentry] SENTRY_DSN not set — Sentry is disabled (no error tracking)');
    return { enabled: false, dsnSource: null };
  }

  const env = process.env['NODE_ENV'] ?? 'development';
  const release =
    process.env['SENTRY_RELEASE'] ??
    process.env['RAILWAY_GIT_COMMIT_SHA'] ??
    process.env['GIT_COMMIT_SHA'] ??
    'unknown';
  const tracesSampleRate = env === 'production' ? 0.1 : 1.0;

  Sentry.init({
    dsn,
    environment: env,
    release,
    tracesSampleRate,
    // We manage OTel ourselves in tracer-init.ts. Setting this flag stops
    // Sentry from registering a second SDK and double-instrumenting http.
    skipOpenTelemetrySetup: true,
    normalizeDepth: 10,
    beforeSend(event) {
      // Strip user PII. event.user.id (pseudonymous UUID) is kept on purpose.
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
      }
      if (event.request) {
        // Cookies frequently carry session tokens.
        delete event.request.cookies;
        // Authorization header (Bearer / Basic). Match case-insensitively
        // since Node sometimes lowercases, sometimes doesn't.
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

  return { enabled: true, dsnSource };
}

/**
 * Re-export the Sentry namespace so callers can do
 *   `import { Sentry } from './sentry-init.js';`
 * instead of pulling `@sentry/node` directly. Keeps the SDK surface in
 * one place if we ever need to swap implementations or stub in tests.
 */
export { Sentry };
