import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { insertEventWithChain } from '@cpa/db';
import { privilegedSql } from '@cpa/db/client';
import { ActivityRegisterDraftedPayload } from '@cpa/schemas';
import {
  isAgentEnabled,
  isTenantAllowed,
  lookupCache,
  withAgentSpan,
  writeCache,
} from '@cpa/agents/runtime';
import { makeRegisterSynthesizer } from '@cpa/agents/synthesizer-register';
import type {
  CompressedEvent,
  SynthesizerInput,
  SynthesizerOutput,
} from '@cpa/agents/synthesizer-register';
import {
  AGENT_B_SYSTEM_USER_ID,
  EVIDENCE_KINDS,
  REGISTER_SYNTHESIZE_EVENT_CAP,
  buildIdempotencyKey,
  compressEvent,
} from './activity-register-synthesize.js';

/**
 * claim-activity-proposal pg-boss job (Task 3.1).
 *
 * Triggered when a consultant agrees Step 1 of the claim wizard (Upload
 * Evidence is complete). Runs the `synthesize-register` Sonnet agent against
 * the claim's classified events and emits an `ACTIVITY_REGISTER_DRAFTED`
 * event whose payload carries the AI's `proposed_activities[]` cluster set.
 *
 * The job is scoped to a specific claim rather than a bare project_id — it
 * loads `project_id` and `subject_tenant_id` from the claim row itself so
 * the synthesizer call is anchored to that claim's fiscal year.
 *
 * Mirrors `activity-register-synthesize.ts` in all structural respects:
 *   - feature-flag + tenant-allowlist gate BEFORE any DB read
 *   - load claim → load events → compress → idempotency-cache lookup →
 *     synth call under `withAgentSpan` → Zod parse → `insertEventWithChain`
 *     → `writeCache`
 *
 * Concurrency/dedup: the pg-boss `singletonKey` is set to `claim_id` so a
 * double-click on the Agree button cannot enqueue two concurrent jobs.
 */

export const CLAIM_ACTIVITY_PROPOSAL_QUEUE = 'claim-activity-proposal';

const PROMPT_VERSION = 'synthesize-register@1.0.0';
const AGENT_NAME = 'activity-register-synthesizer';

/**
 * Outcome `reason` substrings that represent PERMANENT failures — retrying
 * won't help, so the pg-boss worker returns the result as-is (no throw)
 * and pg-boss treats the job as succeeded. Anything outside this set is
 * treated as TRANSIENT (e.g. Anthropic 429, DB blip, transient network
 * error) and the worker re-throws so pg-boss engages its retry policy.
 *
 * Matching is substring-based on `result.reason` because the per-job
 * reason text already includes both a stable prefix (e.g.
 * "invalid job input") and a downstream parser/library message; we only
 * need to detect the stable prefix.
 */
const PERMANENT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  // Zod parse failure on job input — claim_id missing / not UUID / etc.
  'invalid job input',
  // SQL guard miss — claim row doesn't exist or has no workflow_state, or
  // belongs to a different tenant. None of these are recovered by retry.
  'claim not found',
]);

/**
 * Returns true if `reason` indicates a permanent failure that should NOT
 * be retried. Substring match against {@link PERMANENT_FAILURE_REASONS}.
 */
function isPermanentFailureReason(reason: string | undefined): boolean {
  if (!reason) return false;
  for (const marker of PERMANENT_FAILURE_REASONS) {
    if (reason.includes(marker)) return true;
  }
  return false;
}

const ClaimActivityProposalJobInputSchema = z.object({
  claim_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
});

export type ClaimActivityProposalJobInput = z.infer<typeof ClaimActivityProposalJobInputSchema>;

export type ClaimActivityProposalJobResult = {
  status: 'synthesized' | 'skipped_idempotent' | 'skipped_disabled' | 'failed';
  proposed_activity_count?: number;
  unclustered_event_count?: number;
  events_truncated?: boolean;
  reason?: string;
};

type ClaimRow = {
  project_id: string;
  subject_tenant_id: string;
  fiscal_year: number;
  project_name: string;
  project_started_at: Date;
};

type ActivityRow = {
  id: string;
  title: string;
  kind: 'core' | 'supporting';
  description: string | null;
};

type EventRow = {
  id: string;
  kind: string;
  captured_at: Date;
  payload: unknown;
  subject_tenant_id: string;
};

function anchorForKind(kind: 'core' | 'supporting'): 's.355-25' | 's.355-30' {
  return kind === 'core' ? 's.355-25' : 's.355-30';
}

