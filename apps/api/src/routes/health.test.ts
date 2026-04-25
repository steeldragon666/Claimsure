import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type App } from '../app.js';

// before/after are file-scoped in node:test. Tests share one App instance;
// each test must be order-independent (no shared mutable state).

type LoggerWithBindings = { bindings: () => { name?: string } };

let app: App;

before(async () => {
  app = buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

test('GET /healthz returns 200 with the expected envelope', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  const body = res.json<Record<string, unknown>>();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'api');
  assert.equal(typeof body.processUptimeSeconds, 'number');
  // Upper bound catches the field-confusion bug class — Date.now() (1.7e12) or
  // Date.now()/1000 (1.7e9) would both fail this. process.uptime() at test
  // run time is always under a few seconds.
  assert.ok((body.processUptimeSeconds as number) < 60, 'processUptimeSeconds should be small (we just started)');
});

test('GET /healthz response satisfies the zod schema (serializer enforces shape)', async () => {
  // If the route handler returned an extra field or wrong type,
  // fastify-type-provider-zod would 500. A 200 here is the schema-validation pass.
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  const body = res.json<Record<string, unknown>>();
  // exactly 3 top-level keys (no extras leaking)
  assert.deepEqual(Object.keys(body).sort(), ['processUptimeSeconds', 'service', 'status']);
});

test('Fastify uses our pino instance (regression check)', () => {
  // T12 review I2 — verify the loggerInstance hook actually wired our logger.
  // createLogger({ serviceName: 'api' }) sets pino name to 'api'; Fastify's
  // default logger has no name. If someone later swaps loggerInstance for
  // the mutually-exclusive `logger` option, this test fails.
  //
  // FastifyBaseLogger doesn't declare bindings() (it's a pino extension), so
  // narrow the runtime shape we need rather than leak pino's type into the test.
  const log = app.log as unknown as LoggerWithBindings;
  const bindings = log.bindings();
  assert.equal(bindings.name, 'api');
});
