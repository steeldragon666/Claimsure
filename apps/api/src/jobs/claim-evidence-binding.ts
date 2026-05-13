import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { insertEventWithChain } from '@cpa/db';
import { privilegedSql } from '@cpa/db/client';
import { ArtefactLinkedPayload } from '@cpa/schemas';
import { isAgentEnabled, isTenantAllowed, withAgentSpan } from '@cpa/agents/runtime';
import { makeAutoAllocator } from '@cpa/agents';
import type { AutoAllocatorInput, ActivitySummary } from '@cpa/agents';
import { AGENT_B_SYSTEM_USER_ID, EVIDENCE_KINDS } from './activity-register-synthesize.js';

/**
 * Set of valid evidence kinds for quick membership checks. Used to guard
 * the `classification.kind` value passed to the allocator — the
 * classification column may carry a kind outside the evidence set (e.g.
 * a human-overridden kind), so we fall back to the event's own `kind`
 * (which is already constrained by the SQL `kind = ANY(EVIDENCE_KINDS)`
 * filter).
 */
const EVIDENCE_KINDS_SET: ReadonlySet<string> = new Set(EVIDENCE_KINDS);

/**
 * claim-evidence-binding pg-boss job (Task 3.2).
 *
 * Triggered when a consultant agrees Step 2 of the claim wizard (all
 * proposed activities are resolved / accepted). Runs the `auto-allocator`
 * Haiku agent for each unbound evidence event against each agreed activity,
 * and emits `ARTEFACT_LINKED` events for bindings above the confidence
 * threshold.
 *
 * Links are idempotent at the event-chain level: the same
 * `(activity_id, artefact_kind, artefact_id)` triple won't double-count
 * because `loadWorkflowSnapshot` deduplicates to the latest event per
 * triple. No idempotency cache is used (unlike Task 3.1).
 *
 * Mirrors `claim-activity-proposal.ts` in all structural respects:
 *   - feature-flag + tenant-allowlist gate BEFORE any DB read
 *   - Zod-validated input
 *   - `privilegedSql` for all DB queries (worker has no session/GUC)
 *   - `AGENT_B_SYSTEM_USER_ID` as the `captured_by_user_id`
 *   - `insertEventWithChain` for chain event emission
 */

export const CLAIM_EVIDENCE_BINDING_QUEUE = 'claim-evidence-binding';

const PROMPT_VERSION = 'allocate@1.0.0';
const AGENT_NAME = 'evidence-auto-allocator';

/**
 * Outcome `reason` substrings that represent PERMANENT failures — the
 * pg-boss worker treats anything else as TRANSIENT (e.g. Anthropic 429,
 * DB blip) and re-throws so pg-boss engages its retry policy. See
 * `claim-activity-proposal.ts` for the same pattern.
 */
const PERMANENT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'invalid job input',
  'claim not found',
]);

function isPermanentFailureReason(reason: string | undefined): boolean {
  if (!reason) return false;
  for (const marker of PERMANENT_FAILURE_REASONS) {
    if (reason.includes(marker)) return true;
  }
  return false;
}

/**
 * Minimum confidence score from the auto-allocator for a binding to be
 * emitted as an `ARTEFACT_LINKED` event. Below this threshold, the
 * allocation is silently dropped. With the stub allocator: vocabulary
 * matches (0.72) pass, default first-activity allocations (0.60) do not.
 */
export const AUTO_ALLOCATOR_MIN_CONFIDENCE = 0.65;

const ClaimEvidenceBindingJobInputSchema = z.object({
  claim_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
});

export type ClaimEvidenceBindingJobInput = z.infer<typeof ClaimEvidenceBindingJobInputSchema>;

export type ClaimEvidenceBindingJobResult = {
  status: 'allocated' | 'skipped_disabled' | 'failed';
  links_created?: number;
  events_processed?: number;
  reason?: string;
};

type ClaimRow = {
  project_id: string;
  subject_tenant_id: string;
};

type ActivityRow = {
  id: string;
  title: string;
  kind: 'core' | 'supporting';
  code: string;
  hypothesis: string | null;
};

type EvidenceEventRow = {
  id: string;
  kind: string;
  payload: unknown;
  classification: unknown;
};

/**
 * Extract classification data from an evidence event row. Checks the
 * `classification` column first (populated by the classifier agent),
 * then falls back to `payload.classification` (older events may carry
 * it inline).
 */
