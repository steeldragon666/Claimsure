import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import {
  computeIdempotencyKey,
  lookupCache,
  makeClassifier,
  withAgentSpan,
  writeCache,
  type Classifier,
  type ClassifierOutput,
} from '@cpa/agents';
import { insertEventWithChain } from '@cpa/db';
import { sql } from '@cpa/db/client';
import {
  createEventBody,
  listEventsQuery,
  overrideEventBody,
  type Classification,
  type Event as ApiEvent,
} from '@cpa/schemas';

// Lazy classifier singleton — first request constructs it, subsequent
// requests reuse. Lazy (not module-init) so the test runner can set
// CLASSIFIER_IMPL=stub between import time and first injected request, and
// so a misconfigured ANTHROPIC_API_KEY surfaces as a per-request 503 rather
// than a process-wide boot failure.
let classifierInstance: Classifier | null = null;
const getClassifier = (): Classifier => {
  if (!classifierInstance) classifierInstance = makeClassifier();
  return classifierInstance;
};

interface RawEventViewRow {
  id: string;
  tenant_id: string;
  subject_tenant_id: string;
  project_id: string | null;
  milestone_id: string | null;
  kind: string;
  effective_kind: string;
  is_overridden: boolean;
  payload: unknown;
  classification: unknown;
  override_of_event_id: string | null;
  override_new_kind: string | null;
  override_reason: string | null;
  prev_hash: string | null;
  hash: string;
  idempotency_key: string | null;
  captured_at: Date | string;
  captured_by_user_id: string;
  received_at: Date | string;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());

const rowToEvent = (r: RawEventViewRow): ApiEvent => ({
  id: r.id,
  tenant_id: r.tenant_id,
  subject_tenant_id: r.subject_tenant_id,
  project_id: r.project_id,
  milestone_id: r.milestone_id,
  // The DB CHECK constraints already restrict kind/effective_kind to the
  // EVIDENCE_KINDS set (migration 0006 + 0007 view). Coerce for the type
  // contract; runtime validation isn't useful since we're reading back rows
  // we just wrote.
  kind: r.kind as ApiEvent['kind'],
  effective_kind: r.effective_kind as ApiEvent['effective_kind'],
  is_overridden: r.is_overridden,
  payload: r.payload,
  classification: r.classification as Classification | null,
  override_of_event_id: r.override_of_event_id,
  override_new_kind: r.override_new_kind as ApiEvent['override_new_kind'],
  override_reason: r.override_reason,
  prev_hash: r.prev_hash,
  hash: r.hash,
  idempotency_key: r.idempotency_key,
  captured_at: isoOf(r.captured_at),
  captured_by_user_id: r.captured_by_user_id,
  received_at: isoOf(r.received_at),
});

const isAnthropicExhausted = (e: unknown): boolean => {
  // Anthropic SDK errors carry a .status (HTTP code). 529 = Overloaded;
  // anything 5xx from the upstream model is "exhausted" from our POV.
  const status = (e as { status?: number }).status;
  return typeof status === 'number' && status >= 500;
};

/**
 * Register the event-capture routes (POST/GET/override).
 *
 * Auth: every route requires a session (requireSession). Per-claimant ACL
 * checks are deferred to RLS — the subject_tenant table's policy filters
 * cross-firm rows automatically.
 */
