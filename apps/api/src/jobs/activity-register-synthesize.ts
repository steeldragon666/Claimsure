import { insertEventWithChain } from '@cpa/db';
import { privilegedSql } from '@cpa/db/client';
import { ActivityRegisterDraftedPayload } from '@cpa/schemas';
import {
  computeIdempotencyKey,
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

/**
 * Agent B job processor (Task 4.3): activity-register-synthesize.
 *
 * Single-shot job: for ONE project, load the recent R&D evidence stream,
 * compress it to per-event summaries, call the
 * {@link makeRegisterSynthesizer} factory, and emit ONE
 * `ACTIVITY_REGISTER_DRAFTED` event carrying the proposed activity cluster.
 *
 * Mirrors the structural template of `audit-score-recompute.ts` /
 * `transcribe.ts`:
 *   - feature-flag + tenant-allowlist gate BEFORE any DB read
 *   - load → compress → idempotency-cache lookup → synth call under
 *     `withAgentSpan` (auto-emits `cpa.cost_usd`) → payload Zod parse →
 *     `insertEventWithChain` → `writeCache`
 *   - per-step throw + outer try/catch returning a typed `failed` result.
 *
 * The pg-boss subscriber wiring lands later in the swimlane — for v1 the
 * handler is exported as a plain async function so unit tests call it
 * directly and the future job runner just `await runActivityRegisterSynthesizeJob(input)`s it.
 *
 * @see docs/plans/2026-05-01-p6-implementation.md (Task 4.3) for the full spec.
 */

export type ActivityRegisterSynthesizeJobInput = {
  tenant_id: string;
  project_id: string;
};

export type ActivityRegisterSynthesizeJobResult = {
  status: 'synthesized' | 'skipped_idempotent' | 'skipped_disabled' | 'failed';
  proposed_activity_count?: number;
  unclustered_event_count?: number;
  events_truncated?: boolean;
  /** Populated on `failed` and `skipped_*` outcomes; one short sentence. */
  reason?: string;
};

/**
 * Hard cap on the recent evidence window passed to the synthesizer per
 * pass. Kept at 200 by default to bound the prompt token footprint;
 * configurable via env so dogfood / staged-rollout firms can tune
 * downstream of telemetry.
 */
export const REGISTER_SYNTHESIZE_EVENT_CAP = Number(process.env.P6_AGENT_B_EVENT_CAP ?? '200');

/**
 * Prompt version + agent name pinned alongside the impls.
 * Kept here as constants so the idempotency key + telemetry attrs +
 * payload metadata all use one source of truth.
 */
const PROMPT_VERSION = 'synthesize-register@1.0.0';
const AGENT_NAME = 'activity-register-synthesizer';

/**
 * Agent B system user — emits `ACTIVITY_REGISTER_DRAFTED` events.
 *
 * The `event` row's CHECK constraint requires exactly one of
 * (`captured_by_user_id`, `captured_by_employee_id`) to be set. Worker
 * jobs run without a session, so we pin a synthetic `user.id` for
 * Agent B's emissions. Tests seed the row with this id (and the
 * matching email/external_id); production seeds it via a one-off
 * migration in the swimlane PR. Coordinated with Task 3.3 (Agent A,
 * worktree p6b): each agent gets its own pinned id so audit reads can
 * filter on `captured_by_user_id` to attribute chain entries.
 */
export const AGENT_B_SYSTEM_USER_ID = '00000000-0000-4000-8000-000000a90002';

/**
 * R&D evidence kinds — the subset of `event.kind` values that the
 * synthesizer ingests. Mirrors the {@link classifiableKind} set in
 * `@cpa/schemas/event.ts` (the 12 R&D evidence categories), excluding
 * OVERRIDE (a reviewer action, not evidence) and the P4 state-transition
 * kinds (ACTIVITY_CREATED, EXPENDITURE_INGESTED, etc., which describe
 * lifecycle, not R&D content). Kept as a plain string-literal array so
 * the SQL `kind = ANY(...)` bind is straightforward.
 */
const EVIDENCE_KINDS = [
  'HYPOTHESIS',
  'DESIGN',
  'EXPERIMENT',
  'OBSERVATION',
  'ITERATION',
  'NEW_KNOWLEDGE',
  'UNCERTAINTY',
  'TIME_LOG',
  'ASSOCIATE_FLAG',
  'EXPENDITURE_NOTE',
  'SUPPORTING',
  'INELIGIBLE',
] as const;

/**
 * Take the first 50 whitespace-separated words of a string. If the input
 * has fewer than 50 words, the whole string is returned unchanged. Falls
 * back to the empty string for null/undefined/non-string inputs (the
 * compressed-event shape guarantees a string, and a missing payload.text
 * is still a real evidence row — we'd rather emit an empty summary than
 * crash the whole pass).
 *
 * Implementation matches the spec verbatim:
 *   `text.split(/\s+/).slice(0, 50).join(' ')`.
 */
export function truncateToFiftyWords(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.split(/\s+/).slice(0, 50).join(' ');
}

type ProjectRow = {
  id: string;
  tenant_id: string;
  subject_tenant_id: string;
  name: string;
  started_at: Date;
  // Joined from `claim` (LEFT JOIN; nullable for projects pre-claim-creation).
  fiscal_year: number | null;
};

/**
 * Derive the Australian fiscal year (FY ending 30 June) from a project
 * `started_at` date. AusIndustry — and the rest of the codebase, see
 * `packages/db/src/schema/claim.ts` — uses the convention that
 * `fiscal_year = 2025` means the FY 1 July 2024 → 30 June 2025.
 *
 * July (month index 6) onward rolls into the NEXT calendar year's FY:
 *   - `2024-07-01` → 2025
 *   - `2024-06-30` → 2024
 *
 * Used as a fallback when no `claim` row is yet associated with the
 * project (e.g. a fresh project the consultant hasn't yet linked to a
 * claim). The primary source is `claim.fiscal_year` via the LEFT JOIN
 * in the project load step.
 */
export function deriveAuFiscalYear(startedAt: Date): number {
  const month = startedAt.getUTCMonth(); // 0-indexed; 6 = July
  const year = startedAt.getUTCFullYear();
  return month >= 6 ? year + 1 : year;
}

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

/**
 * Map an `activity.kind` to the matching Division 355 anchor. The
 * activity table doesn't carry the anchor as a column today — the
 * derivation is `core` → `s.355-25`, `supporting` → `s.355-30`, per
 * the synthesizer's `ACTIVITY_KINDS` ↔ `ACTIVITY_STATUTORY_ANCHORS`
 * pairing in `packages/agents/src/synthesizer-register/types.ts`.
 */
function anchorForKind(kind: 'core' | 'supporting'): 's.355-25' | 's.355-30' {
  return kind === 'core' ? 's.355-25' : 's.355-30';
}

/**
 * Derive the {@link CompressedEvent} shape from an `event` row. The
 * summary is the first 50 words of `payload.text` or `payload.raw_text`
 * (whichever exists first — `payload.text` is the consultant-paste
 * shape; `payload.raw_text` is the mobile-voice transcribed shape).
 * Never throws; missing text falls through to an empty summary.
 */
export function compressEvent(row: EventRow): CompressedEvent {
  // The payload column is jsonb; postgres-js decodes to a plain JS value.
  // Defensive narrowing: only treat it as a record if it's a non-null
  // object — anything else (raw string, number, bool) just yields ''.
  let text: unknown;
  if (row.payload !== null && typeof row.payload === 'object') {
    const p = row.payload as Record<string, unknown>;
    text = p['text'] ?? p['raw_text'] ?? null;
  }
  return {
    id: row.id,
    kind: row.kind,
    captured_at: row.captured_at.toISOString(),
    summary: truncateToFiftyWords(text),
    subject_tenant_id: row.subject_tenant_id,
  };
}

/**
 * Build the deterministic idempotency cache key.
 *
 * The raw input is `{project_id, sorted_event_ids, sorted_existing_activity_ids}`
 * — sorting both id arrays makes the key stable across DB-row-ordering
 * changes (two rows captured at the same `captured_at` could swap order
 * across runs; sorting eliminates that as a source of cache miss).
 *
 * Exposed for direct unit testing — the spec requires asserting that
 * the key construction is order-independent (test #8 in the test file).
 */
export function buildIdempotencyKey(args: {
  project_id: string;
  event_ids: string[];
  existing_activity_ids: string[];
}): string {
  const raw = JSON.stringify({
    project_id: args.project_id,
    sorted_event_ids: [...args.event_ids].sort(),
    existing_activity_ids: [...args.existing_activity_ids].sort(),
  });
  return computeIdempotencyKey(PROMPT_VERSION, raw);
}

/**
 * Run the activity-register synthesizer for ONE project.
 *
 * Returns a typed result discriminator describing the outcome:
 *   - `synthesized` — happy path, event written to chain.
 *   - `skipped_idempotent` — same `(project, events, activities)` already
 *     processed; no second event is written.
 *   - `skipped_disabled` — feature flag off OR tenant not in allowlist.
 *   - `failed` — any error thrown during the pass; `reason` carries the
 *     short message. Single-project / single-event-write semantics, so
 *     there's no per-row isolation concern (cf. Task 3.3's batch loop).
 */
export async function runActivityRegisterSynthesizeJob(
  input: ActivityRegisterSynthesizeJobInput,
): Promise<ActivityRegisterSynthesizeJobResult> {
  // Step 1: feature-flag + tenant-allowlist gates run BEFORE any DB read,
  // matching the cheap-out-first pattern from the design doc Section 6
  // (staged rollout). Either gate failing returns the same outcome so
  // the caller doesn't need to distinguish.
  if (!isAgentEnabled('B')) {
    return { status: 'skipped_disabled', reason: 'P6_AGENT_B_ENABLED=false' };
  }
  if (!isTenantAllowed(input.tenant_id)) {
    return { status: 'skipped_disabled', reason: 'tenant not in P6_AGENT_TENANT_ALLOWLIST' };
  }

  try {
    // Step 2: load the project. `privilegedSql` because the worker has
    // no request-scoped tenant GUC; the explicit tenant_id bind scopes
    // the read. RLS would also catch a cross-tenant id, but failing
    // fast at the bind layer is clearer.
    //
    // LEFT JOIN claim to pick up `fiscal_year` (Australian FY semantics —
    // `2025` = FY ending 30 June 2025). The synthesizer's typed input
    // expects the AusIndustry reckoning; deriving it inline from
    // `started_at` would be wrong for July–December starts. Falls back
    // to `deriveAuFiscalYear(started_at)` if no claim row exists yet
    // (e.g. a freshly-created project pre-claim-creation).
    //
    // Multi-claim caveat: `claim.(subject_tenant_id, fiscal_year)` is
    // unique, but `claim.project_id` is not — a project that spans
    // multiple FYs gets a claim row per year. Picking the lowest
    // `fiscal_year` (closest to the project's start) is consistent with
    // the synthesizer's "what year is this project's evidence being
    // captured under" intent. ORDER BY + LIMIT 1 keeps the row
    // deterministic.
    const projectRows = await privilegedSql<ProjectRow[]>`
      SELECT p.id,
             p.tenant_id,
             p.subject_tenant_id,
             p.name,
             p.started_at,
             c.fiscal_year
        FROM project p
   LEFT JOIN claim c
          ON c.project_id = p.id
         AND c.tenant_id = p.tenant_id
       WHERE p.id = ${input.project_id}
         AND p.tenant_id = ${input.tenant_id}
    ORDER BY c.fiscal_year ASC NULLS LAST
       LIMIT 1
    `;
    const project = projectRows[0];
    if (!project) {
      return { status: 'failed', reason: 'project not found' };
    }

    // Step 3: load existing accepted activities. These are the consultant-
    // accepted register; the synthesizer must not propose substantial
    // duplicates of these. We pull the columns the SynthesizerInput shape
    // expects and derive the statutory_anchor from the kind (the activity
    // table doesn't carry it as a column).
    const activityRows = await privilegedSql<ActivityRow[]>`
      SELECT id, title, kind, description
        FROM activity
       WHERE project_id = ${input.project_id}
         AND tenant_id = ${input.tenant_id}
       ORDER BY id
    `;

    // Step 4: load up to (cap + 1) recent R&D evidence events. The +1 is
    // the truncation probe — if we get back cap+1 rows, the input is
    // truncated. Order: captured_at DESC matches the spec literally.
    const probeLimit = REGISTER_SYNTHESIZE_EVENT_CAP + 1;
    const eventRows = await privilegedSql<EventRow[]>`
      SELECT id, kind, captured_at, payload, subject_tenant_id
        FROM event
       WHERE tenant_id = ${input.tenant_id}
         AND project_id = ${input.project_id}
         AND kind = ANY(${[...EVIDENCE_KINDS]}::text[])
       ORDER BY captured_at DESC
       LIMIT ${probeLimit}
    `;

    // Step 5: derive truncation flag, then trim to the cap before the
    // synthesizer call. The model still gets the truncation signal in
    // its input bundle so it knows the stream is incomplete.
    const events_truncated = eventRows.length > REGISTER_SYNTHESIZE_EVENT_CAP;
    const events = events_truncated ? eventRows.slice(0, REGISTER_SYNTHESIZE_EVENT_CAP) : eventRows;

    // Step 6: compress to the narrow CompressedEvent shape (≤50 words +
    // subject_tenant_id for the stub's clustering).
    const compressed: CompressedEvent[] = events.map(compressEvent);

    // Step 7: build the synthesizer input bundle.
    //
    // `industry_sector` isn't a first-class column on the project table
    // today — leave it null. `fiscal_year` uses the Australian
    // convention (`2025` = FY ending 30 June 2025), sourced from the
    // joined `claim.fiscal_year`; falls back to deriving from
    // `started_at` for projects that don't yet have a claim row. The
    // synthesizer prompt accepts the FY as a typed input so the
    // narrative phrasing matches the consultant's expectation.
    const inputBundle: SynthesizerInput = {
      project: {
        id: project.id,
        name: project.name,
        industry_sector: null,
        started_at: project.started_at.toISOString(),
        fiscal_year: project.fiscal_year ?? deriveAuFiscalYear(project.started_at),
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

    // Step 8: compute idempotency_key. The sorted-id basis is the
    // determinism point — two runs over the same project + same set of
    // events (regardless of insertion order) produce the same key.
    const idempotency_key = buildIdempotencyKey({
      project_id: input.project_id,
      event_ids: events.map((e) => e.id),
      existing_activity_ids: activityRows.map((a) => a.id),
    });

    // Step 9: cache lookup. Hit = skip the synth call entirely AND skip
    // the chain write. The chain is append-only, so re-emitting the
    // same event would be a duplicate row, not a no-op.
    const cached = await lookupCache(idempotency_key);
    if (cached !== null) {
      return {
        status: 'skipped_idempotent',
        reason: 'cache hit on idempotency_key',
      };
    }

    // Step 10: synth call wrapped in withAgentSpan — `cpa.cost_usd` is
    // auto-emitted once `model + tokens_in + tokens_out` are recorded.
    const out: SynthesizerOutput = await withAgentSpan(
      AGENT_NAME,
      {
        agent_name: AGENT_NAME,
        prompt_version: PROMPT_VERSION,
        // model is filled by the impl via `setAttr` once known.
        // Until then we record an unknown placeholder so the attr is
        // present even if the impl forgets to overwrite it.
        model: 'unknown',
        tenant_id: input.tenant_id,
        subject_tenant_id: project.subject_tenant_id,
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

    // Step 11: build the on-chain payload. `_v: 1` is the payload-shape
    // version stamp; bumping it is the rollback knob if the field set
    // changes.
    const payload = {
      _v: 1 as const,
      project_id: input.project_id,
      proposed_activities: out.proposed_activities,
      unclustered_event_ids: out.unclustered_event_ids,
      total_input_events: events.length,
      events_truncated,
      synthesizer_notes: out.synthesizer_notes,
      model: out.model,
      prompt_version: PROMPT_VERSION,
      idempotency_key,
    };

    // Step 12: defense-in-depth Zod parse. Catches any drift between the
    // synthesizer output and the persisted shape (e.g. a future model
    // emitting an unknown field, or a refactor missing a metadata
    // stamp). Failure aborts the chain write — we never persist a
    // malformed event.
    const parsed = ActivityRegisterDraftedPayload.parse(payload);

    // Step 13: append to the chain. captured_by_user_id pinned to the
    // Agent B system user (see `AGENT_B_SYSTEM_USER_ID` JSDoc). The
    // hash chain helper holds a per-subject_tenant advisory lock, so
    // concurrent writes against the same chain serialise.
    await insertEventWithChain({
      tenant_id: input.tenant_id,
      subject_tenant_id: project.subject_tenant_id,
      project_id: input.project_id,
      kind: 'ACTIVITY_REGISTER_DRAFTED',
      payload: parsed,
      classification: null,
      captured_at: new Date(),
      captured_by_user_id: AGENT_B_SYSTEM_USER_ID,
      override_of_event_id: null,
      override_new_kind: null,
      override_reason: null,
      idempotency_key,
    });

    // Step 14: cache the result. `writeCache` uses ON CONFLICT DO NOTHING
    // so a race between two concurrent jobs against the same key writes
    // exactly one row (first-write-wins).
    await writeCache({
      idempotency_key,
      agent_name: AGENT_NAME,
      prompt_version: PROMPT_VERSION,
      output: parsed,
      tokens_in: out.tokens_in,
      tokens_out: out.tokens_out,
      model: out.model,
    });

    return {
      status: 'synthesized',
      proposed_activity_count: parsed.proposed_activities.length,
      unclustered_event_count: parsed.unclustered_event_ids.length,
      events_truncated,
    };
  } catch (e) {
    // Single-project, single-event-write semantics: any failure aborts
    // the pass entirely. The caller (pg-boss subscriber, future) owns
    // retry policy.
    const reason = e instanceof Error ? e.message : String(e);
    return { status: 'failed', reason };
  }
}
