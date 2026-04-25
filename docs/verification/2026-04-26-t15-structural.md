# T15 — Structural verification of OTel + API boot/shutdown

**Date**: 2026-04-26
**Branch**: p0/foundation @ 13d0ebe
**Verified by**: Aaron Newson + AI pair

## What was verified

1. `pnpm --filter @cpa/api build` — exit 0; emits `apps/api/dist/{server,app,db,routes/*}.js`.
2. `node apps/api/dist/server.js` boots and binds 0.0.0.0:3000 (also
   listens on 127.0.0.1 + every host interface). Ready in ~1s.
3. `startTracing()` initialises NodeSDK + auto-instrumentations
   without crashing, even with `GRAFANA_OTLP_ENDPOINT` unset (falls
   back to OTLPTraceExporter default `http://localhost:4318/v1/traces`).
4. `/healthz` returns 200 with the expected envelope:
   `{status:"ok", service:"api", processUptimeSeconds:<int>}`.
5. `/readyz` returns 200 with `checks.db.ok=true` and `latencyMs`
   between 1-41ms (well under the 5s timeout).
6. SIGINT shutdown sequence (`app.close()` then `sdk.shutdown()`)
   logs `"shutting down"` with `signal:"SIGINT"`, both close
   primitives complete in ~1ms each, total ~2ms — well under the
   25s shutdown timeout.
7. Each request produces a structured pino log line with a v4
   `reqId` (T12 fix I4 — `genReqId: () => crypto.randomUUID()`).
   Both `incoming request` and `request completed` lines fire,
   the latter with `responseTime` in ms.
8. OTel `diag` channel surfaces import-order warnings to stderr
   (T11 fix — `diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)`).
   This confirms the diag wire-up is working. The two warnings
   observed (fastify + pino "loaded before" the corresponding
   instrumentation) are flagged below as a follow-up — they don't
   affect this structural verification.

## What is NOT verified

- **Live Grafana Cloud trace export.** Requires `GRAFANA_OTLP_ENDPOINT`,
  `GRAFANA_OTLP_USERNAME`, `GRAFANA_OTLP_PASSWORD` in `.env`. Once
  those are set, run `node apps/api/dist/server.js`, generate
  traffic, and check Grafana Cloud → Explore → Tempo → service
  `api` for spans. Expected within 1-2 minutes.
- **OS-level SIGINT delivery on Windows.** Node.js on Windows does
  not deliver POSIX signals cross-process — `child.kill('SIGINT')`
  from a Node parent terminates the child via TerminateProcess
  without invoking `process.on('SIGINT', ...)`. The handler logic
  was verified by invoking the same code path in-process (boot
  with `startTracing` + `buildApp` + `listen`, then run the same
  `app.close()` → `sdk.shutdown()` sequence the SIGINT handler
  runs). On Linux containers in prod a real SIGINT will trigger
  the handler exactly as designed.
- **Production load (>1 RPS).** Only ~6 requests verified.
- **Behaviour under DB outage.** /readyz should return 503; this
  is exercised by T18's cold-restart verification.

## Boot log excerpt (`/tmp/api.log`)

```
@opentelemetry/instrumentation-fastify Module fastify has been loaded before @opentelemetry/instrumentation-fastify so it might not work, please initialize it before requiring fastify
@opentelemetry/instrumentation-pino Module pino has been loaded before @opentelemetry/instrumentation-pino so it might not work, please initialize it before requiring pino
{"level":"info","time":"2026-04-25T21:51:32.984Z","pid":31492,"hostname":"death-machine","name":"api","msg":"Server listening at http://127.0.0.1:3000"}
{"level":"info","time":"2026-04-25T21:51:32.985Z","pid":31492,"hostname":"death-machine","name":"api","port":3000,"msg":"api listening"}
{"level":"info","time":"2026-04-25T21:51:34.852Z","pid":31492,"hostname":"death-machine","name":"api","reqId":"33189810-fc54-4e87-b910-ba2eab2a25d8","req":{"method":"GET","url":"/healthz","host":"localhost:3000","remoteAddress":"127.0.0.1","remotePort":62155},"msg":"incoming request"}
{"level":"info","time":"2026-04-25T21:51:34.856Z","pid":31492,"hostname":"death-machine","name":"api","reqId":"33189810-fc54-4e87-b910-ba2eab2a25d8","res":{"statusCode":200},"responseTime":3.515300001949072,"msg":"request completed"}
{"level":"info","time":"2026-04-25T21:52:01.783Z","pid":31492,"hostname":"death-machine","name":"api","reqId":"9c74447a-85fc-43ba-98cb-85634da9e769","req":{"method":"GET","url":"/readyz","host":"localhost:3000","remoteAddress":"127.0.0.1","remotePort":60175},"msg":"incoming request"}
{"level":"info","time":"2026-04-25T21:52:01.825Z","pid":31492,"hostname":"death-machine","name":"api","reqId":"9c74447a-85fc-43ba-98cb-85634da9e769","res":{"statusCode":200},"responseTime":41.50039999932051,"msg":"request completed"}
```

The first two lines are the OTel `diag` channel proving `diag.setLogger`
is wired (T11). Lines 3-4 are Fastify's startup. Lines 5-6 are a
`/healthz` request with reqId. Lines 7-8 are a `/readyz` request
exercising the pg-postgres instrumentation as well.

## Shutdown log excerpt (in-process synthesised SIGINT)

```
---shutdown sequence (synthesised SIGINT)---
app.close() complete after 1 ms
sdk.shutdown() complete after 1 ms
total shutdown time: 2 ms (timeout was 25_000 ms — WELL UNDER)
exit code: 0 (would be set via process.exit(0) in production)
{"level":"info","time":"2026-04-25T21:56:52.866Z","pid":31332,"hostname":"death-machine","name":"api","signal":"SIGINT","msg":"shutting down"}
```

## Follow-up — auto-instrumentation load order

The two `diag` warnings ("Module fastify has been loaded before
@opentelemetry/instrumentation-fastify ...", same for pino) indicate
that fastify and pino are imported through `app.js`'s import graph
before `startTracing()` runs in `server.js`, even though `server.ts`
calls `startTracing` BEFORE `buildApp`. ESM evaluates all `import`
statements at the top of a module before the body runs, so by the
time `startTracing` executes, the `import { buildApp } from './app.js'`
has already pulled in fastify + pino transitively.

The auto-instrumentations still patch post-hoc, but the fastify/pino
patches in particular rely on hooking the `require`-time load path —
the warning is OTel signalling that those two instrumentations may
not be fully effective. **Once live Grafana export is available
(creds in `.env`), confirm whether HTTP/route spans are captured.
If not, the fix is to move `startTracing` into a separate
`tracer-init.js` and import it as the very first line of `server.ts`,
before the `buildApp` import**. That ordering would let auto-load
hooks register before the fastify + pino imports resolve.

This is recorded here so it can be addressed if/when live traces
land in Grafana with gaps.