function extractClassification(row: EvidenceEventRow): {
  kind: string;
  confidence: number;
  rationale: string;
  statutory_anchor: string | null;
} {
  // Try the classification column first.
  if (row.classification && typeof row.classification === 'object') {
    const c = row.classification as Record<string, unknown>;
    if (typeof c['kind'] === 'string' && typeof c['confidence'] === 'number') {
      return {
        kind: c['kind'],
        confidence: c['confidence'],
        rationale: typeof c['rationale'] === 'string' ? c['rationale'] : '',
        statutory_anchor: typeof c['statutory_anchor'] === 'string' ? c['statutory_anchor'] : null,
      };
    }
  }
  // Fall back to payload.classification.
  if (row.payload && typeof row.payload === 'object') {
    const p = row.payload as Record<string, unknown>;
    if (p['classification'] && typeof p['classification'] === 'object') {
      const c = p['classification'] as Record<string, unknown>;
      if (typeof c['kind'] === 'string' && typeof c['confidence'] === 'number') {
        return {
          kind: c['kind'],
          confidence: c['confidence'],
          rationale: typeof c['rationale'] === 'string' ? c['rationale'] : '',
          statutory_anchor:
            typeof c['statutory_anchor'] === 'string' ? c['statutory_anchor'] : null,
        };
      }
    }
  }
  // Default: use the event's kind as the classification kind with
  // minimal confidence. This handles events that were classified by
  // kind (e.g. consultant-entered SUPPORTING events).
  return {
    kind: row.kind,
    confidence: 1.0,
    rationale: 'Inferred from event kind',
    statutory_anchor: null,
  };
}

/**
 * Extract raw text from an evidence event's payload.
 */
function extractRawText(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p['text'] === 'string') return p['text'];
    if (typeof p['raw_text'] === 'string') return p['raw_text'];
  }
  return '';
}

/**
 * Run the claim-evidence-binding job for one claim.
 *
 * Returns a typed result discriminator:
 *   - `allocated` — happy path, ARTEFACT_LINKED events written (may be 0).
 *   - `skipped_disabled` — feature flag off OR tenant not in allowlist.
 *   - `failed` — any error; `reason` carries the short message.
 */
