import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { AgentSpanAttrs } from './types.js';
import { computeCost } from './pricing.js';

const tracer = trace.getTracer('@cpa/agents');

/**
 * Wrap an agent call in an OTel span. Attributes are prefixed `cpa.*` for
 * filterability in Grafana. The callback receives a `setAttr` helper so
 * mid-call data (token counts, classification result) can be added once it's
 * known.
 *
 * When `model`, `tokens_in`, and `tokens_out` have all been recorded on the
 * span (either up-front in `attrs` or later via `setAttr`), this helper
 * additionally emits `cpa.cost_usd` derived from `computeCost`. The
 * extension is purely additive: callers that don't supply token counts
 * behave exactly as before. Unknown models record `cost_usd = 0` —
 * intentional, see `pricing.ts` for the design rationale.
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
    // Track the running view of cost-relevant attrs across `setAttr` calls so
    // we can emit `cost_usd` the moment all three (model + both token counts)
    // are present, including when they arrive in separate setAttr calls.
    let model: string | undefined = attrs.model;
    let tokensIn: number | undefined = attrs.tokens_in;
    let tokensOut: number | undefined = attrs.tokens_out;

    const maybeEmitCost = (): void => {
      if (model !== undefined && tokensIn !== undefined && tokensOut !== undefined) {
        span.setAttribute('cpa.cost_usd', computeCost(model, tokensIn, tokensOut));
      }
    };

    const apply = (a: Partial<AgentSpanAttrs>): void => {
      for (const [k, v] of Object.entries(a)) {
        if (v !== undefined && v !== null) {
          span.setAttribute(`cpa.${k}`, v);
        }
      }
      if (a.model !== undefined) model = a.model;
      if (a.tokens_in !== undefined) tokensIn = a.tokens_in;
      if (a.tokens_out !== undefined) tokensOut = a.tokens_out;
      maybeEmitCost();
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
