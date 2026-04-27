import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { AgentSpanAttrs } from './types.js';

const tracer = trace.getTracer('@cpa/agents');

/**
 * Wrap an agent call in an OTel span. Attributes are prefixed `cpa.*` for
 * filterability in Grafana. The callback receives a `setAttr` helper so
 * mid-call data (token counts, classification result) can be added once it's
 * known.
 *
 * Errors are recorded on the span (with status `ERROR`) and re-thrown; the
 * span is always ended in a `finally` block.
 */
export async function withAgentSpan<T>(
  spanName: string,
  attrs: AgentSpanAttrs,
  fn: (setAttr: (more: Partial<AgentSpanAttrs>) => void) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(spanName, async (span) => {
    const apply = (a: Partial<AgentSpanAttrs>): void => {
      for (const [k, v] of Object.entries(a)) {
        if (v !== undefined && v !== null) {
          span.setAttribute(`cpa.${k}`, v);
        }
      }
    };
    apply(attrs);
    try {
      const r = await fn(apply);
      span.setStatus({ code: SpanStatusCode.OK });
      return r;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}
