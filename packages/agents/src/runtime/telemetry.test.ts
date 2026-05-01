import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type {
  Tracer,
  TracerProvider,
  Span,
  SpanContext,
  Context,
  TimeInput,
  Attributes,
  AttributeValue,
  Exception,
  Link,
  SpanOptions,
  SpanStatus,
} from '@opentelemetry/api';

// Minimal in-memory tracer for assertion. Captures all attributes set on each
// span. Registered as the global tracer BEFORE telemetry.js is imported, so
// the ProxyTracer cached inside telemetry.js binds to this provider's tracer
// on first use.
type Recorded = { name: string; attrs: Record<string, AttributeValue>; status: SpanStatus | null };
const allSpans: Recorded[] = [];

function makeRecordingProvider(): TracerProvider {
  function makeSpan(name: string): Span {
    const recorded: Recorded = { name, attrs: {}, status: null };
    allSpans.push(recorded);
    const span: Span = {
      spanContext(): SpanContext {
        return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 };
      },
      setAttribute(key: string, value: AttributeValue): Span {
        recorded.attrs[key] = value;
        return span;
      },
      setAttributes(attrs: Attributes): Span {
        for (const [k, v] of Object.entries(attrs)) {
          if (v !== undefined) recorded.attrs[k] = v;
        }
        return span;
      },
      addEvent(): Span {
        return span;
      },
      addLink(_link: Link): Span {
        return span;
      },
      addLinks(_links: Link[]): Span {
        return span;
      },
      setStatus(status: SpanStatus): Span {
        recorded.status = status;
        return span;
      },
      updateName(): Span {
        return span;
      },
      end(_endTime?: TimeInput): void {},
      isRecording(): boolean {
        return true;
      },
      recordException(_exception: Exception, _time?: TimeInput): void {},
    };
    return span;
  }

  const tracer: Tracer = {
    startSpan(name: string, _options?: SpanOptions, _context?: Context): Span {
      return makeSpan(name);
    },
    startActiveSpan(
      name: string,
      arg2: SpanOptions | ((span: Span) => unknown),
      arg3?: Context | ((span: Span) => unknown),
      arg4?: (span: Span) => unknown,
    ): unknown {
      const fn =
        typeof arg2 === 'function'
          ? arg2
          : typeof arg3 === 'function'
            ? arg3
            : (arg4 as (span: Span) => unknown);
      const span = makeSpan(name);
      return fn(span);
    },
  };

  return {
    getTracer(): Tracer {
      return tracer;
    },
  };
}

trace.setGlobalTracerProvider(makeRecordingProvider());

// Import after provider is registered so the cached ProxyTracer in
// telemetry.js binds to our recording tracer.
const { withAgentSpan } = await import('./telemetry.js');

function lastSpan(): Recorded {
  const s = allSpans.at(-1);
  assert.ok(s, 'expected a span to be recorded');
  return s;
}

test('withAgentSpan records cost_usd when tokens + model are set (haiku)', async () => {
  await withAgentSpan(
    'classify',
    { agent_name: 'classifier', prompt_version: 'classify@1.0.0', model: 'claude-haiku-4-5' },
    (setAttr) => {
      setAttr({ tokens_in: 1_000_000, tokens_out: 1_000_000 });
      return Promise.resolve();
    },
  );
  const span = lastSpan();
  assert.equal(span.attrs['cpa.cost_usd'], 1.5);
  assert.equal(span.attrs['cpa.model'], 'claude-haiku-4-5');
  assert.equal(span.attrs['cpa.tokens_in'], 1_000_000);
  assert.equal(span.attrs['cpa.tokens_out'], 1_000_000);
  assert.equal(span.status?.code, SpanStatusCode.OK);
});

test('withAgentSpan records cost_usd for sonnet', async () => {
  await withAgentSpan(
    'narrative',
    { agent_name: 'narrative', prompt_version: 'narrative@1.0.0', model: 'claude-sonnet-4-5' },
    (setAttr) => {
      setAttr({ tokens_in: 1_000_000, tokens_out: 1_000_000 });
      return Promise.resolve();
    },
  );
  assert.equal(lastSpan().attrs['cpa.cost_usd'], 18);
});

test('withAgentSpan does not set cost_usd when tokens are absent', async () => {
  await withAgentSpan(
    'classify',
    { agent_name: 'classifier', prompt_version: 'classify@1.0.0', model: 'claude-haiku-4-5' },
    () => Promise.resolve(),
  );
  assert.equal(lastSpan().attrs['cpa.cost_usd'], undefined);
});

test('withAgentSpan emits cost_usd = 0 for unknown model (matches computeCost contract)', async () => {
  await withAgentSpan(
    'classify',
    { agent_name: 'classifier', prompt_version: 'classify@1.0.0', model: 'unknown-future-model' },
    (setAttr) => {
      setAttr({ tokens_in: 1000, tokens_out: 1000 });
      return Promise.resolve();
    },
  );
  assert.equal(lastSpan().attrs['cpa.cost_usd'], 0);
});

test('withAgentSpan: existing caller without tokens is unchanged (backward compat)', async () => {
  const result = await withAgentSpan(
    'classify',
    { agent_name: 'classifier', prompt_version: 'classify@1.0.0', model: 'claude-haiku-4-5' },
    () => Promise.resolve(42),
  );
  assert.equal(result, 42);
  const span = lastSpan();
  assert.equal(span.attrs['cpa.agent_name'], 'classifier');
  assert.equal(span.attrs['cpa.prompt_version'], 'classify@1.0.0');
  assert.equal(span.attrs['cpa.cost_usd'], undefined);
});

test('withAgentSpan re-throws and records error status on failure', async () => {
  await assert.rejects(
    () =>
      withAgentSpan(
        'classify',
        { agent_name: 'classifier', prompt_version: 'classify@1.0.0', model: 'claude-haiku-4-5' },
        () => Promise.reject(new Error('boom')),
      ),
    /boom/,
  );
  assert.equal(lastSpan().status?.code, SpanStatusCode.ERROR);
});

test('withAgentSpan: cost_usd reflects fractional token amounts', async () => {
  await withAgentSpan(
    'classify',
    { agent_name: 'classifier', prompt_version: 'classify@1.0.0', model: 'claude-haiku-4-5' },
    (setAttr) => {
      setAttr({ tokens_in: 100, tokens_out: 50 });
      return Promise.resolve();
    },
  );
  // 100 * 0.25 / 1e6 + 50 * 1.25 / 1e6 = 0.000025 + 0.0000625 = 0.0000875
  assert.equal(lastSpan().attrs['cpa.cost_usd'], 0.0000875);
});
