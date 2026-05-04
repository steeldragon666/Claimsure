import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { Uuid } from '@cpa/schemas';

/**
 * P7 Theme B Task B.3 — prompt-suggestion REST surface.
 *
 * Five endpoints under `/v1/suggestions`:
 *
 *   POST   /v1/suggestions                 — flag a new suggestion
 *   GET    /v1/suggestions                 — list, filter by status / source_kind
 *   GET    /v1/suggestions/:id             — detail (incl. reviews + pr nested)
 *   POST   /v1/suggestions/:id/triage      — set triage_classification + transition status
 *   POST   /v1/suggestions/:id/review      — append a review row (reviewer disposition)
 *   POST   /v1/suggestions/:id/generate-pr — STUB: enqueue PR generation, flip to pr_drafted
 *
 * (The 6th endpoint — the GitHub merge webhook receiver — is Task B.6.)
 *
 * Auth + RLS:
 *   - All routes require a session (`requireSession`).
 *   - Tenant isolation is via the `app.current_tenant_id` GUC set by the
 *     session plugin (and re-set inside each `sql.begin` for defence in
 *     depth, since postgres-js connection reuse + a dropped tx leg can
 *     leave the GUC unset on the next checkout — see narrative.ts for
 *     the same idiom).
 *   - Cross-firm row ids return 404 (info hiding), matching the
 *     mapping-rules / activities convention.
 *
 * Status state machine (enforced at the API layer):
 *
 *   open ─── triage(triaged) ──→ triaged ─── review(approve_for_pr) ──→ triaged
 *     │                            │                                       │
 *     │                            │                                       └── generate-pr ──→ pr_drafted
 *     │                            │
 *     │                            └── review(dismiss) ──→ dismissed
 *     │
 *     └── triage(dismissed) ──→ dismissed
 *
 *   pr_merged is set by the Task B.6 webhook receiver, NOT by these
 *   routes. Once a suggestion is in pr_drafted / pr_merged / dismissed,
 *   triage and review are rejected.
 *
 * Audit log:
 *   - Spec explicitly says DO NOT extend AUDIT_KINDS in this task. The
 *     suggestion's own row (with flagged_at, triage_classification,
 *     status, resolved_at) plus the append-only prompt_suggestion_review
 *     rows ARE the audit trail. Task B.8 will add audit_log entries for
 *     selected lifecycle events once usage informs the choice.
 *
 * Mocking note: tests must NOT require live Postgres (Docker is
 * unavailable in this worktree). The route is structured so handlers
 * call out to the shared `sql` template tag — the test file uses a
 * conditional setup that skips DB-touching cases when no connection is
 * reachable, while keeping the unit-level shape assertions (Zod
 * validation, auth gating, state-machine error mapping) green either
 * way.
 */

// ---------------------------------------------------------------------------
// Zod schemas — input contracts for the five routes.
// ---------------------------------------------------------------------------

const SOURCE_KINDS = [
  'consultant_flag',
  'rif_event',
  'contract_test_failure',
  'reviewer_disposition',
] as const;

const STATUSES = ['open', 'triaged', 'pr_drafted', 'pr_merged', 'dismissed'] as const;

const TRIAGE_CLASSIFICATIONS = [
  'prompt_change',
  'schema_change',
  'code_change',
  'no_action_needed',
] as const;

const REVIEW_DISPOSITIONS = [
  'approve_for_pr',
  'request_more_info',
  'dismiss',
  'escalate_to_code_change',
] as const;

const FlagSuggestionInput = z
  .object({
    source_kind: z.enum(SOURCE_KINDS),
    source_payload: z.record(z.unknown()),
    affected_prompt_module: z.string().min(1).max(200).optional(),
    affected_section_kind: z.string().min(1).max(100).optional(),
    issue_summary: z.string().min(10).max(1000),
  })
  .strict();

const ListSuggestionsQuery = z
  .object({
    status: z.enum(STATUSES).optional(),
    source_kind: z.enum(SOURCE_KINDS).optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
    cursor: z.string().optional(),
  })
  .strict();

const TriageInput = z
  .object({
    triage_classification: z.enum(TRIAGE_CLASSIFICATIONS),
    // We can only triage to triaged (assigning a classification) or
    // dismissed (no_action_needed shortcut). Other statuses are reached
    // via review / generate-pr.
    status_after: z.enum(['triaged', 'dismissed']),
    notes: z.string().max(1000).optional(),
  })
  .strict();