export function registerEvents(app: FastifyInstance): void {
  app.post('/v1/events', { preHandler: requireSession }, async (req, reply) => {
    const parsed = createEventBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: 'Body must be { subject_tenant_id, raw_text, captured_at? }',
        requestId: req.id,
      });
    }
    const { subject_tenant_id, raw_text, captured_at } = parsed.data;
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;
    const capturedAt = captured_at ? new Date(captured_at) : new Date();

    // Step 1: confirm the subject_tenant is visible (and live) under RLS.
    // 404 covers both "doesn't exist" and "exists in another firm".
    const subjectVisible = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM subject_tenant
         WHERE id = ${subject_tenant_id} AND deleted_at IS NULL
      `;
      return rows[0] != null;
    });
    if (!subjectVisible) {
      return reply.status(404).send({
        error: 'subject_tenant_not_found',
        message: 'No subject_tenant with that id in this firm',
        requestId: req.id,
      });
    }

    // Step 2: classify with idempotency cache. Key = SHA256(prompt_version
    // || NUL || raw_text). The cache is content-addressed across tenants
    // (same paste in two firms legitimately gets the same answer).
    //
    // We bind the prompt version statically here so a deploy that bumps
    // the prompt invalidates older cache entries — the wire format
    // (computeIdempotencyKey input) folds prompt_version into the key, so
    // this is automatic.
    const PROMPT_KEY = 'classify@1.0.0';
    const idempotencyKey = computeIdempotencyKey(PROMPT_KEY, raw_text);

    let classification: ClassifierOutput;
    try {
      classification = await withAgentSpan(
        'classify',
        {
          agent_name: 'classifier',
          prompt_version: PROMPT_KEY,
          model: process.env['CLASSIFIER_MODEL'] ?? 'haiku',
          tenant_id: tenantId,
          subject_tenant_id,
        },
        async (setAttr) => {
          const cached = await lookupCache(idempotencyKey);
          if (cached) {
            setAttr({ cache_hit: true });
            // Cached output shape matches ClassifierOutput by construction
            // (writeCache below stores the same object).
            return cached.output as ClassifierOutput;
          }
          setAttr({ cache_hit: false });
          const out = await getClassifier().classify({ raw_text });
          setAttr({
            tokens_in: out.tokens_in,
            tokens_out: out.tokens_out,
            classification_kind: out.kind,
            classification_confidence: out.confidence,
          });
          // ON CONFLICT DO NOTHING — first write wins; concurrent identical
          // requests don't clobber each other (idempotency contract).
          await writeCache({
            idempotency_key: idempotencyKey,
            agent_name: 'classifier',
            prompt_version: out.prompt_version,
            output: out,
            tokens_in: out.tokens_in,
            tokens_out: out.tokens_out,
            model: out.model,
          });
          return out;
        },
      );
    } catch (e) {
      if (isAnthropicExhausted(e)) {
        req.log.warn({ err: e }, 'classifier upstream exhausted');
        return reply.status(503).send({
          error: 'classifier_unavailable',
          message: 'Classifier upstream is unavailable; retry shortly',
          requestId: req.id,
        });
      }
      throw e;
    }

    // Step 3: extend the chain. The chain helper holds a per-subject
    // advisory lock so concurrent inserts on the same chain serialise.
    const inserted = await insertEventWithChain({
      tenant_id: tenantId,
      subject_tenant_id,
      // Chain canonicalisation includes `kind` — set to the classifier's
      // kind so the hash captures the classification at insert time.
      kind: classification.kind,
      payload: { _v: 1, source: 'paste', raw_text },
      classification,
      captured_at: capturedAt,
      captured_by_user_id: userId,
      override_of_event_id: null,
      override_new_kind: null,
      override_reason: null,
      idempotency_key: idempotencyKey,
    });

    // Step 4: read back via the view so effective_kind / is_overridden are
    // populated. RLS-scoped — same tenantId GUC.
    const fresh = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const rows = await tx<RawEventViewRow[]>`
        SELECT * FROM event_with_effective_kind WHERE id = ${inserted.id}
      `;
      return rows[0];
    });
    if (!fresh) {
      // Should be unreachable — we just inserted under the same tenant.
      throw new Error('POST /v1/events: inserted row not visible via view');
    }

    return reply.status(201).send({ event: rowToEvent(fresh) });
  });

  app.get('/v1/events', { preHandler: requireSession }, async (req, reply) => {
    const parsed = listEventsQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: 'Query must include subject_tenant_id; optional filter, limit (1..200), cursor',
        requestId: req.id,
      });
    }
    const { subject_tenant_id, filter, limit, cursor } = parsed.data;
    const tenantId = req.user!.tenantId!;

    // Decode the opaque cursor. Forward-pagination only (older first → next).
    // The cursor encodes the tuple (captured_at, received_at, id) of the
    // last row on the previous page; the next page is "rows strictly less
    // than this tuple" since we sort DESC.
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

      // Use the view so effective_kind / is_overridden are pre-computed.
      // RLS on the underlying `event` table still applies through the view.
      // We over-fetch by 1 to know whether a next page exists.
      const fetchN = limit + 1;

      // Cursor predicate: lexicographic (captured_at, received_at, id) DESC.
      // Postgres doesn't have a "row-tuple <" comparison that works cleanly
      // with timestamps + uuid + nullable order columns, so we expand it.
      // Explicit ::timestamptz casts on the cursor strings — same rationale
      // as chain.ts insertEventWithChain (postgres-js + Node 22 doesn't
      // round-trip Dates cleanly on the bind path).
      const cursorClause = decoded
        ? tx`AND (
            captured_at < ${decoded.captured_at}::timestamptz
            OR (captured_at = ${decoded.captured_at}::timestamptz AND received_at < ${decoded.received_at}::timestamptz)
            OR (
              captured_at = ${decoded.captured_at}::timestamptz
              AND received_at = ${decoded.received_at}::timestamptz
              AND id < ${decoded.id}::uuid
            )
          )`
        : tx``;

      const filterClause =
        filter === 'needs_review'
          ? tx`AND effective_kind <> 'OVERRIDE'
                AND classification IS NOT NULL
                AND (classification->>'confidence')::float < 0.7
                AND NOT is_overridden`
          : filter === 'ineligible'
            ? tx`AND effective_kind = 'INELIGIBLE'`
            : filter === 'overrides'
              ? tx`AND kind = 'OVERRIDE'`
              : tx``;

      const rows = await tx<RawEventViewRow[]>`
        SELECT * FROM event_with_effective_kind
         WHERE subject_tenant_id = ${subject_tenant_id}
           ${cursorClause}
           ${filterClause}
         ORDER BY captured_at DESC, received_at DESC, id DESC
         LIMIT ${fetchN}
      `;

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              captured_at:
                typeof last.captured_at === 'string'
                  ? last.captured_at
                  : last.captured_at.toISOString(),
              received_at:
                typeof last.received_at === 'string'
                  ? last.received_at
                  : last.received_at.toISOString(),
              id: last.id,
            })
          : null;

      return { events: page.map(rowToEvent), next_cursor: nextCursor };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/v1/events/:id/override',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = overrideEventBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: 'Body must be { new_kind: ClassifiableKind, reason: string }',
          requestId: req.id,
        });
      }
      const { new_kind, reason } = parsed.data;
      const tenantId = req.user!.tenantId!;
      const userId = req.user!.id;

      // Step 1: load the original under RLS. 404 covers missing + cross-firm.
      const original = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string; kind: string; subject_tenant_id: string }[]>`
          SELECT id, kind, subject_tenant_id FROM event WHERE id = ${id}
        `;
        return rows[0] ?? null;
      });
      if (!original) {
        return reply.status(404).send({
          error: 'event_not_found',
          message: 'No event with that id in this firm',
          requestId: req.id,
        });
      }

      // Step 2: reject override-of-override. The DB CHECK on event would
      // ALSO reject this (override_invariants requires override_of_event_id
      // to point at a non-OVERRIDE row by convention), but we surface a
      // clean 400 with a domain message rather than a generic 500.
      if (original.kind === 'OVERRIDE') {
        return reply.status(400).send({
          error: 'override_of_override',
          message: 'Cannot override an OVERRIDE event; override the original instead',
          requestId: req.id,
        });
      }

      // Step 3: append a new OVERRIDE event to the chain. The chain helper's
      // canonicalisation includes override_of_event_id / override_new_kind /
      // override_reason so the OVERRIDE row's hash captures the reviewer's
      // decision. idempotency_key=null because OVERRIDE events aren't
      // content-addressed (every override is a deliberate distinct action).
      const inserted = await insertEventWithChain({
        tenant_id: tenantId,
        subject_tenant_id: original.subject_tenant_id,
        kind: 'OVERRIDE',
        payload: { _v: 1, source: 'override', original_event_id: original.id },
        classification: null,
        captured_at: new Date(),
        captured_by_user_id: userId,
        override_of_event_id: original.id,
        override_new_kind: new_kind,
        override_reason: reason,
        idempotency_key: null,
      });

      // Step 4: read back via the view (effective_kind / is_overridden).
      const fresh = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawEventViewRow[]>`
          SELECT * FROM event_with_effective_kind WHERE id = ${inserted.id}
        `;
        return rows[0];
      });
      if (!fresh) {
        throw new Error('POST /v1/events/:id/override: inserted row not visible via view');
      }

      return reply.status(201).send({ override_event: rowToEvent(fresh) });
    },
  );
}

interface CursorTuple {
  captured_at: string;
  received_at: string;
  id: string;
}

/**
 * Encode a cursor tuple as opaque base64 JSON. Clients shouldn't introspect
 * — the format is internal and can change without bumping the API contract
 * since cursors are returned by us and passed back as-is.
 */
function encodeCursor(t: CursorTuple): string {
  return Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor. Returns null on any parse error so the route can
 * surface a 400; never throws (untrusted input). Validates the three field
 * shapes minimally so a corrupted cursor doesn't slip into the WHERE clause.
 */
function decodeCursor(s: string): CursorTuple | null {
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<CursorTuple>;
    if (
      typeof parsed.captured_at !== 'string' ||
      typeof parsed.received_at !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      return null;
    }
    return {
      captured_at: parsed.captured_at,
      received_at: parsed.received_at,
      id: parsed.id,
    };
  } catch {
    return null;
  }
}
