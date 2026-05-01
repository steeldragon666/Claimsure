import type { FastifyReply } from 'fastify';

/**
 * Start a Server-Sent Events stream on a Fastify reply.
 *
 * Writes the SSE-required response headers up front (Content-Type,
 * Cache-Control, Connection, X-Accel-Buffering) via `reply.raw.writeHead`,
 * then returns a `{ send, close }` pair the caller uses to push events
 * onto the wire and finalize the response.
 *
 * Wire format per the SSE spec (and per the P6 design doc Section 6):
 *
 *     event: <name>\n
 *     data: <JSON>\n
 *     \n      <-- blank line terminates the event
 *
 * The `X-Accel-Buffering: no` header disables nginx response buffering,
 * which matters in production where the API sits behind an ingress
 * proxy — without it, the proxy may hold events until the response
 * completes, defeating the streaming UX.
 *
 * ## Abort / client-disconnect convention
 *
 * This helper is deliberately minimal. It does NOT register a
 * `reply.raw.on('close', ...)` listener for client disconnects. The
 * caller is responsible for wiring abort behaviour on the same raw
 * response, e.g.:
 *
 * ```ts
 * const abortController = new AbortController();
 * reply.raw.on('close', () => abortController.abort());
 * const sse = startSSEStream(reply);
 * try {
 *   for await (const segment of anthropic.stream({ signal: abortController.signal })) {
 *     sse.send('segment', segment);
 *   }
 *   sse.send('done', {...});
 * } finally {
 *   sse.close();
 * }
 * ```
 *
 * Why caller-managed: the abort signal lifecycle is owned by the route
 * (one AbortController per request, passed into the upstream Anthropic
 * SDK call), so wrapping the listener registration inside the helper
 * would either need the helper to mint the AbortController (leaking
 * its concept into pure transport infra) or accept one as an arg
 * (extra coupling for no real saving — the listener is one line).
 * YAGNI: keep the helper to "headers + send + close" and let routes
 * compose abort behaviour.
 *
 * @param reply Fastify reply whose underlying `reply.raw` becomes the
 *              SSE response stream. The helper takes ownership of the
 *              response: do not call `reply.send()` after invoking it,
 *              and return `reply` from the route handler so Fastify
 *              treats the response as manually handled.
 * @returns `send(event, data)` — append one event to the stream;
 *          `close()` — end the response (call once when the stream
 *          finishes, including in error paths).
 */
export function startSSEStream(reply: FastifyReply): {
  send: (event: string, data: unknown) => void;
  close: () => void;
} {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return {
    send: (event, data) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close: () => {
      reply.raw.end();
    },
  };
}
