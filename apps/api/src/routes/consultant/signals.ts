import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';

const VALID_WINDOWS = ['24h', '7d', '30d'] as const;
type WindowParam = (typeof VALID_WINDOWS)[number];

const WINDOW_TO_INTERVAL: Record<WindowParam, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

export function registerConsultantSignals(app: FastifyInstance): void {
  app.get('/v1/consultant/signals', { preHandler: requireSession }, async (req, reply) => {
    const window = (req.query as Record<string, string>).window ?? '24h';

    if (!VALID_WINDOWS.includes(window as WindowParam)) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: `Query param "window" must be one of: ${VALID_WINDOWS.join(', ')}`,
        requestId: req.id,
      });
    }

    const interval = WINDOW_TO_INTERVAL[window as WindowParam];
    const tenantId = req.user!.tenantId!;

    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      const rows = await tx<
        {
          src: string;
          tag: string;
          code: string;
          title: string;
          exposure: number;
          when: string;
        }[]
      >`
          SELECT
            CASE s.source_name
              WHEN 'ATO Legal Database' THEN 'ATO'
              WHEN 'AustLII AAT R&DTI' THEN 'AAT'
              WHEN 'AustLII ART R&DTI' THEN 'ART'
              WHEN 'business.gov.au R&DTI' THEN 'AUSINDUSTRY'
              WHEN 'ISA Findings' THEN 'ISA'
              ELSE SPLIT_PART(s.source_name, ' ', 1)
            END AS src,
            CASE e.classification_kind
              WHEN 'tax_alert' THEN 'TAXPAYER ALERT'
              WHEN 'pcg' THEN 'PCG'
              WHEN 'public_ruling' THEN 'PUBLIC RULING'
              WHEN 'disr_program_change' THEN 'PROGRAM CHANGE'
              WHEN 'form_change' THEN 'FORM CHANGE'
              WHEN 'aat_decision' THEN 'DECISION'
              WHEN 'art_decision' THEN 'DECISION'
              WHEN 'isa_finding' THEN 'ISA FINDING'
              WHEN 'industry_guidance' THEN 'GUIDANCE'
              WHEN 'asx_disclosure' THEN 'DISCLOSURE'
              WHEN 'other' THEN 'UPDATE'
              ELSE 'UPDATE'
            END AS tag,
            e.external_id AS code,
            e.raw_title AS title,
            COALESCE((
              SELECT COUNT(DISTINCT c.id)::int
              FROM claim c
              JOIN activity a ON a.claim_id = c.id
              WHERE c.tenant_id = ${tenantId}
                AND e.classification_payload IS NOT NULL
                AND e.classification_payload ? 'tagged_activity_codes'
                AND a.kind = ANY(
                  ARRAY(
                    SELECT jsonb_array_elements_text(
                      e.classification_payload->'tagged_activity_codes'
                    )
                  )
                )
            ), 0) AS exposure,
            TO_CHAR(
              e.published_at AT TIME ZONE 'Australia/Sydney', 'HH24:MI'
            ) AS "when"
          FROM regulatory_event e
          JOIN regulatory_source s ON s.id = e.source_id
          WHERE e.published_at >= NOW() - ${interval}::interval
          ORDER BY e.published_at DESC
        `;

      return { signals: rows };
    });
  });
}
