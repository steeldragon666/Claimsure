/**
 * POST /v1/activities/:id/portal-fields — generate the 13 core / 9 supporting
 * AusIndustry-portal-ready fields for an activity via the
 * `draft-narrative@1.2.0` prompt, then persist the result into
 * `activity.portal_fields` (migration 0044).
 *
 * Sister route to /v1/activities/:id/narrative — both reach the same
 * narrative-drafter agent module but exercise different prompt versions:
 *   - /narrative           → draft-narrative@1.0.0 (streaming `emit_segment`)
 *   - /portal-fields       → draft-narrative@1.2.0 (single `emit_portal_fields`)
 *
 * Synchronous request/response (no streaming) — v1.2.0 emits exactly one
 * tool call totalling ≤8000 tokens; ~50-75s wall-clock with Sonnet 4.5.
 *
 * Idempotency: each POST regenerates from current evidence + overwrites the
 * stored portal_fields. Versioning + draft-history is a future iteration
 * (the existing `narrative_draft` infrastructure is per-section and doesn't
 * cleanly map to the portal-fields structure; needs its own migration).
 *
 * Feature gate: re-uses the Agent C `isAgentEnabled('C')` + tenant
 * allowlist that gates the narrative drafter, since both surfaces share
 * the same prompt registry + model spend.
 */

// @anthropic-ai/sdk v0.32.x exposes the client class as the module's default
// export. NodeNext + esModuleInterop (apps/api's tsconfig) unwraps that
// correctly, but some bundler-style resolvers (e.g. Next.js's tsc under
// `moduleResolution: bundler`) leave the import as a namespace and trip
// TS2351 ("no construct signatures") at `new Anthropic(...)`. Importing the
// namespace explicitly and pulling `.default` off it resolves uniformly under
// every module resolution mode we encounter (NodeNext, bundler, node16).
import * as AnthropicSDK from '@anthropic-ai/sdk';
const Anthropic = AnthropicSDK.default;
import type { FastifyInstance } from 'fastify';
import { sql } from '@cpa/db/client';
import { requireSession } from '@cpa/auth';
import { z } from 'zod';
import { callWithToolUse, getPrompt, isAgentEnabled, isTenantAllowed } from '@cpa/agents/runtime';
// Side-effect import: `@cpa/agents/narrative-drafter` registers v1.2.0
// in the prompt registry on first load (see narrative-drafter/index.ts).
import { type EmitPortalFieldsToolInput } from '@cpa/agents/narrative-drafter';
import { CorePortalFieldsSchema, SupportingPortalFieldsSchema } from '@cpa/schemas';

const Uuid = z.string().uuid();
const PROMPT_KEY = 'draft-narrative@1.2.0';
const PROMPT_VERSION = '1.2.0';
const MODEL = process.env['PORTAL_FIELDS_MODEL'] ?? 'claude-sonnet-4-5';
// 8000 tokens covers 13 core fields populated to their per-field caps
// (most fields cap at 4000 chars ~= 1000 tokens; only the largest 2-3
// fields approach that). Empirically ~3000 tokens for a Sonnet response.
const MAX_TOKENS = 8000;
// Sonnet 4.5 generating 13 portal fields legitimately runs 50-75s with
// the prompt's expansive per-field instructions. Bump above the shared
// getAnthropicClient singleton's 30s default for this single-call path.
const ANTHROPIC_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

type ActivityCtx = {
  id: string;
  project_id: string;
  claim_id: string;
  code: string;
  kind: 'core' | 'supporting';
  title: string;
  hypothesis: string | null;
  technical_uncertainty: string | null;
  expected_outcome: string | null;
  project_name: string;
  project_subject_tenant_id: string;
  fiscal_year: number | null;
};

