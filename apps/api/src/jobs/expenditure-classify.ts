import { privilegedSql } from '@cpa/db/client';
import { canonicalJsonStringify, insertEventWithChain } from '@cpa/db';
import {
  computeIdempotencyKey,
  EXPENDITURE_CONFIDENCE_THRESHOLDS,
  isAgentEnabled,
  isTenantAllowed,
  lookupCache,
  makeExpenditureClassifier,
  withAgentSpan,
  writeCache,
  type ExpenditureClassifierInput,
  type ExpenditureClassifierOutput,
} from '@cpa/agents';
import { ExpenditureClassifiedPayload } from '@cpa/schemas';

/**
 * Agent A (expenditure classifier) pg-boss job processor — Task 3.3.
 *
 * Mirrors the existing batch / iterate-over-rows pattern from
 * `audit-score-recompute.ts`, with per-row error isolation cribbed from
 * `recomputeAllActive`. The pg-boss subscriber wiring is deferred per the
 * existing convention (see `transcribe.ts`, `daily-capture-push.ts`) — this
 * file exports a callable HANDLER (`runExpenditureClassifyJob`) that the
 * future subscriber will dispatch to. The Task 3.4 auto-trigger hook calls
 * this same entrypoint inline for now.
 *
 * Pipeline per expenditure (see Task 3.3 design notes):
 *   1. Compute content-addressed idempotency key over the input bundle.
 *   2. Cache lookup — skip if a prior run produced the same answer.
 *   3. Classify under an OTel span (cost emitted automatically by telemetry).
 *   4. Server-side threshold downgrade to `needs_review` when confidence <
 *      REVIEW_RECOMMENDED, even if the model claimed `eligible|ineligible`.
 *   5. Insert `EXPENDITURE_CLASSIFIED` event via the hash chain.
 *   6. Persist the cache entry.
 *
 * Worker context: this runs WITHOUT a request-scoped tenant GUC, so all
 * reads use `privilegedSql` (cpa role, RLS-bypass) and explicitly scope on
 * `tenant_id` in WHERE clauses. The chain-insert helper sets the GUC inside
 * its own transaction, which is sufficient for the policy check on the
 * `event` INSERT itself.
 */

/**
 * System "user" UUID used as `captured_by_user_id` for events written by
 * the Agent A worker. Workers don't have a request user; the chain expects
 * a non-null `captured_by_user_id` (or `captured_by_employee_id`). We
 * reserve a fixed UUID under the existing `00000000-0000-4000-8000-...`
 * v4-shaped namespace (the `a90` infix encodes "Agent A" — see
 * `tools/scripts/onboard-tenant.test.ts` for the broader convention).
 *
 * The user row must EXIST in `"user"` for the FK to validate. The Task 3.4
 * trigger hook (or onboarding tooling) is responsible for seeding it; for
 * now the row is seeded by individual test fixtures that exercise this
 * job. Production deployment will need to ensure the row is bootstrapped —
 * called out in the reviewer summary.
 */
export const AGENT_A_SYSTEM_USER_ID = '00000000-0000-4000-8000-000000a90001';

/**
 * Shared prompt version identifier — must match the side-effect import in
 * `classifier-expenditure/index.ts` and the value the Haiku impl returns
 * for `output.prompt_version`. Hard-coded here (rather than imported from
 * the prompt module) to keep the worker self-describing in the cache row
 * even if the impl swaps to stub.
 */
const PROMPT_VERSION = 'classify-expenditure@1.0.0';

/**
 * Maximum expenditures handled per job invocation. Caller (the Task 3.4
 * hook + the future pg-boss subscriber) is responsible for chunking
 * larger sets across multiple jobs. Configurable via
 * `P6_AGENT_A_BATCH_SIZE` for staged rollout — default 25 matches the
 * design doc.
 */
export const EXPENDITURE_CLASSIFY_BATCH_SIZE = Number(process.env.P6_AGENT_A_BATCH_SIZE ?? '25');

export type ExpenditureClassifyJobInput = {
  tenant_id: string;
  /** Up to {@link EXPENDITURE_CLASSIFY_BATCH_SIZE} ids; caller batches. */
  expenditure_ids: string[];
};

export type ExpenditureClassifyJobResult = {
  classified: number;
  skipped_idempotent: number;
  failed: number;
  /** Count of decisions forced to `needs_review` by the confidence threshold. */
  needs_review_downgraded: number;
};

const ZERO_RESULT: ExpenditureClassifyJobResult = {
  classified: 0,
  skipped_idempotent: 0,
  failed: 0,
  needs_review_downgraded: 0,
};

