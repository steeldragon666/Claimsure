import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';

/**
 * P7 Theme D Section 4.5.7 — Compliance API routes.
 *
 * Eight endpoints under `/v1/compliance/...`:
 *
 *   POST   /v1/compliance/beneficial-ownership
 *   GET    /v1/compliance/beneficial-ownership/:subject_tenant_id/:fy
 *   POST   /v1/compliance/knowledge-search
 *   GET    /v1/compliance/knowledge-search/:subject_tenant_id/:fy
 *   POST   /v1/compliance/facilities
 *   GET    /v1/compliance/facilities/:subject_tenant_id/:fy
 *   POST   /v1/compliance/forecast
 *   GET    /v1/compliance/forecast/:subject_tenant_id/:fy
 *   POST   /v1/compliance/multi-entity-scan
 *   GET    /v1/compliance/form-completeness/:subject_tenant_id/:fy
 *   GET    /v1/compliance/at-risk-summary/:subject_tenant_id/:fy
 *
 * Auth + RLS:
 *   - All routes require a session (`requireSession`).
 *   - Tenant isolation is via the `app.current_tenant_id` GUC set inside
 *     each `sql.begin` for defence-in-depth (connection pool reuse can
 *     leave the GUC unset on next checkout).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ATO General Interest Charge rate (FY24-25 placeholder: 11.22% p.a.) */
const ATO_GIC_RATE = 0.1122;

/**
 * Narrative character-count thresholds per 15 Aug 2025 form spec.
 *
 * Keys MUST match `NARRATIVE_SECTION_KINDS` (`@cpa/db/schema/narrative_draft`)
 * exactly — those are the only values the narrative_draft.section_kind CHECK
 * constraint admits. The fixture
 * `tests/fixtures/r-and-d-form-2025-08-15-schema.json` mirrors this set; the
 * D.7 contract test asserts byte-for-byte parity (fixture ↔ this constant).
 */
const NARRATIVE_THRESHOLDS: Record<string, { min: number; max: number }> = {
  new_knowledge: { min: 100, max: 2000 },
  hypothesis: { min: 200, max: 3000 },
  uncertainty: { min: 100, max: 2000 },
  experiments_and_results: { min: 200, max: 5000 },
};

// ---------------------------------------------------------------------------
// Zod schemas — input contracts
// ---------------------------------------------------------------------------

// Mirrors the `beneficial_ownership_owner_kind_valid` CHECK constraint in
// migration 0039 and `BENEFICIAL_OWNERSHIP_OWNER_KINDS` in
// `@cpa/db/schema/beneficial_ownership`. Three-way parity is enforced by
// `tools/scripts/check-three-way-parity.test.ts`.
const OWNER_KINDS = ['individual', 'entity', 'foreign_entity', 'associate'] as const;

const BeneficialOwnershipInput = z
  .object({
    subject_tenant_id: z.string().uuid(),
    fy_label: z.string().min(1).max(20),
    owner_kind: z.enum(OWNER_KINDS),
    owner_name: z.string().min(1).max(500),
    owner_country: z.string().max(100).optional(),
    ownership_pct: z.number().min(0).max(100),
    is_associate: z.boolean(),
    is_foreign_related: z.boolean(),
  })
  .strict();

const KnowledgeSearchInput = z
  .object({
    subject_tenant_id: z.string().uuid(),
    activity_id: z.string().uuid(),
    search_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO date (YYYY-MM-DD)'),
    search_query: z.string().min(1).max(2000),
    sources_consulted: z.array(z.string().min(1).max(500)),
    finding_summary: z.string().min(1).max(10000),
  })
  .strict();

const FacilityInput = z
  .object({
    subject_tenant_id: z.string().uuid(),
    fy_label: z.string().min(1).max(20),
    facility_name: z.string().min(1).max(500),
    address: z.string().min(1).max(1000),
    is_owned: z.boolean(),
    used_for_activity_ids: z.array(z.string().uuid()),
  })
  .strict();

const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
const FORECAST_OFFSETS = [1, 2, 3] as const;

const ForecastInput = z
  .object({
    subject_tenant_id: z.string().uuid(),
    base_fy_label: z.string().min(1).max(20),
    forecast_year_offset: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    projected_spend_aud: z.number().min(0),
    projected_headcount: z.number().int().min(0),
    confidence: z.enum(CONFIDENCE_LEVELS),
  })
  .strict();