type EvidenceEvent = {
  id: string;
  kind: string;
  captured_at: string;
  body: string;
};

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * Cap on retained history entries. Activities that are regenerated
 * frequently would otherwise accumulate unbounded jsonb on the row;
 * 10 is plenty for "show me the last few attempts" while keeping the
 * per-row payload bounded (~10 × 13 fields × 4000 chars ≈ 500 KB worst
 * case, well under postgres's 1 GB toast limit).
 */
const HISTORY_CAP = 10;

type HistoryEntry = {
  portal_fields: Record<string, unknown>;
  saved_at: string;
  source: 'agent' | 'edit';
};

/**
 * Push the activity's CURRENT portal_fields onto its history array
 * (if it has anything worth keeping), then overwrite portal_fields
 * with `next`. The history array stays sorted oldest-first and is
 * truncated to the most-recent {@link HISTORY_CAP} entries.
 *
 * Runs inside a single transaction so the read-then-overwrite is
 * atomic from concurrent writers' perspective (RLS protects the row).
 */
async function overwriteWithHistory(args: {
  tenantId: string;
  activityId: string;
  next: Record<string, unknown>;
  source: 'agent' | 'edit';
}): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${args.tenantId}, true)`;
    const rows = await tx<
      { portal_fields: Record<string, unknown>; portal_fields_history: HistoryEntry[] }[]
    >`
      SELECT portal_fields, portal_fields_history
        FROM activity
       WHERE id = ${args.activityId}
         AND tenant_id = ${args.tenantId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      throw new Error(`activity not found mid-transaction: ${args.activityId}`);
    }
    // Only push the prior state if it was meaningfully populated — the
    // migration-0044 default `{}` is not worth archiving.
    const priorHasContent =
      typeof row.portal_fields['activity_kind'] === 'string' && row.portal_fields['fields'];
    const newEntry: HistoryEntry | null = priorHasContent
      ? {
          portal_fields: row.portal_fields,
          saved_at: new Date().toISOString(),
          source: args.source,
        }
      : null;
    const updatedHistory = (
      newEntry
        ? [...(row.portal_fields_history ?? []), newEntry]
        : (row.portal_fields_history ?? [])
    ).slice(-HISTORY_CAP);

    await tx`
      UPDATE activity
         SET portal_fields         = ${JSON.stringify(args.next)}::text::jsonb,
             portal_fields_history = ${JSON.stringify(updatedHistory)}::text::jsonb,
             updated_at            = NOW()
       WHERE id = ${args.activityId}
         AND tenant_id = ${args.tenantId}
    `;
  });
}

// ---------------------------------------------------------------------------
// Helpers — local copies to avoid coupling portal-fields to narrative.ts
// ---------------------------------------------------------------------------

async function loadActivityCtx(activityId: string, tenantId: string): Promise<ActivityCtx | null> {
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return await tx<ActivityCtx[]>`
      SELECT a.id,
             a.project_id,
             a.claim_id,
             a.code,
             a.kind,
             a.title,
             a.hypothesis,
             a.technical_uncertainty,
             a.expected_outcome,
             p.name              AS project_name,
             p.subject_tenant_id AS project_subject_tenant_id,
             c.fiscal_year       AS fiscal_year
        FROM activity a
        JOIN project  p ON p.id = a.project_id
   LEFT JOIN claim    c ON c.id = a.claim_id
       WHERE a.id = ${activityId}
         AND a.tenant_id = ${tenantId}
       LIMIT 1
    `;
  });
  return rows[0] ?? null;
}

/**
 * Pull up to `limit` recent classified evidence events for the activity's
 * subject_tenant. Differs from narrative.ts `loadClusteredEventIds` (which
 * traces the Agent-B clustering chain) — portal-fields draws from the
 * activity's own evidence pool, not the proposed-activity clustering. This
 * is intentional: v1.2.0 is designed to be invokable after the consultant
 * has manually bound evidence to the activity (via artefact_link or direct
 * activity_id assignment), independent of the auto-clustering pipeline.
 *
 * Returns events ordered by captured_at ascending so the model sees a
 * roughly chronological narrative trajectory.
 */
