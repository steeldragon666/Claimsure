/**
 * Proposed-activities endpoint — surfaces the AI-extracted activity proposals
 * sitting inside `event.extracted_content.activities` JSONB blobs.
 *
 * Why this exists: the wizard's narrative-approval flow only writes rows
 * to the `activity` table AFTER the consultant approves the AI's narrative.
 * Until then, the Haiku extraction's proposed activities live inside the
 * event chain — invisible to anyone who isn't reading the JSON directly.
 * The Activities tab needs to show these proposals so consultants can see
 * what the AI has surfaced before clicking through the wizard's approve gate.
 *
 *   GET /v1/proposed-activities
 *   Optional query: ?subject_tenant_id=<uuid>   scope to one claimant
 *
 * Returns a flat array of proposals — each carrying name, kind (core /
 * supporting), confidence, hypothesis, technical_uncertainty, expected
 * outcome, rationale, source_excerpt, plus provenance (event_id +
 * filename + classification kind + the claimant they belong to).
 *
 * De-duplication: not done at the API layer. Frontend may want to render
 * proposals from different documents that propose similar activities side-
 * by-side so consultants can pick the strongest formulation. The
 * synthesizer-register stage (Sonnet) is responsible for cross-document
 * deduplication into a final activity register.
 */
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';

interface ProposedActivityRow {
  event_id: string;
  event_kind: string;
  subject_tenant_id: string;
  subject_tenant_name: string;
  filename: string | null;
  captured_at: string;
  classification_kind: string | null;
  proposed_name: string;
  proposed_kind: 'core' | 'supporting';
  confidence: number;
  hypothesis_text: string;
  technical_uncertainty: string;
  expected_outcome: string;
  rationale: string;
  source_excerpt: string;
}

interface ProposedActivitiesResponse {
  proposals: ProposedActivityRow[];
  /** Aggregate stats so the UI can render a summary header without re-counting. */
  summary: {
    total: number;
    core: number;
    supporting: number;
    distinct_documents: number;
    high_confidence: number; // ≥ 0.80
    avg_confidence: number;
  };
}

export function registerProposedActivities(app: FastifyInstance): void {
  app.get<{ Querystring: { subject_tenant_id?: string } }>(
    '/v1/proposed-activities',
    { preHandler: requireSession },
    async (req, reply) => {
      const tenantId = req.user!.tenantId!;
      const subjectTenantId = req.query.subject_tenant_id ?? null;

      const result = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // Pull every event with non-empty activity proposals. Unnest the
        // JSONB array so each proposal becomes its own row, joined with
        // the event + subject_tenant metadata for provenance.
        const rows = subjectTenantId
          ? await tx<ProposedActivityRow[]>`
              SELECT
                e.id::text                                       AS event_id,
                e.kind                                           AS event_kind,
                e.subject_tenant_id::text                        AS subject_tenant_id,
                st.name                                          AS subject_tenant_name,
                (e.payload ->> 'filename')                       AS filename,
                e.captured_at::text                              AS captured_at,
                (e.classification ->> 'kind')                    AS classification_kind,
                (act ->> 'proposed_name')                        AS proposed_name,
                (act ->> 'proposed_kind')                        AS proposed_kind,
                ((act ->> 'confidence')::numeric)::float         AS confidence,
                (act ->> 'hypothesis_text')                      AS hypothesis_text,
                (act ->> 'technical_uncertainty')                AS technical_uncertainty,
                (act ->> 'expected_outcome')                     AS expected_outcome,
                (act ->> 'rationale')                            AS rationale,
                (act ->> 'source_excerpt')                       AS source_excerpt
              FROM event e
              CROSS JOIN LATERAL jsonb_array_elements(
                COALESCE(e.extracted_content -> 'activities', '[]'::jsonb)
              ) AS act
              JOIN subject_tenant st ON st.id = e.subject_tenant_id
              WHERE e.tenant_id         = ${tenantId}
                AND e.subject_tenant_id = ${subjectTenantId}
                AND e.extraction_status = 'complete'
                AND NOT (
                  (e.extracted_content ->> 'document_summary') LIKE 'Stub analyzer:%'
                )
              ORDER BY (act ->> 'proposed_kind') DESC,
                       ((act ->> 'confidence')::numeric) DESC,
                       e.captured_at DESC
            `
          : await tx<ProposedActivityRow[]>`
              SELECT
                e.id::text                                       AS event_id,
                e.kind                                           AS event_kind,
                e.subject_tenant_id::text                        AS subject_tenant_id,
                st.name                                          AS subject_tenant_name,
                (e.payload ->> 'filename')                       AS filename,
                e.captured_at::text                              AS captured_at,
                (e.classification ->> 'kind')                    AS classification_kind,
                (act ->> 'proposed_name')                        AS proposed_name,
                (act ->> 'proposed_kind')                        AS proposed_kind,
                ((act ->> 'confidence')::numeric)::float         AS confidence,
                (act ->> 'hypothesis_text')                      AS hypothesis_text,
                (act ->> 'technical_uncertainty')                AS technical_uncertainty,
                (act ->> 'expected_outcome')                     AS expected_outcome,
                (act ->> 'rationale')                            AS rationale,
                (act ->> 'source_excerpt')                       AS source_excerpt
              FROM event e
              CROSS JOIN LATERAL jsonb_array_elements(
                COALESCE(e.extracted_content -> 'activities', '[]'::jsonb)
              ) AS act
              JOIN subject_tenant st ON st.id = e.subject_tenant_id
              WHERE e.tenant_id         = ${tenantId}
                AND e.extraction_status = 'complete'
                AND NOT (
                  (e.extracted_content ->> 'document_summary') LIKE 'Stub analyzer:%'
                )
              ORDER BY st.name ASC,
                       (act ->> 'proposed_kind') DESC,
                       ((act ->> 'confidence')::numeric) DESC,
                       e.captured_at DESC
            `;

        return rows;
      });

      const total = result.length;
      const core = result.filter((p) => p.proposed_kind === 'core').length;
      const supporting = result.filter((p) => p.proposed_kind === 'supporting').length;
      const distinctDocuments = new Set(result.map((p) => p.event_id)).size;
      const highConfidence = result.filter((p) => p.confidence >= 0.8).length;
      const avgConfidence =
        total > 0 ? result.reduce((sum, p) => sum + p.confidence, 0) / total : 0;

      const response: ProposedActivitiesResponse = {
        proposals: result,
        summary: {
          total,
          core,
          supporting,
          distinct_documents: distinctDocuments,
          high_confidence: highConfidence,
          avg_confidence: Math.round(avgConfidence * 100) / 100,
        },
      };

      return reply.status(200).send(response);
    },
  );
}