const ReviewInput = z
  .object({
    disposition: z.enum(REVIEW_DISPOSITIONS),
    notes: z.string().max(1000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Row shapes + API mapping.
// ---------------------------------------------------------------------------

interface SuggestionRow {
  id: string;
  tenant_id: string;
  flagged_by_user_id: string;
  flagged_at: Date | string;
  source_kind: (typeof SOURCE_KINDS)[number];
  source_payload: unknown;
  affected_prompt_module: string | null;
  affected_section_kind: string | null;
  issue_summary: string;
  status: (typeof STATUSES)[number];
  triage_classification: (typeof TRIAGE_CLASSIFICATIONS)[number] | null;
  resolved_at: Date | string | null;
  first_recorded_at: Date | string;
}

interface ReviewRow {
  id: string;
  tenant_id: string;
  suggestion_id: string;
  reviewer_user_id: string;
  reviewed_at: Date | string;
  disposition: (typeof REVIEW_DISPOSITIONS)[number];
  notes: string | null;
}

interface PrRow {
  id: string;
  tenant_id: string;
  suggestion_id: string;
  github_pr_number: number;
  github_pr_url: string;
  branch_name: string;
  changed_files: unknown;
  created_at: Date | string;
  merged_at: Date | string | null;
  merge_commit_sha: string | null;
}

const isoOf = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === 'string' ? v : v.toISOString();
const isoOfNonNull = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());

const toSuggestionApi = (r: SuggestionRow): Record<string, unknown> => ({
  id: r.id,
  tenant_id: r.tenant_id,
  flagged_by_user_id: r.flagged_by_user_id,
  flagged_at: isoOfNonNull(r.flagged_at),
  source_kind: r.source_kind,
  source_payload: r.source_payload,
  affected_prompt_module: r.affected_prompt_module,
  affected_section_kind: r.affected_section_kind,
  issue_summary: r.issue_summary,
  status: r.status,
  triage_classification: r.triage_classification,
  resolved_at: isoOf(r.resolved_at),
  first_recorded_at: isoOfNonNull(r.first_recorded_at),
});

const toReviewApi = (r: ReviewRow): Record<string, unknown> => ({
  id: r.id,
  tenant_id: r.tenant_id,
  suggestion_id: r.suggestion_id,
  reviewer_user_id: r.reviewer_user_id,
  reviewed_at: isoOfNonNull(r.reviewed_at),
  disposition: r.disposition,
  notes: r.notes,
});

const toPrApi = (r: PrRow): Record<string, unknown> => ({
  id: r.id,
  tenant_id: r.tenant_id,
  suggestion_id: r.suggestion_id,
  github_pr_number: r.github_pr_number,
  github_pr_url: r.github_pr_url,
  branch_name: r.branch_name,
  changed_files: r.changed_files,
  created_at: isoOfNonNull(r.created_at),
  merged_at: isoOf(r.merged_at),
  merge_commit_sha: r.merge_commit_sha,
});

// ---------------------------------------------------------------------------
// Cursor — opaque base64url JSON of (flagged_at iso, id). Sort is
// (flagged_at DESC, id DESC); the cursor predicate uses lexicographic
// "less-than" to walk forward through the descending list.
// ---------------------------------------------------------------------------

interface CursorTuple {
  flagged_at: string;
  id: string;
}

function encodeCursor(t: CursorTuple): string {
  return Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
}

function decodeCursor(s: string): CursorTuple | null {
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<CursorTuple>;
    if (typeof parsed.flagged_at !== 'string' || typeof parsed.id !== 'string') return null;
    // Validate the iso string parses; otherwise the SQL bind would
    // throw an opaque "invalid input syntax for type timestamp" error.
    const ms = Date.parse(parsed.flagged_at);
    if (Number.isNaN(ms)) return null;
    return { flagged_at: parsed.flagged_at, id: parsed.id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

export function registerPromptSuggestions(app: FastifyInstance): void {
  // -------------------------------------------------------------------
  // POST /v1/suggestions — flag a new suggestion (any authenticated role)
  // -------------------------------------------------------------------
  app.post('/v1/suggestions', { preHandler: requireSession }, async (req, reply) => {
    const parsed = FlagSuggestionInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        requestId: req.id,
      });
    }

    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;
    const id = crypto.randomUUID();
    const body = parsed.data;

    const inserted = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const rows = await tx<SuggestionRow[]>`
        INSERT INTO prompt_suggestion (
          tenant_id, id, flagged_by_user_id, source_kind, source_payload,
          affected_prompt_module, affected_section_kind, issue_summary, status
        )
        VALUES (
          ${tenantId}, ${id}, ${userId}, ${body.source_kind},
          ${JSON.stringify(body.source_payload)}::text::jsonb,
          ${body.affected_prompt_module ?? null},
          ${body.affected_section_kind ?? null},
          ${body.issue_summary},
          'open'
        )
        RETURNING id, tenant_id, flagged_by_user_id, flagged_at, source_kind,
                  source_payload, affected_prompt_module, affected_section_kind,
                  issue_summary, status, triage_classification, resolved_at,
                  first_recorded_at
      `;
      const row = rows[0];
      if (!row) throw new Error('POST /v1/suggestions: INSERT returned no row');
      return row;
    });

    return reply.status(201).send({ suggestion: toSuggestionApi(inserted) });
  });

  // -------------------------------------------------------------------
  // GET /v1/suggestions — list with filters + cursor pagination
  // -------------------------------------------------------------------
  app.get('/v1/suggestions', { preHandler: requireSession }, async (req, reply) => {
    const parsed = ListSuggestionsQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        requestId: req.id,
      });
    }
    const { status, source_kind, limit, cursor } = parsed.data;
    const tenantId = req.user!.tenantId!;

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      return reply.status(400).send({
        error: 'invalid_cursor',
        message: 'cursor is malformed',
        requestId: req.id,
      });
    }

    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      const fetchN = limit + 1;
      // Cursor predicate: walking newest-first, so "next page" =
      // strictly older than the cursor (or same flagged_at, smaller id).
      const cursorClause = decoded
        ? tx`AND (flagged_at < ${decoded.flagged_at}::timestamptz
                  OR (flagged_at = ${decoded.flagged_at}::timestamptz AND id < ${decoded.id}::uuid))`
        : tx``;
      const statusClause = status === undefined ? tx`` : tx`AND status = ${status}`;
      const sourceKindClause =
        source_kind === undefined ? tx`` : tx`AND source_kind = ${source_kind}`;

      const rows = await tx<SuggestionRow[]>`
        SELECT id, tenant_id, flagged_by_user_id, flagged_at, source_kind,
               source_payload, affected_prompt_module, affected_section_kind,
               issue_summary, status, triage_classification, resolved_at,
               first_recorded_at
          FROM prompt_suggestion
         WHERE tenant_id = ${tenantId}
           ${cursorClause}
           ${statusClause}
           ${sourceKindClause}
         ORDER BY flagged_at DESC, id DESC
         LIMIT ${fetchN}
      `;

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              flagged_at: isoOfNonNull(last.flagged_at),
              id: last.id,
            })
          : null;

      return { suggestions: page.map(toSuggestionApi), next_cursor: nextCursor };
    });
  });

  // -------------------------------------------------------------------
  // GET /v1/suggestions/:id — detail with nested reviews + pr
  // -------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/suggestions/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      if (!Uuid.safeParse(id).success) {
        return reply.status(400).send({
          error: 'invalid_id',
          message: 'id must be a uuid',
          requestId: req.id,
        });
      }
      const tenantId = req.user!.tenantId!;

      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const suggestionRows = await tx<SuggestionRow[]>`
          SELECT id, tenant_id, flagged_by_user_id, flagged_at, source_kind,
                 source_payload, affected_prompt_module, affected_section_kind,
                 issue_summary, status, triage_classification, resolved_at,
                 first_recorded_at
            FROM prompt_suggestion
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        const suggestion = suggestionRows[0];
        if (!suggestion) {
          return reply.status(404).send({
            error: 'suggestion_not_found',
            message: 'No suggestion with that id in this firm',
            requestId: req.id,
          });
        }

        const reviewRows = await tx<ReviewRow[]>`
          SELECT id, tenant_id, suggestion_id, reviewer_user_id, reviewed_at,
                 disposition, notes
            FROM prompt_suggestion_review
           WHERE suggestion_id = ${id} AND tenant_id = ${tenantId}
           ORDER BY reviewed_at ASC, id ASC
        `;

        // Most-recent PR row (suggestions can have multiple PR attempts).
        const prRows = await tx<PrRow[]>`
          SELECT id, tenant_id, suggestion_id, github_pr_number, github_pr_url,
                 branch_name, changed_files, created_at, merged_at, merge_commit_sha
            FROM prompt_suggestion_pr
           WHERE suggestion_id = ${id} AND tenant_id = ${tenantId}
           ORDER BY created_at DESC, id DESC
           LIMIT 1
        `;

        return {
          suggestion: toSuggestionApi(suggestion),
          reviews: reviewRows.map(toReviewApi),
          pr: prRows[0] ? toPrApi(prRows[0]) : null,
        };
      });
    },
  );

  // -------------------------------------------------------------------
  // POST /v1/suggestions/:id/triage — set triage_classification + status
  // -------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/suggestions/:id/triage',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      // Triage is an admin/consultant action — viewers cannot triage.
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }

      const { id } = req.params;
      if (!Uuid.safeParse(id).success) {
        return reply.status(400).send({
          error: 'invalid_id',
          message: 'id must be a uuid',
          requestId: req.id,
        });
      }
      const parsed = TriageInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: parsed.error.issues.map((i) => i.message).join('; '),
          requestId: req.id,
        });
      }
      const body = parsed.data;
      const tenantId = req.user!.tenantId!;

      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        const existingRows = await tx<{ status: SuggestionRow['status'] }[]>`
          SELECT status
            FROM prompt_suggestion
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        const existing = existingRows[0];
        if (!existing) {
          return reply.status(404).send({
            error: 'suggestion_not_found',
            message: 'No suggestion with that id in this firm',
            requestId: req.id,
          });
        }
        if (existing.status !== 'open') {
          return reply.status(409).send({
            error: 'invalid_state_transition',
            message: `cannot triage from status=${existing.status}; only 'open' suggestions can be triaged`,
            requestId: req.id,
          });
        }

        // resolved_at is set ONLY when status flips to a terminal state
        // (here, 'dismissed'). 'triaged' is mid-flight.
        const resolveNow = body.status_after === 'dismissed';

        // Race-safe UPDATE: include `status = 'open'` in the WHERE so that
        // two consultants triaging the same suggestion concurrently can't
        // both pass the SELECT-status guard above and both win the UPDATE.
        // Under READ COMMITTED, the second writer's WHERE will see the
        // first's committed status flip and return zero rows. We then
        // surface 409 (conflict) rather than 404 — the row exists, but
        // someone else already moved it out of `open`.
        const updatedRows = await tx<SuggestionRow[]>`
          UPDATE prompt_suggestion
             SET triage_classification = ${body.triage_classification},
                 status = ${body.status_after},
                 resolved_at = CASE WHEN ${resolveNow} THEN NOW() ELSE resolved_at END
           WHERE id = ${id}
             AND tenant_id = ${tenantId}
             AND status = 'open'
          RETURNING id, tenant_id, flagged_by_user_id, flagged_at, source_kind,
                    source_payload, affected_prompt_module, affected_section_kind,
                    issue_summary, status, triage_classification, resolved_at,
                    first_recorded_at
        `;
        const row = updatedRows[0];
        if (!row) {
          // Lost the race: another transaction committed a triage between
          // our SELECT-status guard and this UPDATE.
          return reply.status(409).send({
            error: 'invalid_state_transition',
            message: 'suggestion is no longer in open state',
            requestId: req.id,
          });
        }
        // TODO(p7-theme-b-followup): `notes` on the triage input is
        // currently silently dropped — the prompt_suggestion table has
        // no triage_notes column. Code-quality review on B.3 flagged
        // this as Important #2. Resolution options for a follow-up
        // ticket: (a) add a `triage_notes text` column to
        // prompt_suggestion, or (b) write notes to a separate
        // prompt_suggestion_triage table keyed on (id, status_change_at).
        // For now the wire shape accepts notes (so the admin UI keeps
        // working) but they are only logged at debug for observability;
        // they do NOT persist past this request.
        if (body.notes !== undefined) {
          req.log.debug(
            { id, notesLength: body.notes.length },
            'triage notes accepted but not persisted',
          );
        }
        return { suggestion: toSuggestionApi(row) };
      });
    },
  );

  // -------------------------------------------------------------------
  // POST /v1/suggestions/:id/review — append a review row
  // -------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/suggestions/:id/review',
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

      const { id } = req.params;
      if (!Uuid.safeParse(id).success) {
        return reply.status(400).send({
          error: 'invalid_id',
          message: 'id must be a uuid',
          requestId: req.id,
        });
      }
      const parsed = ReviewInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: parsed.error.issues.map((i) => i.message).join('; '),
          requestId: req.id,
        });
      }
      const body = parsed.data;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;
      const reviewId = crypto.randomUUID();

      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        const existingRows = await tx<{ status: SuggestionRow['status'] }[]>`
          SELECT status
            FROM prompt_suggestion
           WHERE id = ${id} AND tenant_id = ${tenantId}
        `;
        const existing = existingRows[0];
        if (!existing) {
          return reply.status(404).send({
            error: 'suggestion_not_found',
            message: 'No suggestion with that id in this firm',
            requestId: req.id,
          });
        }
        if (existing.status !== 'triaged') {
          return reply.status(409).send({
            error: 'invalid_state_transition',
            message: `cannot review from status=${existing.status}; only 'triaged' suggestions can be reviewed`,
            requestId: req.id,
          });
        }

        const reviewRows = await tx<ReviewRow[]>`
          INSERT INTO prompt_suggestion_review (
            tenant_id, id, suggestion_id, reviewer_user_id, disposition, notes
          )
          VALUES (
            ${tenantId}, ${reviewId}, ${id}, ${userId},
            ${body.disposition}, ${body.notes ?? null}
          )
          RETURNING id, tenant_id, suggestion_id, reviewer_user_id, reviewed_at,
                    disposition, notes
        `;
        const review = reviewRows[0];
        if (!review) throw new Error('POST review: INSERT returned no row');

        // Side effect on dismiss: flip the parent suggestion's status to
        // dismissed + populate resolved_at. Other dispositions leave the
        // status as 'triaged' (the next event is generate-pr for
        // approve_for_pr; request_more_info / escalate_to_code_change
        // leave the suggestion in the queue for follow-up).
        //
        // Race-safety: include `status = 'triaged'` in the WHERE so we
        // don't silently clobber a parallel B.5 `pr_drafted` flip that
        // committed between our SELECT-status guard and this UPDATE. If
        // zero rows update we log it but do NOT fail the request — the
        // review row is already inserted; the dismiss side-effect has
        // simply lost the race to another writer that already moved the
        // suggestion past `triaged`.
        if (body.disposition === 'dismiss') {
          const dismissed = await tx`
            UPDATE prompt_suggestion
               SET status = 'dismissed',
                   resolved_at = NOW()
             WHERE id = ${id}
               AND tenant_id = ${tenantId}
               AND status = 'triaged'
            RETURNING id
          `;
          if (dismissed.length === 0) {
            req.log.warn(
              { id, tenantId },
              'dismiss-side-effect UPDATE affected 0 rows; concurrent writer moved suggestion past triaged. review row still inserted.',
            );
          }
        }

        return reply.status(200).send({ review: toReviewApi(review) });
      });
    },
  );

  // -------------------------------------------------------------------
  // POST /v1/suggestions/:id/generate-pr — STUB
  //
  // Per Task B.3 spec: this endpoint MUST return 501 NotImplemented.
  // The full choreography (GitHub branch creation, prompt diff, PR open,
  // status flip to pr_drafted, prompt_suggestion_pr row insert) lands in
  // Task B.5. The placeholder exists today so:
  //
  //   1. The Task B.7 admin-UI work can wire up the button without a 404
  //      breaking the flow before B.5 lands.
  //   2. Auth + path-validation gating is exercised end-to-end now,
  //      meaning B.5 only has to fill in the body — the surface area is
  //      reviewed.
  //
  // We DELIBERATELY do NOT consult the database here: no row lookup, no
  // state-machine check, no review-disposition gate. Those are part of
  // B.5's contract; doing any of it now would either (a) duplicate work
  // B.5 will redo with the right semantics, or (b) leak partial state
  // (e.g. an optimistic status flip with no PR to back it). The spec is
  // explicit: "Do NOT call into Task B.5's choreography (it doesn't exist
  // yet)."
  //
  // Auth IS gated here (requireSession + admin/consultant role) so the
  // 501 surface doesn't double as a tenant-existence oracle for
  // unauthenticated callers, and a uuid-shape check fires before the 501
  // so a malformed path returns the same 400 the other endpoints would.
  // -------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/suggestions/:id/generate-pr',
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

      const { id } = req.params;
      if (!Uuid.safeParse(id).success) {
        return reply.status(400).send({
          error: 'invalid_id',
          message: 'id must be a uuid',
          requestId: req.id,
        });
      }

      return reply.status(501).send({
        message: 'PR generation lands in Task B.5; this endpoint is a placeholder.',
      });
    },
  );
}

// ─── Internal exports for testing ─────────────────────────────────────
// Schemas are re-exported so the test file can validate input parity
// (and so consumers in P7 Task B.4 can re-use the shapes if they ever
// need them — the Zod-in-API pattern matches mapping-rules).
export const _internals = {
  FlagSuggestionInput,
  ListSuggestionsQuery,
  TriageInput,
  ReviewInput,
  encodeCursor,
  decodeCursor,
  SOURCE_KINDS,
  STATUSES,
  TRIAGE_CLASSIFICATIONS,
  REVIEW_DISPOSITIONS,
};