/**
 * Run the claim-activity-proposal job for one claim.
 *
 * Returns a typed result discriminator:
 *   - `synthesized` — happy path, ACTIVITY_REGISTER_DRAFTED event written.
 *   - `skipped_idempotent` — same input already processed; no second event.
 *   - `skipped_disabled` — feature flag off OR tenant not in allowlist.
 *   - `failed` — any error; `reason` carries the short message.
 */
export async function runClaimActivityProposalJob(
  rawInput: unknown,
): Promise<ClaimActivityProposalJobResult> {
  // Validate input shape with Zod first.
  const parsed = ClaimActivityProposalJobInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { status: 'failed', reason: `invalid job input: ${parsed.error.message}` };
  }
  const input = parsed.data;

  // Step 1: feature-flag + tenant-allowlist gates run BEFORE any DB read.
  if (!isAgentEnabled('B')) {
    return { status: 'skipped_disabled', reason: 'P6_AGENT_B_ENABLED=false' };
  }
  if (!isTenantAllowed(input.tenant_id)) {
    return { status: 'skipped_disabled', reason: 'tenant not in P6_AGENT_TENANT_ALLOWLIST' };
  }

  try {
    // Step 2: load the claim row (privileged — no request-scoped GUC).
    // We join project to get name + started_at for the synthesizer input.
    // The claim's own fiscal_year is used instead of deriving from started_at.
    const claimRows = await privilegedSql<ClaimRow[]>`
      SELECT c.project_id,
             c.subject_tenant_id,
             c.fiscal_year,
             p.name    AS project_name,
             p.started_at AS project_started_at
        FROM claim c
        JOIN project p
          ON p.id = c.project_id
         AND p.tenant_id = c.tenant_id
       WHERE c.id = ${input.claim_id}
         AND c.tenant_id = ${input.tenant_id}
         AND c.workflow_state IS NOT NULL
       LIMIT 1
    `;
    const claim = claimRows[0];
    if (!claim) {
      return { status: 'failed', reason: 'claim not found or has no workflow_state' };
    }

    const { project_id, subject_tenant_id, fiscal_year } = claim;

    // Step 3: load existing accepted activities (for dedup in synthesizer input).
    const activityRows = await privilegedSql<ActivityRow[]>`
      SELECT id, title, kind, description
        FROM activity
       WHERE project_id = ${project_id}
         AND tenant_id = ${input.tenant_id}
       ORDER BY id
    `;

    // Step 4: load up to (cap + 1) recent R&D evidence events.
    const probeLimit = REGISTER_SYNTHESIZE_EVENT_CAP + 1;
    const eventRows = await privilegedSql<EventRow[]>`
      SELECT id, kind, captured_at, payload, subject_tenant_id
        FROM event
       WHERE tenant_id = ${input.tenant_id}
         AND project_id = ${project_id}
         AND kind = ANY(${[...EVIDENCE_KINDS]}::text[])
       ORDER BY captured_at DESC
       LIMIT ${probeLimit}
    `;

    // Step 5: derive truncation flag, then trim to the cap.
    const events_truncated = eventRows.length > REGISTER_SYNTHESIZE_EVENT_CAP;
    const events = events_truncated ? eventRows.slice(0, REGISTER_SYNTHESIZE_EVENT_CAP) : eventRows;

    // Step 6: compress to the narrow CompressedEvent shape.
    const compressed: CompressedEvent[] = events.map(compressEvent);

    // Step 7: build the synthesizer input bundle.
    const inputBundle: SynthesizerInput = {
      project: {
        id: project_id,
        name: claim.project_name,
        industry_sector: null,
        started_at: claim.project_started_at.toISOString(),
        fiscal_year,
      },
      events: compressed,
      existing_activities: activityRows.map((a) => ({
        id: a.id,
        name: a.title,
        kind: a.kind,
        statutory_anchor: anchorForKind(a.kind),
        description: a.description,
      })),
      events_truncated,
    };

    // Step 8: compute idempotency_key (sorted-id basis for determinism).
    // Per-claim scoping: include `claim_id` and `fiscal_year` so a project
    // running multiple claims (e.g. FY2024 and FY2025) over overlapping
    // event sets gets a distinct cache key per claim. Without this, Claim B
    // would short-circuit on Claim A's cache hit and never emit its own
    // `ACTIVITY_REGISTER_DRAFTED`.
    const idempotency_key = buildIdempotencyKey({
      project_id,
      claim_id: input.claim_id,
      fiscal_year,
      event_ids: events.map((e) => e.id),
      existing_activity_ids: activityRows.map((a) => a.id),
    });

    // Step 9: cache lookup — hit means we already wrote this event, skip.
    const cached = await lookupCache(idempotency_key);
    if (cached !== null) {
      return { status: 'skipped_idempotent', reason: 'cache hit on idempotency_key' };
    }

    // Step 10: synthesizer call wrapped in withAgentSpan.
    const out: SynthesizerOutput = await withAgentSpan(
      AGENT_NAME,
      {
        agent_name: AGENT_NAME,
        prompt_version: PROMPT_VERSION,
        model: 'unknown',
        tenant_id: input.tenant_id,
        subject_tenant_id,
      },
      async (setAttr) => {
        const synthesizer = makeRegisterSynthesizer();
        const result = await synthesizer.synthesize(inputBundle);
        setAttr({
          tokens_in: result.tokens_in,
          tokens_out: result.tokens_out,
          model: result.model,
        });
        return result;
      },
    );

    // Step 11: build the on-chain payload.
    const payload = {
      _v: 1 as const,
      project_id,
      proposed_activities: out.proposed_activities,
      unclustered_event_ids: out.unclustered_event_ids,
      total_input_events: events.length,
      events_truncated,
      synthesizer_notes: out.synthesizer_notes,
      model: out.model,
      prompt_version: PROMPT_VERSION,
      idempotency_key,
    };

    // Step 12: defense-in-depth Zod parse.
    const parsedPayload = ActivityRegisterDraftedPayload.parse(payload);

    // Step 13: append to the chain.
    await insertEventWithChain({
      tenant_id: input.tenant_id,
      subject_tenant_id,
      project_id,
      kind: 'ACTIVITY_REGISTER_DRAFTED',
      payload: parsedPayload,
      classification: null,
      captured_at: new Date(),
      captured_by_user_id: AGENT_B_SYSTEM_USER_ID,
      override_of_event_id: null,
      override_new_kind: null,
      override_reason: null,
      idempotency_key,
    });

    // Step 14: write cache.
    await writeCache({
      idempotency_key,
      agent_name: AGENT_NAME,
      prompt_version: PROMPT_VERSION,
      output: parsedPayload,
      tokens_in: out.tokens_in,
      tokens_out: out.tokens_out,
      model: out.model,
    });

    console.log(
      `[claim-activity-proposal] claim=${input.claim_id} status=synthesized ` +
        `tokens_in=${out.tokens_in} tokens_out=${out.tokens_out} model=${out.model} ` +
        `proposed_activity_count=${parsedPayload.proposed_activities.length}`,
    );

    return {
      status: 'synthesized',
      proposed_activity_count: parsedPayload.proposed_activities.length,
      unclustered_event_count: parsedPayload.unclustered_event_ids.length,
      events_truncated,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[claim-activity-proposal] claim=${input.claim_id} error:`, e);
    return { status: 'failed', reason };
  }
}

/**
 * pg-boss worker entry point — runs the job and re-throws on TRANSIENT
 * failures so pg-boss engages its retry policy. Permanent failures
 * (invalid input, claim not found, wrong tenant) are absorbed via
 * {@link PERMANENT_FAILURE_REASONS} and returned as-is — retrying won't
 * help and would just churn the queue.
 *
 * Exposed (not just inlined into `boss.work`) so unit tests can exercise
 * the throw/return decision without booting pg-boss.
 */
export async function handleClaimActivityProposalJob(
  data: ClaimActivityProposalJobInput,
): Promise<ClaimActivityProposalJobResult> {
  const result = await runClaimActivityProposalJob(data);
  console.log(
    `[claim-activity-proposal] claim=${data.claim_id} status=${result.status}` +
      (result.reason ? ` reason=${result.reason}` : ''),
  );
  if (result.status === 'failed' && !isPermanentFailureReason(result.reason)) {
    // Transient failure: throw so pg-boss records the attempt as failed
    // and re-queues per the queue's retry policy. Returning a value
    // (even one with status:'failed') is interpreted as success by
    // pg-boss and silently drops the job.
    throw new Error(`Transient failure, will retry: ${result.reason ?? 'unknown'}`);
  }
  return result;
}

/**
 * Register the claim-activity-proposal job with pg-boss.
 * Called from server.ts after getBoss() succeeds.
 */
export async function registerClaimActivityProposalJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(CLAIM_ACTIVITY_PROPOSAL_QUEUE);
  await boss.work<ClaimActivityProposalJobInput>(CLAIM_ACTIVITY_PROPOSAL_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await handleClaimActivityProposalJob(job.data);
    }
  });
}