/**
 * Row shape from the single-trip context query. Numeric columns come back
 * as strings from postgres-js (preserves precision); the classifier input
 * types already declare `total_amount: string` for the same reason.
 */
type ExpenditureContextRow = {
  expenditure_id: string;
  subject_tenant_id: string;
  vendor_name: string;
  description: string | null;
  total_amount: string;
  currency: string;
  expenditure_date: string; // postgres returns DATE as 'YYYY-MM-DD'
  source: 'xero_invoice' | 'xero_bank_tx' | 'xero_receipt' | 'manual';
  // The expenditure table has no `kind` column — derive from `source`.
  // Stored as `kind` here for parity with ExpenditureClassifierInput.
  project_name: string | null;
  fiscal_year: number | null;
};

/**
 * Map the `source` discriminator to the wire-format `kind` the classifier
 * input bundle expects. The two columns track different facets — `source`
 * is the upstream system, `kind` is the document type — but in practice
 * they line up 1:1 today.
 */
function deriveKind(source: ExpenditureContextRow['source']): 'INVOICE' | 'BANK_TX' | 'RECEIPT' {
  switch (source) {
    case 'xero_invoice':
      return 'INVOICE';
    case 'xero_bank_tx':
      return 'BANK_TX';
    case 'xero_receipt':
      return 'RECEIPT';
    case 'manual':
      // Manual entries are typically invoice-shaped (vendor + total).
      return 'INVOICE';
  }
}

/**
 * Classify a batch of expenditures. Errors on any single expenditure are
 * caught + logged; the rest of the batch still runs.
 */
export async function runExpenditureClassifyJob(
  input: ExpenditureClassifyJobInput,
): Promise<ExpenditureClassifyJobResult> {
  // Defense-in-depth feature gates. Both gates ALSO live in the Task 3.4
  // auto-trigger hook (where they short-circuit dispatch); keeping them
  // here means the job is safe even if a stale subscriber dispatches a
  // backlog after an operator flips the kill-switch.
  if (!isAgentEnabled('A')) return { ...ZERO_RESULT };
  if (!isTenantAllowed(input.tenant_id)) return { ...ZERO_RESULT };
  if (input.expenditure_ids.length === 0) return { ...ZERO_RESULT };

  const result: ExpenditureClassifyJobResult = { ...ZERO_RESULT };

  for (const expenditureId of input.expenditure_ids) {
    try {
      const outcome = await classifyOne(input.tenant_id, expenditureId);
      switch (outcome.kind) {
        case 'classified':
          result.classified += 1;
          if (outcome.downgraded) result.needs_review_downgraded += 1;
          break;
        case 'skipped_idempotent':
          result.skipped_idempotent += 1;
          break;
        case 'not_found':
          // Treat a vanished expenditure as a per-row failure (the caller
          // gave us an id that no longer points at a row). Logged so the
          // dispatch source can be investigated, but doesn't abort the
          // batch.
          result.failed += 1;
          console.error(
            `[expenditure-classify] expenditure not found: tenant=${input.tenant_id} id=${expenditureId}`,
          );
          break;
      }
    } catch (e) {
      result.failed += 1;
      console.error(`[expenditure-classify] failed for ${expenditureId}:`, (e as Error).message);
    }
  }

  return result;
}

type OneOutcome =
  | { kind: 'classified'; downgraded: boolean }
  | { kind: 'skipped_idempotent' }
  | { kind: 'not_found' };

/**
 * Classify a single expenditure. Extracted so the per-row try/catch above
 * stays compact and the happy-path flow reads top-to-bottom.
 *
 * Returns a discriminated outcome rather than throwing for "not found" —
 * a missing expenditure is a caller-supplied id mismatch, not a system
 * error, so it shouldn't bubble up as an exception that the batch loop
 * has to special-case.
 */
