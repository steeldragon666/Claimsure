import { isAgentEnabled, isTenantAllowed } from '@cpa/agents/runtime';
import { runActivityRegisterSynthesizeJob } from '../jobs/activity-register-synthesize.js';

/**
 * Best-effort enqueue shim for the Agent B activity-register synthesizer.
 *
 * The pg-boss subscriber wiring lands later in the swimlane (Theme 5 of
 * the P6 plan). For v1 the route fires this shim and returns 202
 * immediately; the job runs inline in the same node process. When the
 * subscriber lands, this shim's body swaps for a `boss.send(...)` call
 * with no route-side change.
 *
 * Feature-flag + tenant-allowlist gates live HERE, not in the route, so
 * the gating is one-source-of-truth and the future pg-boss wiring still
 * benefits from them. A disabled agent / non-allowlisted tenant returns
 * a resolved Promise — callers can `await` it for determinism (tests do)
 * or `void`-ignore it (production routes do).
 *
 * Errors are logged via `console.error` rather than the Fastify request
 * logger because the shim has no request context. Job failures are not
 * fatal: the route's 202 contract is "request accepted, will run async";
 * a failed job leaves the chain unchanged and the next caller can retry.
 */
export function enqueueActivityRegisterSynthesize(input: {
  tenant_id: string;
  project_id: string;
}): Promise<void> {
  if (!isAgentEnabled('B') || !isTenantAllowed(input.tenant_id)) {
    return Promise.resolve();
  }
  return runActivityRegisterSynthesizeJob(input)
    .then(() => {
      // Discard the job result — the trigger endpoint is fire-and-forget.
      // Status is observable via GET /v1/projects/:id/activity-register/latest.
    })
    .catch((err: unknown) => {
      console.error('[activity-register] synthesize job failed', {
        tenant_id: input.tenant_id,
        project_id: input.project_id,
        err,
      });
    });
}
