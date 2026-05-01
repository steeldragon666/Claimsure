import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { startSSEStream } from './sse.js';

// SSE helper is pure infrastructure — no DB, no buildApp(). We spin up a
// minimal Fastify instance per test, register a single SSE route that
// exercises the helper, and read the raw response body via app.inject().
//
// inject() returns a LightMyRequest response that captures everything
// written to reply.raw, which is exactly the path the helper takes
// (reply.raw.writeHead + reply.raw.write + reply.raw.end). This means
// we can assert on the SSE wire format without opening a real socket.
//
// What inject does NOT faithfully simulate is the underlying socket
// 'close' event. Fastify's light-my-request transport ends the request
// synchronously when the handler returns; it does not emit a 'close'
// event the way a real TCP socket does on a client disconnect. We
// therefore exercise the abort-listener-wiring contract via a direct
// unit test of `reply.raw.on('close', ...)` rather than through inject.

test('startSSEStream sets correct SSE response headers', async () => {
  const app = Fastify();
  app.get('/stream', (_req, reply) => {
    const sse = startSSEStream(reply);
    sse.send('hello', { msg: 'world' });
    sse.close();
    // Fastify expects the handler to either return a value or signal that
    // the response is being handled manually. Since startSSEStream writes
    // directly to reply.raw and ends it via close(), we return reply to
    // tell Fastify "I handled it" rather than returning a value Fastify
    // would try to serialize.
    return reply;
  });
  const res = await app.inject({ method: 'GET', url: '/stream' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(res.headers['connection'], 'keep-alive');
  assert.equal(res.headers['x-accel-buffering'], 'no');
  await app.close();
});

test('startSSEStream serializes a single event as `event: <name>\\ndata: <json>\\n\\n`', async () => {
  const app = Fastify();
  app.get('/stream', (_req, reply) => {
    const sse = startSSEStream(reply);
    sse.send('hello', { msg: 'world' });
    sse.close();
    return reply;
  });
  const res = await app.inject({ method: 'GET', url: '/stream' });
  // The wire format per the SSE spec (and per the design doc Section 6):
  //   event: <name>\n
  //   data: <JSON>\n
  //   \n   (blank line terminates the event)
  assert.equal(res.body, 'event: hello\ndata: {"msg":"world"}\n\n');
  await app.close();
});

test('startSSEStream supports multiple sends on a single connection', async () => {
  const app = Fastify();
  app.get('/stream', (_req, reply) => {
    const sse = startSSEStream(reply);
    sse.send('start', { draft_id: 'd1', version: 3 });
    sse.send('segment', { section_kind: 'new_knowledge', segment_index: 0, type: 'prose' });
    sse.send('segment', { section_kind: 'new_knowledge', segment_index: 1, type: 'claim' });
    sse.send('done', { total_segments: 2 });
    sse.close();
    return reply;
  });
  const res = await app.inject({ method: 'GET', url: '/stream' });
  const expected =
    'event: start\ndata: {"draft_id":"d1","version":3}\n\n' +
    'event: segment\ndata: {"section_kind":"new_knowledge","segment_index":0,"type":"prose"}\n\n' +
    'event: segment\ndata: {"section_kind":"new_knowledge","segment_index":1,"type":"claim"}\n\n' +
    'event: done\ndata: {"total_segments":2}\n\n';
  assert.equal(res.body, expected);
  await app.close();
});

test('startSSEStream close() ends the response (writableEnded becomes true)', async () => {
  // Capture the post-close state of the raw response from inside the
  // handler — Node's http.ServerResponse exposes `writableEnded` which
  // flips to true after `.end()` runs. If close() forgot to call
  // reply.raw.end(), this assertion would fail.
  let writableEndedAfterClose: boolean | undefined;
  const app = Fastify();
  app.get('/stream', (_req, reply) => {
    const sse = startSSEStream(reply);
    sse.send('first', { n: 1 });
    sse.close();
    writableEndedAfterClose = reply.raw.writableEnded;
    return reply;
  });
  const res = await app.inject({ method: 'GET', url: '/stream' });
  assert.equal(res.statusCode, 200);
  // Body contains the one event, with the trailing blank-line terminator.
  assert.equal(res.body, 'event: first\ndata: {"n":1}\n\n');
  assert.equal(writableEndedAfterClose, true, 'close() must call reply.raw.end()');
  await app.close();
});

test('startSSEStream serializes nested objects and arrays via JSON.stringify', async () => {
  // The design doc's `event: segment` payload includes a `citing_events`
  // array of UUIDs. Verify nested data round-trips through JSON.stringify
  // without any custom serialization the helper might inadvertently apply.
  const app = Fastify();
  app.get('/stream', (_req, reply) => {
    const sse = startSSEStream(reply);
    sse.send('segment', {
      section_kind: 'new_knowledge',
      segment_index: 1,
      type: 'claim',
      text: 'In sprint 3...',
      citing_events: [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ],
    });
    sse.close();
    return reply;
  });
  const res = await app.inject({ method: 'GET', url: '/stream' });
  // JSON.stringify preserves key insertion order, which matches our object
  // literal here. The assertion is fragile to key reordering on purpose —
  // SSE is text and consumers parse it as JSON, so any reordering would
  // still be semantically equal but the wire format is what we control.
  assert.equal(
    res.body,
    'event: segment\n' +
      'data: {"section_kind":"new_knowledge","segment_index":1,"type":"claim","text":"In sprint 3...","citing_events":["11111111-1111-1111-1111-111111111111","22222222-2222-2222-2222-222222222222"]}\n\n',
  );
  await app.close();
});

test('caller can register reply.raw.on("close", ...) for client-disconnect aborts', async () => {
  // The helper deliberately does NOT wire an abort listener (caller
  // responsibility — see JSDoc on startSSEStream). This test verifies
  // the contract is achievable: a route handler can register a 'close'
  // listener on reply.raw before the helper takes over the response.
  //
  // We can't trigger a real client disconnect through inject() — its
  // light-my-request transport doesn't emit socket close events the
  // way a real TCP connection does. So we just verify the listener
  // CAN be registered and is reachable on the same raw response the
  // helper writes to. The integration-level test of actual abort
  // behaviour lives in the route that uses this helper (Tasks 5.5 +
  // 5.6 — narrative endpoints).
  const app = Fastify();
  let listenerRegistered = false;
  app.get('/stream', (_req, reply) => {
    reply.raw.on('close', () => {
      // would call abortController.abort() in the real route
    });
    // listenerCount is the public Node EventEmitter API for verifying
    // a listener is attached; this proves the caller-managed wiring
    // model works on the same raw response the helper uses.
    listenerRegistered = reply.raw.listenerCount('close') >= 1;
    const sse = startSSEStream(reply);
    sse.send('start', {});
    sse.close();
    return reply;
  });
  const res = await app.inject({ method: 'GET', url: '/stream' });
  assert.equal(res.statusCode, 200);
  assert.equal(listenerRegistered, true);
  await app.close();
});