const MultiEntityScanInput = z
  .object({
    subject_tenant_id: z.string().uuid(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerCompliance(app: FastifyInstance): void {
  // -------------------------------------------------------------------
  // 1. POST /v1/compliance/beneficial-ownership
  // -------------------------------------------------------------------
  app.post(
    '/v1/compliance/beneficial-ownership',
    { preHandler: requireSession },
    async (req, reply) => {
      const parsed = BeneficialOwnershipInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: parsed.error.issues.map((i) => i.message).join('; '),
          requestId: req.id,
        });
      }

      const tenantId = req.user!.tenantId!;
      const body = parsed.data;
      const id = crypto.randomUUID();

      const inserted = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx`
        INSERT INTO beneficial_ownership (
          id, tenant_id, subject_tenant_id, fy_label, owner_kind,
          owner_name, owner_country, ownership_pct, is_associate, is_foreign_related
        )
        VALUES (
          ${id}, ${tenantId}, ${body.subject_tenant_id}, ${body.fy_label},
          ${body.owner_kind}, ${body.owner_name}, ${body.owner_country ?? null},
          ${body.ownership_pct}, ${body.is_associate}, ${body.is_foreign_related}
        )
        RETURNING *
      `;
        return rows[0];
      });

      if (!inserted) {
        return reply.status(500).send({ error: 'insert_failed', requestId: req.id });
      }

      return reply.status(201).send(inserted);
    },
  );

  // -------------------------------------------------------------------
  // 2. GET /v1/compliance/beneficial-ownership/:subject_tenant_id/:fy
  // -------------------------------------------------------------------
  app.get<{ Params: { subject_tenant_id: string; fy: string } }>(
    '/v1/compliance/beneficial-ownership/:subject_tenant_id/:fy',
    { preHandler: requireSession },
    async (req, reply) => {
      const { subject_tenant_id, fy } = req.params;
      if (!z.string().uuid().safeParse(subject_tenant_id).success) {
        return reply.status(400).send({ error: 'invalid subject_tenant_id', requestId: req.id });
      }

      const tenantId = req.user!.tenantId!;

      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        // Migration 0039 only adds (first_recorded_at, created_at) — there
        // is no `updated_at` on beneficial_ownership.
        return await tx`
          SELECT id, tenant_id, subject_tenant_id, fy_label, owner_kind,
                 owner_name, owner_country, ownership_pct, is_associate,
                 is_foreign_related, ta_2023_4_flag, ta_2023_5_flag,
                 first_recorded_at, created_at
            FROM beneficial_ownership
           WHERE subject_tenant_id = ${subject_tenant_id}
             AND fy_label = ${fy}
             AND tenant_id = ${tenantId}
           ORDER BY created_at ASC
        `;
      });

      return { rows };
    },
  );

  // -------------------------------------------------------------------
  // 3. POST /v1/compliance/knowledge-search
  // -------------------------------------------------------------------
  app.post(
    '/v1/compliance/knowledge-search',
    { preHandler: requireSession },
    async (req, reply) => {
      const parsed = KnowledgeSearchInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: parsed.error.issues.map((i) => i.message).join('; '),
          requestId: req.id,
        });
      }

      const tenantId = req.user!.tenantId!;
      const body = parsed.data;
      const id = crypto.randomUUID();

      const inserted = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx`
        INSERT INTO knowledge_search_record (
          id, tenant_id, subject_tenant_id, activity_id, search_date,
          search_query, sources_consulted, finding_summary
        )
        VALUES (
          ${id}, ${tenantId}, ${body.subject_tenant_id}, ${body.activity_id},
          ${body.search_date}::date, ${body.search_query},
          ${JSON.stringify(body.sources_consulted)}::text::jsonb,
          ${body.finding_summary}
        )
        RETURNING *
      `;
        return rows[0];
      });

      if (!inserted) {
        return reply.status(500).send({ error: 'insert_failed', requestId: req.id });
      }

      return reply.status(201).send(inserted);
    },
  );

  // -------------------------------------------------------------------
  // 3b. GET /v1/compliance/knowledge-search/:subject_tenant_id/:fy
  //     Returns all knowledge-search records for activities in the FY.
  // -------------------------------------------------------------------
  app.get<{ Params: { subject_tenant_id: string; fy: string } }>(
    '/v1/compliance/knowledge-search/:subject_tenant_id/:fy',
    { preHandler: requireSession },
    async (req, reply) => {
      const { subject_tenant_id, fy } = req.params;
      if (!z.string().uuid().safeParse(subject_tenant_id).success) {
        return reply.status(400).send({ error: 'invalid subject_tenant_id', requestId: req.id });
      }

      const tenantId = req.user!.tenantId!;

      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        // Join through activity to filter by FY — knowledge_search_record
        // has no fy_label column; the FY lives on the activity row.
        return await tx`
          SELECT ksr.id, ksr.subject_tenant_id, ksr.activity_id, ksr.search_date,
                 ksr.search_query, ksr.sources_consulted, ksr.finding_summary,
                 ksr.first_recorded_at
            FROM knowledge_search_record ksr
            JOIN activity a ON a.id = ksr.activity_id AND a.tenant_id = ksr.tenant_id
            JOIN claim c    ON c.id = a.claim_id     AND c.tenant_id = a.tenant_id
           WHERE c.subject_tenant_id = ${subject_tenant_id}
             AND a.fy_label          = ${fy}
             AND ksr.tenant_id       = ${tenantId}
           ORDER BY ksr.search_date DESC, ksr.first_recorded_at ASC
        `;
      });

      return { rows };
    },
  );

  // -------------------------------------------------------------------
  // 4. POST /v1/compliance/facilities
  // -------------------------------------------------------------------
  app.post('/v1/compliance/facilities', { preHandler: requireSession }, async (req, reply) => {
    const parsed = FacilityInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        requestId: req.id,
      });
    }

    const tenantId = req.user!.tenantId!;
    const body = parsed.data;
    const id = crypto.randomUUID();

    const inserted = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const rows = await tx`
        INSERT INTO r_and_d_facility (
          id, tenant_id, subject_tenant_id, fy_label, facility_name,
          address, is_owned, used_for_activity_ids
        )
        VALUES (
          ${id}, ${tenantId}, ${body.subject_tenant_id}, ${body.fy_label},
          ${body.facility_name}, ${body.address}, ${body.is_owned},
          ${body.used_for_activity_ids}::uuid[]
        )
        RETURNING *
      `;
      return rows[0];
    });

    if (!inserted) {
      return reply.status(500).send({ error: 'insert_failed', requestId: req.id });
    }

    return reply.status(201).send(inserted);
  });

  // -------------------------------------------------------------------
  // 4b. GET /v1/compliance/facilities/:subject_tenant_id/:fy
  //     Returns all R&D facilities for the subject and FY.
  // -------------------------------------------------------------------
  app.get<{ Params: { subject_tenant_id: string; fy: string } }>(
    '/v1/compliance/facilities/:subject_tenant_id/:fy',
    { preHandler: requireSession },
    async (req, reply) => {
      const { subject_tenant_id, fy } = req.params;
      if (!z.string().uuid().safeParse(subject_tenant_id).success) {
        return reply.status(400).send({ error: 'invalid subject_tenant_id', requestId: req.id });
      }

      const tenantId = req.user!.tenantId!;

      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return await tx`
          SELECT id, subject_tenant_id, fy_label, facility_name, address,
                 is_owned, used_for_activity_ids, first_recorded_at
            FROM r_and_d_facility
           WHERE subject_tenant_id = ${subject_tenant_id}
             AND fy_label          = ${fy}
             AND tenant_id         = ${tenantId}
           ORDER BY first_recorded_at ASC
        `;
      });

      return { rows };
    },
  );

  // -------------------------------------------------------------------
  // 5. POST /v1/compliance/forecast
  //    ON CONFLICT on the UNIQUE constraint → UPDATE
  // -------------------------------------------------------------------
  app.post('/v1/compliance/forecast', { preHandler: requireSession }, async (req, reply) => {
    const parsed = ForecastInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        requestId: req.id,
      });
    }

    const tenantId = req.user!.tenantId!;
    const body = parsed.data;
    const id = crypto.randomUUID();

    const upserted = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      // Migration 0039's UNIQUE constraint is on
      //   (subject_tenant_id, base_fy_label, forecast_year_offset)
      // — tenant_id is NOT part of the index, so the ON CONFLICT target must
      // match the constraint columns exactly. There is no `updated_at` column
      // on rd_forecast either; the row is simply rewritten in place on
      // conflict.
      const rows = await tx`
        INSERT INTO rd_forecast (
          id, tenant_id, subject_tenant_id, base_fy_label,
          forecast_year_offset, projected_spend_aud, projected_headcount, confidence
        )
        VALUES (
          ${id}, ${tenantId}, ${body.subject_tenant_id}, ${body.base_fy_label},
          ${body.forecast_year_offset}, ${body.projected_spend_aud},
          ${body.projected_headcount}, ${body.confidence}
        )
        ON CONFLICT (subject_tenant_id, base_fy_label, forecast_year_offset)
        DO UPDATE SET
          projected_spend_aud = EXCLUDED.projected_spend_aud,
          projected_headcount = EXCLUDED.projected_headcount,
          confidence = EXCLUDED.confidence
        RETURNING *
      `;
      return rows[0];
    });

    if (!upserted) {
      return reply.status(500).send({ error: 'upsert_failed', requestId: req.id });
    }

    return reply.status(201).send(upserted);
  });

  // -------------------------------------------------------------------
  // 5b. GET /v1/compliance/forecast/:subject_tenant_id/:fy
  //     Returns all forecast rows for the base FY (offsets 1–3).
  // -------------------------------------------------------------------
  app.get<{ Params: { subject_tenant_id: string; fy: string } }>(
    '/v1/compliance/forecast/:subject_tenant_id/:fy',
    { preHandler: requireSession },
    async (req, reply) => {
      const { subject_tenant_id, fy } = req.params;
      if (!z.string().uuid().safeParse(subject_tenant_id).success) {
        return reply.status(400).send({ error: 'invalid subject_tenant_id', requestId: req.id });
      }

      const tenantId = req.user!.tenantId!;

      const rows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        return await tx`
          SELECT id, subject_tenant_id, base_fy_label, forecast_year_offset,
                 projected_spend_aud, projected_headcount, confidence,
                 first_recorded_at
            FROM rd_forecast
           WHERE subject_tenant_id = ${subject_tenant_id}
             AND base_fy_label     = ${fy}
             AND tenant_id         = ${tenantId}
           ORDER BY forecast_year_offset ASC
        `;
      });

      return { rows };
    },
  );

  // -------------------------------------------------------------------
  // 6. POST /v1/compliance/multi-entity-scan (STUB)
  //    Future: enqueue via pg-boss for the multi-entity-similarity agent (D.3)
  // -------------------------------------------------------------------
  app.post(
    '/v1/compliance/multi-entity-scan',
    { preHandler: requireSession },
    async (req, reply) => {
      const parsed = MultiEntityScanInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: parsed.error.issues.map((i) => i.message).join('; '),
          requestId: req.id,
        });
      }

      // STUB — in the future this will use pg-boss to enqueue the job.
      return reply.status(202).send({
        status: 'queued',
        message: 'Multi-entity similarity scan queued',
      });
    },
  );

  // -------------------------------------------------------------------
  // 7. GET /v1/compliance/form-completeness/:subject_tenant_id/:fy
  //    Cross-checks multiple tables for form submission readiness.
  // -------------------------------------------------------------------
  app.get<{ Params: { subject_tenant_id: string; fy: string } }>(
    '/v1/compliance/form-completeness/:subject_tenant_id/:fy',
    { preHandler: requireSession },
    async (req, reply) => {
      const { subject_tenant_id, fy } = req.params;
      if (!z.string().uuid().safeParse(subject_tenant_id).success) {
        return reply.status(400).send({ error: 'invalid subject_tenant_id', requestId: req.id });
      }

      const tenantId = req.user!.tenantId!;

      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // (a) All activities for this subject+fy. Activity joins to its
        //     subject via `claim.subject_tenant_id` — there's no
        //     `activity.subject_tenant_id` column.
        const activities = await tx<{ id: string }[]>`
          SELECT a.id
            FROM activity a
            JOIN claim c ON c.id = a.claim_id AND c.tenant_id = a.tenant_id
           WHERE c.subject_tenant_id = ${subject_tenant_id}
             AND a.fy_label = ${fy}
             AND a.tenant_id = ${tenantId}
        `;
        const activityIds = activities.map((a) => a.id);

        // (a) Activities with at least 1 knowledge_search_record
        let activitiesWithSearch: string[] = [];
        if (activityIds.length > 0) {
          const searchRows = await tx<{ activity_id: string }[]>`
            SELECT DISTINCT activity_id
              FROM knowledge_search_record
             WHERE activity_id = ANY(${activityIds})
               AND tenant_id = ${tenantId}
          `;
          activitiesWithSearch = searchRows.map((r) => r.activity_id);
        }
        const missingSearchActivityIds = activityIds.filter(
          (id) => !activitiesWithSearch.includes(id),
        );

        // (b) Beneficial ownership populated for the FY
        const boRows = await tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count
            FROM beneficial_ownership
           WHERE subject_tenant_id = ${subject_tenant_id}
             AND fy_label = ${fy}
             AND tenant_id = ${tenantId}
        `;
        const boCount = parseInt(boRows[0]?.count ?? '0', 10);

        // (c) rd_forecast populated for offsets 1, 2, 3
        const forecastRows = await tx<{ forecast_year_offset: number }[]>`
          SELECT forecast_year_offset
            FROM rd_forecast
           WHERE subject_tenant_id = ${subject_tenant_id}
             AND base_fy_label = ${fy}
             AND tenant_id = ${tenantId}
        `;
        const existingOffsets = forecastRows.map((r) => r.forecast_year_offset);
        const missingOffsets = FORECAST_OFFSETS.filter((o) => !existingOffsets.includes(o));

        // (d) r_and_d_facility populated (at least 1 row)
        const facilityRows = await tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count
            FROM r_and_d_facility
           WHERE subject_tenant_id = ${subject_tenant_id}
             AND fy_label = ${fy}
             AND tenant_id = ${tenantId}
        `;
        const facilityCount = parseInt(facilityRows[0]?.count ?? '0', 10);

        // (e) Narrative char counts within thresholds.
        //
        //     `narrative_draft` stores its content as a jsonb array of
        //     NarrativeSegment shapes (`segments` column) — there is no flat
        //     `content` text column. Total content length is the sum of
        //     LENGTH(segments[i]->>'text') across all segments. Computed
        //     server-side so we don't have to ship the entire jsonb to the
        //     API process just to count characters.
        //
        //     Completeness rule: every (activity, required_section_kind)
        //     pair must have a draft whose total content length is within
        //     the section's threshold band. A missing draft counts as
        //     length=0, which fails the min check the same way an
        //     under-length draft would.
        interface NarrativeRow {
          activity_id: string;
          section_kind: string;
          total_length: number;
        }
        const narrativeWarnings: {
          activity_id: string;
          field: string;
          current_length: number;
          min_required: number;
          max_allowed: number;
        }[] = [];

        if (activityIds.length > 0) {
          const narrativeRows = await tx<NarrativeRow[]>`
            SELECT
              activity_id,
              section_kind,
              COALESCE(
                (SELECT SUM(LENGTH(elem->>'text'))::int
                   FROM jsonb_array_elements(segments) AS elem
                  WHERE elem->>'text' IS NOT NULL),
                0
              ) AS total_length
              FROM narrative_draft
             WHERE activity_id = ANY(${activityIds})
               AND tenant_id = ${tenantId}
          `;

          // Index by (activity_id, section_kind) for O(1) lookup below.
          const byKey = new Map<string, number>();
          for (const row of narrativeRows) {
            byKey.set(`${row.activity_id}:${row.section_kind}`, row.total_length);
          }

          // For every (activity, required section), assert presence + length.
          for (const activityId of activityIds) {
            for (const [section, threshold] of Object.entries(NARRATIVE_THRESHOLDS)) {
              const length = byKey.get(`${activityId}:${section}`) ?? 0;
              if (length < threshold.min || length > threshold.max) {
                narrativeWarnings.push({
                  activity_id: activityId,
                  field: section,
                  current_length: length,
                  min_required: threshold.min,
                  max_allowed: threshold.max,
                });
              }
            }
          }
        }

        const knowledgeSearchComplete =
          missingSearchActivityIds.length === 0 && activityIds.length > 0;
        const beneficialOwnershipComplete = boCount >= 1;
        const forecastComplete = missingOffsets.length === 0;
        const facilitiesComplete = facilityCount >= 1;
        const narrativesComplete = narrativeWarnings.length === 0 && activityIds.length > 0;

        const complete =
          knowledgeSearchComplete &&
          beneficialOwnershipComplete &&
          forecastComplete &&
          facilitiesComplete &&
          narrativesComplete;

        return {
          complete,
          checks: {
            knowledge_search: {
              complete: knowledgeSearchComplete,
              missing_activity_ids: missingSearchActivityIds,
            },
            beneficial_ownership: {
              complete: beneficialOwnershipComplete,
              count: boCount,
            },
            forecast: {
              complete: forecastComplete,
              missing_offsets: missingOffsets,
            },
            facilities: {
              complete: facilitiesComplete,
              count: facilityCount,
            },
            narratives: {
              complete: narrativesComplete,
              warnings: narrativeWarnings,
            },
          },
        };
      });

      return result;
    },
  );

  // -------------------------------------------------------------------
  // 8. GET /v1/compliance/at-risk-summary/:subject_tenant_id/:fy
  //    Returns risk summary per activity with GIC-based clawback estimate.
  // -------------------------------------------------------------------
  app.get<{ Params: { subject_tenant_id: string; fy: string } }>(
    '/v1/compliance/at-risk-summary/:subject_tenant_id/:fy',
    { preHandler: requireSession },
    async (req, reply) => {
      const { subject_tenant_id, fy } = req.params;
      if (!z.string().uuid().safeParse(subject_tenant_id).success) {
        return reply.status(400).send({ error: 'invalid subject_tenant_id', requestId: req.id });
      }

      const tenantId = req.user!.tenantId!;

      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // Activities with their expenditure totals for the subject+fy
        interface ActivityExpRow {
          activity_id: string;
          title: string;
          claimed_amount: string;
        }

        // Activity scopes to its subject via `claim.subject_tenant_id` —
        // there's no `activity.subject_tenant_id` column.
        //
        // TODO(p4-b-counts): claimed_amount is hardcoded to '0' until the
        // expenditure→activity mapping schema lands. The original query
        // joined `expenditure e ON e.activity_id = a.id` but `expenditure`
        // has no `activity_id` column (and the SUM referenced
        // `e.amount_aud` which is actually `total_amount`). Same gap as
        // claims.ts:319 — both surfaces will be wired up together once
        // expenditure_line.activity_id mapping lands.
        const activityRows = await tx<ActivityExpRow[]>`
          SELECT
            a.id AS activity_id,
            a.title,
            '0'::text AS claimed_amount
          FROM activity a
          JOIN claim c ON c.id = a.claim_id AND c.tenant_id = a.tenant_id
          WHERE c.subject_tenant_id = ${subject_tenant_id}
            AND a.fy_label = ${fy}
            AND a.tenant_id = ${tenantId}
          ORDER BY a.title ASC
        `;

        let totalClaimed = 0;
        let totalAtRisk = 0;

        const activities = activityRows.map((row) => {
          const claimed = parseFloat(row.claimed_amount);
          const atRisk = claimed; // conservative: entire claimed amount at risk
          const clawback4yr = claimed * ATO_GIC_RATE * 4;

          totalClaimed += claimed;
          totalAtRisk += atRisk;

          return {
            activity_id: row.activity_id,
            title: row.title,
            claimed_amount: claimed,
            at_risk_amount: atRisk,
            clawback_4yr: Math.round(clawback4yr * 100) / 100,
          };
        });

        return {
          subject_tenant_id,
          fy_label: fy,
          total_claimed: totalClaimed,
          total_at_risk: totalAtRisk,
          activities,
        };
      });

      return result;
    },
  );
}

// ─── Internal exports for testing ─────────────────────────────────────
export const _internals = {
  BeneficialOwnershipInput,
  KnowledgeSearchInput,
  FacilityInput,
  ForecastInput,
  MultiEntityScanInput,
  ATO_GIC_RATE,
  NARRATIVE_THRESHOLDS,
  OWNER_KINDS,
  CONFIDENCE_LEVELS,
  FORECAST_OFFSETS,
};
