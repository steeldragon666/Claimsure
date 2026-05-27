/**
 * Next.js 15 instrumentation hook.
 *
 * Called once per server runtime at startup. We use it to wire in Sentry
 * for both the Node.js and edge runtimes. The browser-side Sentry config
 * (sentry.client.config.ts) is loaded automatically by @sentry/nextjs via
 * the webpack plugin configured in next.config.ts (withSentryConfig).
 *
 * The Sentry config files live at the workspace root for @sentry/nextjs
 * convention; we re-import them here per-runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

/**
 * Sentry's recommended hook for capturing nested React Server Component
 * errors. Re-exported from @sentry/nextjs so Next.js can call it.
 */
export { captureRequestError as onRequestError } from '@sentry/nextjs';