async function loadEvidenceEvents(
  activityId: string,
  subjectTenantId: string,
  tenantId: string,
  limit: number,
): Promise<EvidenceEvent[]> {
  type Row = {
    id: string;
    kind: string;
    captured_at: Date | string;
    payload: unknown;
  };
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return await tx<Row[]>`
      SELECT e.id, e.kind, e.captured_at, e.payload
        FROM event e
   LEFT JOIN artefact_link al ON al.artefact_id = e.id AND al.artefact_kind = 'event'
       WHERE e.tenant_id = ${tenantId}
         AND e.subject_tenant_id = ${subjectTenantId}
         AND (e.activity_id = ${activityId} OR al.activity_id = ${activityId})
       ORDER BY e.captured_at ASC
       LIMIT ${limit}
    `;
  });
  const out: EvidenceEvent[] = [];
  for (const row of rows) {
    let body = '';
    if (row.payload && typeof row.payload === 'object') {
      const p = row.payload as Record<string, unknown>;
      const text = p['text'] ?? p['raw_text'] ?? p['body'] ?? '';
      if (typeof text === 'string') body = text;
    }
    const ts =
      typeof row.captured_at === 'string' ? row.captured_at : row.captured_at.toISOString();
    out.push({ id: row.id, kind: row.kind, captured_at: ts, body });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function registerPortalFields(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    '/v1/activities/:id/portal-fields',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      const tenantId = req.user!.tenantId!;
      const activityId = req.params.id;
      if (!Uuid.safeParse(activityId).success) {
        return reply.status(400).send({
          error: 'invalid_activity_id',
          message: 'activity id must be a uuid',
          requestId: req.id,
        });
      }

      // Share the Agent-C feature gate — same prompt registry, same spend.
      if (!isAgentEnabled('C') || !isTenantAllowed(tenantId)) {
        return reply.status(503).send({
          error: 'feature_disabled',
          message: 'Portal-fields drafter is currently disabled for this tenant',
          requestId: req.id,
        });
      }

      const activity = await loadActivityCtx(activityId, tenantId);
      if (!activity) {
        return reply.status(404).send({
          error: 'activity_not_found',
          message: 'No activity with that id in this firm',
          requestId: req.id,
        });
      }

      const events = await loadEvidenceEvents(
        activityId,
        activity.project_subject_tenant_id,
        tenantId,
        200,
      );

      // Build the user payload — same shape as the smoke-test fixture in
      // tools/scripts/test-portal-fields.ts so prompt-template iteration
      // stays consistent across live and smoke-test paths.
      const userPayload = {
        activity_kind: activity.kind,
        activity: {
          id: activity.id,
          code: activity.code,
          name: activity.title,
          kind: activity.kind,
          statutory_anchor: activity.kind === 'core' ? 's.355-25' : 's.355-30',
          project_id: activity.project_id,
        },
        project: {
          id: activity.project_id,
          name: activity.project_name,
          fiscal_year: activity.fiscal_year,
        },
        proposed_hypothesis: activity.hypothesis,
        proposed_uncertainty: activity.technical_uncertainty,
        clustered_events: events.map((e) => ({
          id: e.id,
          kind: e.kind,
          captured_at: e.captured_at,
          body: e.body,
        })),
      };

      const prompt = getPrompt<EmitPortalFieldsToolInput>(PROMPT_KEY);

      // Local Anthropic client with the longer timeout. The shared
      // getAnthropicClient singleton uses 30s; v1.2.0 with 13 core fields
      // legitimately needs ~50-75s. See ANTHROPIC_TIMEOUT_MS comment above.
      const apiKey = process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        return reply.status(500).send({
          error: 'config_error',
          message: 'ANTHROPIC_API_KEY not configured',
          requestId: req.id,
        });
      }
      const client = new Anthropic({
        apiKey,
        maxRetries: 2,
        timeout: ANTHROPIC_TIMEOUT_MS,
      });

      const t0 = Date.now();
      let generated: EmitPortalFieldsToolInput;
      let tokensIn = 0;
      let tokensOut = 0;
      try {
        const result = await callWithToolUse<EmitPortalFieldsToolInput>(client, {
          model: MODEL,
          system: prompt.system,
          user: JSON.stringify(userPayload, null, 2),
          tool: prompt.tool,
          max_tokens: MAX_TOKENS,
        });
        generated = result.output;
        tokensIn = result.tokens_in;
        tokensOut = result.tokens_out;
      } catch (err) {
        app.log.error({ err, activityId }, 'portal-fields generation failed');
        return reply.status(502).send({
          error: 'agent_failed',
          message: err instanceof Error ? err.message : String(err),
          requestId: req.id,
        });
      }
      const elapsedMs = Date.now() - t0;

      // Cross-check: the Zod-validated activity_kind must agree with the
      // activity row. If the model defied the system prompt and emitted
      // the wrong kind, reject — persisting the mismatch would corrupt
      // the activity's portal-fields shape.
      if (generated.activity_kind !== activity.kind) {
        app.log.error(
          { activityId, expected: activity.kind, got: generated.activity_kind },
          'portal-fields kind mismatch',
        );
        return reply.status(502).send({
          error: 'agent_kind_mismatch',
          message: `Model emitted ${generated.activity_kind} but activity is ${activity.kind}`,
          requestId: req.id,
        });
      }

      // Persist — overwrite activity.portal_fields with the validated payload.
      // The helper archives the prior state into portal_fields_history first
      // (capped at HISTORY_CAP=10 entries; oldest dropped on overflow).
      await overwriteWithHistory({
        tenantId,
        activityId,
        next: generated,
        source: 'agent',
      });

      app.log.info(
        {
          activityId,
          activityKind: activity.kind,
          tokensIn,
          tokensOut,
          elapsedMs,
          eventsCount: events.length,
        },
        'portal-fields generated',
      );

      return reply.status(200).send({
        portal_fields: generated,
        meta: {
          model: MODEL,
          prompt_version: PROMPT_VERSION,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          elapsed_ms: elapsedMs,
          events_count: events.length,
        },
      });
    },
  );

  // -----------------------------------------------------------------
  // PATCH /v1/activities/:id/portal-fields — consultant edits the
  // generated payload. The body is a partial `fields` object; the
  // server reads the existing portal_fields, shallow-merges the patch
  // into `fields`, and re-validates the result against the
  // activity-kind-appropriate Zod schema.
  //
  // Returns the validated merged payload. 400 on validation failure
  // (e.g. text field exceeds the AusIndustry 4000-char cap), 404 if
  // the activity has no portal_fields yet (POST first).
  // -----------------------------------------------------------------
  const PatchBody = z
    .object({
      fields: z.record(z.unknown()),
    })
    .strict();

  app.patch<{ Params: { id: string } }>(
    '/v1/activities/:id/portal-fields',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      const tenantId = req.user!.tenantId!;
      const activityId = req.params.id;
      if (!Uuid.safeParse(activityId).success) {
        return reply.status(400).send({
          error: 'invalid_activity_id',
          message: 'activity id must be a uuid',
          requestId: req.id,
        });
      }

      const bodyParse = PatchBody.safeParse(req.body);
      if (!bodyParse.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: 'Body must be { fields: object }',
          issues: bodyParse.error.issues,
          requestId: req.id,
        });
      }
      const patchFields = bodyParse.data.fields;

      // Load the existing row inside RLS so cross-firm activity = 404.
      type ExistingRow = { kind: 'core' | 'supporting'; portal_fields: Record<string, unknown> };
      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return await tx<ExistingRow[]>`
          SELECT kind, portal_fields
            FROM activity
           WHERE id = ${activityId}
             AND tenant_id = ${tenantId}
           LIMIT 1
        `;
      });
      const row = rows[0];
      if (!row) {
        return reply.status(404).send({
          error: 'activity_not_found',
          message: 'No activity with that id in this firm',
          requestId: req.id,
        });
      }

      // Refuse to edit before generation — otherwise the consultant
      // would have to author all 13/9 fields manually, which the
      // POST agent path is for. (`{}` is the migration-0044 default.)
      const existing = row.portal_fields;
      const hasPriorGeneration =
        typeof existing['activity_kind'] === 'string' &&
        existing['fields'] !== undefined &&
        existing['fields'] !== null;
      if (!hasPriorGeneration) {
        return reply.status(404).send({
          error: 'portal_fields_not_generated',
          message: 'Generate portal fields first via POST before editing',
          requestId: req.id,
        });
      }

      // Shallow-merge the patch into the existing `fields` object. Nested
      // fields (e.g. `dominant_purpose`) must be sent in full by the client
      // — partial nested merges aren't supported here, by design (keeps
      // the server-side merge predictable and the audit trail clean).
      const mergedFields = {
        ...((existing['fields'] ?? {}) as Record<string, unknown>),
        ...patchFields,
      };

      // Re-validate against the kind-appropriate Zod schema. This is the
      // authoritative check: char limits, enum values, UUID format, the
      // is_dominant_purpose === true literal, etc. all enforce here.
      const schema = row.kind === 'core' ? CorePortalFieldsSchema : SupportingPortalFieldsSchema;
      const validated = schema.safeParse(mergedFields);
      if (!validated.success) {
        return reply.status(400).send({
          error: 'invalid_portal_fields',
          message: 'Merged portal_fields fails schema validation',
          issues: validated.error.issues,
          requestId: req.id,
        });
      }

      const persisted = { activity_kind: row.kind, fields: validated.data };
      await overwriteWithHistory({
        tenantId,
        activityId,
        next: persisted,
        source: 'edit',
      });

      app.log.info(
        {
          activityId,
          activityKind: row.kind,
          patchedKeys: Object.keys(patchFields),
        },
        'portal-fields edited',
      );

      return reply.status(200).send({ portal_fields: persisted });
    },
  );

  // -----------------------------------------------------------------
  // POST /v1/activities/:id/portal-fields/trim — stateless transform
  //
  // Given a piece of over-cap text from a portal field, ask Haiku to
  // produce a tighter version that fits within `target_max` chars while
  // preserving technical meaning and the AusIndustry register. The
  // server does not persist anything — the client receives the
  // suggestion and the consultant chooses whether to accept it.
  //
  // Haiku is appropriate here: this is a focused single-pass rewrite,
  // not multi-field generation. ~3-5s round-trip.
  // -----------------------------------------------------------------
  const TrimBody = z
    .object({
      field_key: z.string().min(1),
      current_text: z.string().min(1),
      target_max: z.number().int().positive(),
    })
    .strict();

  const TRIM_SYSTEM_PROMPT = `You are an editor for Australian R&D Tax Incentive
narratives (Division 355, ITAA 1997). Your job is to compress text so that it
fits within a strict character limit while preserving:
  - Every concrete claim (numbers, dates, methods, outcomes)
  - The third-person technical register ("the team", "the claimant")
  - Australian English spelling
  - Every statutory or regulatory reference (s.355-25, s.355-30, etc.)

Hard rules:
  - The trimmed text MUST be shorter than the original.
  - The trimmed text MUST fit within the target character limit.
  - Do NOT add facts. Do NOT remove distinct claims.
  - Plain prose. No bullet lists unless the original used them.

Emit your output via the \`emit_trimmed_text\` tool — exactly one call
with the rewritten text. No commentary outside the tool call.`;

  const trimToolSchema = z.object({ trimmed: z.string().min(1) });

  app.post<{ Params: { id: string } }>(
    '/v1/activities/:id/portal-fields/trim',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      const tenantId = req.user!.tenantId!;
      const activityId = req.params.id;
      if (!Uuid.safeParse(activityId).success) {
        return reply.status(400).send({ error: 'invalid_activity_id', requestId: req.id });
      }
      if (!isAgentEnabled('C') || !isTenantAllowed(tenantId)) {
        return reply.status(503).send({ error: 'feature_disabled', requestId: req.id });
      }
      const parsed = TrimBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          issues: parsed.error.issues,
          requestId: req.id,
        });
      }
      const { field_key, current_text, target_max } = parsed.data;

      // Activity-scope check (RLS) — confirms the consultant can edit
      // this activity before we spend tokens on the trim call.
      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return await tx<{ id: string }[]>`
          SELECT id FROM activity
           WHERE id = ${activityId} AND tenant_id = ${tenantId} LIMIT 1
        `;
      });
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'activity_not_found', requestId: req.id });
      }

      const apiKey = process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        return reply.status(500).send({ error: 'config_error', requestId: req.id });
      }
      const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });

      const userMessage = [
        `Field: ${field_key}`,
        `Target maximum length: ${target_max} characters`,
        `Current length: ${current_text.length} characters`,
        '',
        '--- TEXT TO COMPRESS ---',
        current_text,
      ].join('\n');

      const t0 = Date.now();
      let trimmed: string;
      try {
        const result = await callWithToolUse(client, {
          model: process.env['PORTAL_FIELDS_TRIM_MODEL'] ?? 'claude-haiku-4-5',
          system: TRIM_SYSTEM_PROMPT,
          user: userMessage,
          tool: {
            name: 'emit_trimmed_text',
            description: 'Emit the trimmed version of the supplied text.',
            input_schema: trimToolSchema,
          },
          max_tokens: 2048,
        });
        trimmed = result.output.trimmed;
      } catch (err) {
        app.log.error({ err, activityId, field_key }, 'portal-fields trim failed');
        return reply.status(502).send({
          error: 'agent_failed',
          message: err instanceof Error ? err.message : String(err),
          requestId: req.id,
        });
      }

      // Defensive check: if Haiku returns something LONGER than the
      // original (rare but possible — models sometimes "polish" instead
      // of trim), surface that to the client rather than silently passing
      // it through. The UI shows the suggestion and the consultant can
      // accept or discard either way.
      const fitsCap = trimmed.length <= target_max;
      const isShorter = trimmed.length < current_text.length;
      return reply.status(200).send({
        trimmed,
        meta: {
          original_length: current_text.length,
          trimmed_length: trimmed.length,
          target_max,
          fits_cap: fitsCap,
          is_shorter: isShorter,
          elapsed_ms: Date.now() - t0,
        },
      });
    },
  );
}