async function classifyOne(tenantId: string, expenditureId: string): Promise<OneOutcome> {
  // Single round-trip: pulls the expenditure plus its claim/project
  // context. Uses LEFT JOINs on claim+project because expenditures CAN
  // exist before being mapped to a claim (claim_id is nullable on
  // expenditure). Tenant-scoped explicitly since the worker has no GUC.
  const ctxRows = await privilegedSql<ExpenditureContextRow[]>`
    SELECT
      e.id              AS expenditure_id,
      e.subject_tenant_id,
      e.vendor_name,
      el.description    AS description,
      e.total_amount,
      e.currency,
      to_char(e.expenditure_date, 'YYYY-MM-DD') AS expenditure_date,
      e.source,
      p.name            AS project_name,
      c.fiscal_year     AS fiscal_year
    FROM expenditure e
    LEFT JOIN claim   c ON c.id = e.claim_id
    LEFT JOIN project p ON p.id = c.project_id
    LEFT JOIN LATERAL (
      SELECT description
        FROM expenditure_line
       WHERE expenditure_id = e.id
       ORDER BY line_number ASC
       LIMIT 1
    ) el ON true
    WHERE e.id = ${expenditureId}
      AND e.tenant_id = ${tenantId}
    LIMIT 1
  `;
  const ctx = ctxRows[0];
  if (!ctx) return { kind: 'not_found' };

  // Existing activities for the project (Agent B output, possibly empty).
  // The activity table has no `statutory_anchor` column today — Agent B's
  // proposal carries it on the event payload, but `activity` itself only
  // has `kind` (core/supporting). The classifier input requires both, so
  // we derive the anchor from the kind:
  //   core       → 's.355-25'
  //   supporting → 's.355-30'
  // This mapping matches the Division 355 statute exactly and is stable
  // because Agent B's prompt enforces the same pairing.
  type ActivityRow = {
    id: string;
    name: string;
    kind: 'core' | 'supporting';
    description: string | null;
  };
  const activityRows = await privilegedSql<ActivityRow[]>`
    SELECT a.id, a.title AS name, a.kind, a.description
      FROM activity a
      JOIN claim   c ON c.id = a.claim_id
     WHERE a.tenant_id = ${tenantId}
       AND c.subject_tenant_id = ${ctx.subject_tenant_id}
       AND c.id = (SELECT claim_id FROM expenditure WHERE id = ${expenditureId})
  `;

  // Recent R&D evidence events for the same subject_tenant. Filter on the
  // classifiable evidence kinds (HYPOTHESIS through INELIGIBLE — the
  // pre-P4 R&D narrative kinds), excluding state-transition kinds that
  // would just be noise to the classifier. Top 10 by capture time.
  const evidenceRows = await privilegedSql<
    { id: string; kind: string; captured_at: Date; payload: { raw_text?: string } }[]
  >`
    SELECT id, kind, captured_at, payload
      FROM event
     WHERE tenant_id = ${tenantId}
       AND subject_tenant_id = ${ctx.subject_tenant_id}
       AND kind IN (
         'HYPOTHESIS','DESIGN','EXPERIMENT','OBSERVATION','ITERATION',
         'NEW_KNOWLEDGE','UNCERTAINTY','TIME_LOG','ASSOCIATE_FLAG',
         'EXPENDITURE_NOTE','SUPPORTING','INELIGIBLE'
       )
     ORDER BY captured_at DESC
     LIMIT 10
  `;

  // Build the deterministic input bundle. Field order matters for hashing
  // because we round-trip the bundle through JSON.stringify (V8 preserves
  // insertion order for non-numeric keys). All sites that build this
  // bundle MUST follow this exact ordering for the cache key to be
  // stable across processes.
  const inputBundle: ExpenditureClassifierInput = {
    expenditure_id: expenditureId,
    expenditure: {
      vendor_name: ctx.vendor_name,
      description: ctx.description,
      total_amount: ctx.total_amount,
      currency: ctx.currency,
      expenditure_date: ctx.expenditure_date,
      source: ctx.source,
      kind: deriveKind(ctx.source),
    },
    project: {
      name: ctx.project_name ?? '',
      // The `project` table has no `industry_sector` column today — the
      // classifier input shape was forward-looking. Pass null until the
      // column lands.
      industry_sector: null,
      fiscal_year: ctx.fiscal_year ?? 0,
    },
    existing_activities: activityRows.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      statutory_anchor: a.kind === 'core' ? 's.355-25' : 's.355-30',
      description: a.description,
    })),
    recent_evidence_events: evidenceRows.map((ev) => ({
      id: ev.id,
      kind: ev.kind,
      captured_at: ev.captured_at.toISOString(),
      // Best-effort summary — the event payload has heterogeneous shapes
      // across kinds, so the classifier prompt teaches the model to
      // tolerate sparse summaries. Falling back to `[kind]` is a
      // deterministic placeholder.
      summary: typeof ev.payload?.raw_text === 'string' ? ev.payload.raw_text : `[${ev.kind}]`,
    })),
  };

  // Idempotency key is content-addressed over (prompt_version, input
  // bundle JSON). Same string is reused for both the cache lookup and
  // the eventual `EXPENDITURE_CLASSIFIED` payload — diverging the two
  // would silently break dedupe across deploys.
  //
  // Uses `canonicalJsonStringify` (sorted-key recursive serializer
  // shared with the event chain) instead of the bare `JSON.stringify`
  // so a future field-reorder in the literal above can't silently
  // invalidate the cache. V8 preserves insertion order for non-numeric
  // keys today, but relying on that is a footgun — a refactor that
  // moves `expenditure` below `project` would produce different bytes
  // and a cache-miss storm doubling Anthropic spend until backfill.
  const inputJson = canonicalJsonStringify(inputBundle);
  const idempotencyKey = computeIdempotencyKey(PROMPT_VERSION, inputJson);

  const cached = await lookupCache(idempotencyKey);
  if (cached) {
    // Original event already on the chain — do not double-emit.
    return { kind: 'skipped_idempotent' };
  }

  // Telemetry span wraps the classifier call so token counts + cost are
  // recorded automatically. The model attribute is overwritten by setAttr
  // with the impl's actual model id once the classifier returns; passing
  // the placeholder up front keeps the span shape stable for filterers
  // that bucket on `cpa.model`.
  const classifierResult: ExpenditureClassifierOutput = await withAgentSpan(
    'expenditure-classifier',
    {
      agent_name: 'expenditure-classifier',
      prompt_version: PROMPT_VERSION,
      model: 'pending',
      tenant_id: tenantId,
      subject_tenant_id: ctx.subject_tenant_id,
    },
    async (setAttr) => {
      const classifier = makeExpenditureClassifier();
      const out = await classifier.classify(inputBundle);
      setAttr({
        tokens_in: out.tokens_in,
        tokens_out: out.tokens_out,
        model: out.model,
        classification_kind: out.decision,
        classification_confidence: out.eligibility_probability,
      });
      return out;
    },
  );

  // Server-side threshold downgrade. Defense-in-depth: even if the model
  // returns 'eligible' with low confidence, we override to 'needs_review'
  // so a consultant resolves it before any claim impact. The original
  // confidence is preserved on the payload for auditability.
  let downgraded = false;
  if (
    classifierResult.eligibility_probability <
      EXPENDITURE_CONFIDENCE_THRESHOLDS.REVIEW_RECOMMENDED &&
    classifierResult.decision !== 'needs_review'
  ) {
    classifierResult.decision = 'needs_review';
    classifierResult.uncertainty_reason =
      classifierResult.uncertainty_reason ??
      `confidence ${classifierResult.eligibility_probability.toFixed(2)} below threshold ${EXPENDITURE_CONFIDENCE_THRESHOLDS.REVIEW_RECOMMENDED}`;
    downgraded = true;
  }

  // Build the chain-event payload. Parsed through the Zod schema as a
  // runtime defense — a drift between the classifier output shape and
  // the event payload contract should fail loudly in dev, not silently
  // ship a malformed event onto the audit chain.
  const payload = ExpenditureClassifiedPayload.parse({
    _v: 1,
    expenditure_id: expenditureId,
    decision: classifierResult.decision,
    eligibility_probability: classifierResult.eligibility_probability,
    statutory_anchor: classifierResult.statutory_anchor,
    suggested_activity_id: classifierResult.suggested_activity_id,
    rationale: classifierResult.rationale,
    uncertainty_reason: classifierResult.uncertainty_reason,
    model: classifierResult.model,
    prompt_version: PROMPT_VERSION,
    idempotency_key: idempotencyKey,
  });

  await insertEventWithChain({
    tenant_id: tenantId,
    subject_tenant_id: ctx.subject_tenant_id,
    kind: 'EXPENDITURE_CLASSIFIED',
    payload,
    classification: null,
    captured_at: new Date(),
    captured_by_user_id: AGENT_A_SYSTEM_USER_ID,
    override_of_event_id: null,
    override_new_kind: null,
    override_reason: null,
    idempotency_key: idempotencyKey,
  });

  // Cache last so a chain-insert failure doesn't poison the cache with a
  // result that was never actually recorded. First-write-wins on conflict
  // keeps a concurrent dispatch from overwriting an earlier identical
  // result.
  await writeCache({
    idempotency_key: idempotencyKey,
    agent_name: 'expenditure-classifier',
    prompt_version: PROMPT_VERSION,
    output: payload,
    tokens_in: classifierResult.tokens_in,
    tokens_out: classifierResult.tokens_out,
    model: classifierResult.model,
  });

  return { kind: 'classified', downgraded };
}