export async function runClaimEvidenceBindingJob(
  rawInput: unknown,
): Promise<ClaimEvidenceBindingJobResult> {
  // Step a: Zod-validate input shape.
  const parsed = ClaimEvidenceBindingJobInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { status: 'failed', reason: `invalid job input: ${parsed.error.message}` };
  }
  const input = parsed.data;

  // Step b: feature-flag + tenant-allowlist gates BEFORE any DB read.
  if (!isAgentEnabled('B')) {
    return { status: 'skipped_disabled', reason: 'P6_AGENT_B_ENABLED=false' };
  }
  if (!isTenantAllowed(input.tenant_id)) {
    return { status: 'skipped_disabled', reason: 'tenant not in P6_AGENT_TENANT_ALLOWLIST' };
  }

  try {
    // Test-only hook: when CLAIM_EVIDENCE_BINDING_THROW_TRANSIENT=1, throw
    // synchronously inside the outer try block to exercise the
    // transient-failure throw path in handleClaimEvidenceBindingJob
    // (Fix 2). Production never sets this env var. Mirrors the
    // ALLOCATOR_STUB_THROW_ON_EVENT_ID pattern (F4) and the
    // SYNTHESIZER_STUB_THROW pattern.
    if (process.env.CLAIM_EVIDENCE_BINDING_THROW_TRANSIENT === '1') {
      throw new Error('Synthetic transient binding-job failure');
    }

    // Step c: load the claim row (privileged — no request-scoped GUC).
    const claimRows = await privilegedSql<ClaimRow[]>`
      SELECT c.project_id,
             c.subject_tenant_id
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

    const { project_id, subject_tenant_id } = claim;

    // Step d: load agreed activities for this claim. Scoped to claim_id
    // (not project_id) because each claim's fiscal year may carry different
    // activities; the sibling proposal job uses project_id because it
    // operates pre-acceptance when no claim-level activities exist yet.
    const activityRows = await privilegedSql<ActivityRow[]>`
      SELECT id, title, kind, code, hypothesis
        FROM activity
       WHERE claim_id = ${input.claim_id}
         AND tenant_id = ${input.tenant_id}
    `;

    if (activityRows.length === 0) {
      console.log(
        `[claim-evidence-binding] claim=${input.claim_id} status=allocated links_created=0 events_processed=0`,
      );
      return { status: 'allocated', links_created: 0, events_processed: 0 };
    }

    // Step e: load unbound classified events.
    // First, load ALL evidence events for the project.
    const allEvidenceEvents = await privilegedSql<EvidenceEventRow[]>`
      SELECT id, kind, payload, classification
        FROM event
       WHERE tenant_id = ${input.tenant_id}
         AND project_id = ${project_id}
         AND kind = ANY(${[...EVIDENCE_KINDS]}::text[])
    `;

    // Then, find all event_ids that are already linked via live
    // ARTEFACT_LINKED events (where artefact_kind = 'event').
    // "Live" means: for each (activity_id, artefact_kind, artefact_id) triple,
    // the most recent event (by captured_at DESC, received_at DESC, id DESC)
    // is ARTEFACT_LINKED (not ARTEFACT_UNLINKED).
    const linkedRows = await privilegedSql<{ artefact_id: string }[]>`
      SELECT DISTINCT sub.artefact_id
        FROM (
          SELECT
            (payload->>'artefact_id') AS artefact_id,
            kind,
            ROW_NUMBER() OVER (
              PARTITION BY payload->>'activity_id', payload->>'artefact_kind', payload->>'artefact_id'
              ORDER BY captured_at DESC, received_at DESC, id DESC
            ) AS rn
          FROM event
          WHERE tenant_id = ${input.tenant_id}
            AND project_id = ${project_id}
            AND kind IN ('ARTEFACT_LINKED', 'ARTEFACT_UNLINKED')
            AND payload->>'artefact_kind' = 'event'
        ) sub
       WHERE sub.rn = 1
         AND sub.kind = 'ARTEFACT_LINKED'
    `;

    const linkedEventIds = new Set(linkedRows.map((r) => r.artefact_id));
    const unboundEvents = allEvidenceEvents.filter((e) => !linkedEventIds.has(e.id));

    // Step f: for each unbound event, call the allocator against all activities.
    const activities: ActivitySummary[] = activityRows.map((a) => ({
      id: a.id,
      code: a.code,
      kind: a.kind,
      title: a.title,
      hypothesis: a.hypothesis,
    }));

    const allocator = makeAutoAllocator();
    let linksCreated = 0;

    for (const event of unboundEvents) {
      try {
        const classification = extractClassification(event);
        // Guard: if the classification's kind isn't a valid evidence kind
        // (e.g. human override wrote an unexpected value), fall back to the
        // event's own kind — which the SQL already constrained to EVIDENCE_KINDS.
        const safeKind = EVIDENCE_KINDS_SET.has(classification.kind)
          ? classification.kind
          : event.kind;
        const allocatorInput: AutoAllocatorInput = {
          event_id: event.id,
          raw_text: extractRawText(event.payload),
          classification: {
            kind: safeKind as AutoAllocatorInput['classification']['kind'],
            confidence: classification.confidence,
            rationale: classification.rationale,
            statutory_anchor: classification.statutory_anchor,
          },
          activities,
        };

        // Step f+h: call allocator wrapped in withAgentSpan.
        const result = await withAgentSpan(
          AGENT_NAME,
          {
            agent_name: AGENT_NAME,
            prompt_version: PROMPT_VERSION,
            model: 'unknown',
            tenant_id: input.tenant_id,
            subject_tenant_id,
          },
          async (setAttr) => {
            const out = await allocator.allocate(allocatorInput);
            setAttr({
              tokens_in: out.tokens_in,
              tokens_out: out.tokens_out,
              model: out.model,
            });
            return out;
          },
        );

        // Step g: emit ARTEFACT_LINKED if matched and above confidence threshold.
        if (!result.unallocated && result.confidence >= AUTO_ALLOCATOR_MIN_CONFIDENCE) {
          const linkPayload = {
            activity_id: result.activity_id,
            artefact_kind: 'event' as const,
            artefact_id: event.id,
            link_reason: result.rationale,
          };

          // Defense-in-depth Zod parse.
          const parsedPayload = ArtefactLinkedPayload.parse(linkPayload);

          await insertEventWithChain({
            tenant_id: input.tenant_id,
            subject_tenant_id,
            project_id,
            kind: 'ARTEFACT_LINKED',
            payload: parsedPayload,
            classification: null,
            captured_at: new Date(),
            captured_by_user_id: AGENT_B_SYSTEM_USER_ID,
            override_of_event_id: null,
            override_new_kind: null,
            override_reason: null,
            idempotency_key: null,
          });

          linksCreated++;
        }
      } catch (err) {
        // Per-event failure: log and continue, don't abort the whole job.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          `[claim-evidence-binding] claim=${input.claim_id} event=${event.id} allocator error: ${reason}`,
        );
      }
    }

    // Step i: log summary.
    console.log(
      `[claim-evidence-binding] claim=${input.claim_id} status=allocated links_created=${linksCreated} events_processed=${unboundEvents.length}`,
    );

    return {
      status: 'allocated',
      links_created: linksCreated,
      events_processed: unboundEvents.length,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[claim-evidence-binding] claim=${input.claim_id} error:`, e);
    return { status: 'failed', reason };
  }
}

/**
 * pg-boss worker entry point — runs the job and re-throws on TRANSIENT
 * failures so pg-boss engages its retry policy. Permanent failures
 * (invalid input, claim not found) are absorbed via
 * {@link PERMANENT_FAILURE_REASONS} and returned as-is.
 *
 * Exposed for unit testing without booting pg-boss.
 */
export async function handleClaimEvidenceBindingJob(
  data: ClaimEvidenceBindingJobInput,
): Promise<ClaimEvidenceBindingJobResult> {
  const result = await runClaimEvidenceBindingJob(data);
  console.log(
    `[claim-evidence-binding] claim=${data.claim_id} status=${result.status}` +
      (result.reason ? ` reason=${result.reason}` : ''),
  );
  if (result.status === 'failed' && !isPermanentFailureReason(result.reason)) {
    throw new Error(`Transient failure, will retry: ${result.reason ?? 'unknown'}`);
  }
  return result;
}

/**
 * Register the claim-evidence-binding job with pg-boss.
 * Called from server.ts after getBoss() succeeds.
 */
export async function registerClaimEvidenceBindingJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(CLAIM_EVIDENCE_BINDING_QUEUE);
  await boss.work<ClaimEvidenceBindingJobInput>(CLAIM_EVIDENCE_BINDING_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await handleClaimEvidenceBindingJob(job.data);
    }
  });
}
