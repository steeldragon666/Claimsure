# Sentry — how it's wired

## What gets captured

- **API (Fastify):** every 5xx response (via `app.setErrorHandler` in
  `src/app.ts`) plus all `uncaughtException` and `unhandledRejection`
  events (in `src/server.ts`). 4xx errors are not forwarded — they're
  client mistakes and would flood the inbox. Init lives in
  `src/sentry-init.ts` and runs after the OTel SDK so traces correlate.
- **Web (Next.js):** SSR + edge errors (via `src/instrumentation.ts`,
  loading `sentry.server.config.ts` / `sentry.edge.config.ts`), browser
  errors (via `sentry.client.config.ts` injected by `withSentryConfig`
  in `next.config.ts`), and nested RSC errors (via `onRequestError`).

## What gets scrubbed

The `beforeSend` hook on every runtime strips:

- `event.user.email`, `event.user.ip_address`
- `event.request.cookies` (often carry session JWTs)
- Any `authorization` request header (case-insensitive)

`event.user.id` is kept — our IDs are pseudonymous UUIDs and are needed
to group issues by tenant.

## Setup a Sentry project

1. Create two projects in Sentry: `archiveone-api` (platform: Node.js)
   and `archiveone-web` (platform: Next.js).
2. Copy each DSN; put the API DSN in `SENTRY_DSN` (server env), and the
   browser DSN in `NEXT_PUBLIC_SENTRY_DSN`.
3. (Optional, build-time only) set `SENTRY_ORG`, `SENTRY_PROJECT`, and
   `SENTRY_AUTH_TOKEN` to upload source maps for symbolicated stack
   traces. Without these, Sentry still works — traces are minified.

## Verify

With `SENTRY_DSN` set, in a one-off Node REPL inside `apps/api`:

```ts
import { initSentry, Sentry } from './dist/sentry-init.js';
initSentry();
Sentry.captureMessage('test from archiveone-api');
await Sentry.flush(2000);
```

The event should appear in the Sentry project within ~5 seconds. If
`SENTRY_DSN` is unset, you'll see `[sentry] SENTRY_DSN not set` on stderr
and no event is sent — Sentry is fully no-op in that mode.
