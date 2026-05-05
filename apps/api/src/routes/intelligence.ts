import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { privilegedSql } from '@cpa/db/client';

/**
 * P7 Theme D Task D.12 — Regulatory Intelligence Feed routes.
 *
 * Two read-only endpoints for the /intelligence UI:
 *   GET /v1/intelligence/events   — paginated event list
 *   GET /v1/intelligence/sources  — source status overview
 *
 * regulatory_event and regulatory_source are global tables (no RLS),
 * so we use privilegedSql. Auth is still required (requireSession).
 */
export function registerIntelligence(app: FastifyInstance): void {
  // GET /v1/intelligence/events
  app.get<{
    Querystring: {
      kind?: string;
      severity?: string;
      limit?: string;
      offset?: string;
    };
  }>('/v1/intelligence/events', { preHandler: requireSession }, async (request, reply) => {
    const kind = request.query.kind || null;
    const severity = request.query.severity || null;
    const limit = Math.min(Math.max(parseInt(request.query.limit || '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(request.query.offset || '0', 10) || 0, 0);

    const events = await privilegedSql`
        SELECT
          e.id, e.source_id, e.external_id, e.raw_title, e.raw_content,
          e.source_url, e.published_at, e.classified_at,
          e.classification_kind, e.classification_severity,
          s.source_name AS source_name
        FROM regulatory_event e
        JOIN regulatory_source s ON s.id = e.source_id
        WHERE (${kind}::text IS NULL OR e.classification_kind = ${kind})
          AND (${severity}::text IS NULL OR e.classification_severity = ${severity})
        ORDER BY e.published_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

    interface CountRow {
      count: string;
    }

    const countRows = await privilegedSql<CountRow[]>`
        SELECT COUNT(*)::text AS count
        FROM regulatory_event e
        WHERE (${kind}::text IS NULL OR e.classification_kind = ${kind})
          AND (${severity}::text IS NULL OR e.classification_severity = ${severity})
      `;

    return reply.send({
      events,
      total: parseInt(countRows[0]?.count ?? '0', 10),
    });
  });

  // GET /v1/intelligence/sources
  app.get('/v1/intelligence/sources', { preHandler: requireSession }, async (_request, reply) => {
    const sources = await privilegedSql`
        SELECT
          id, source_name, parser_kind, source_url, fetch_interval_hours, enabled,
          last_polled_at, last_polled_status,
          CASE
            WHEN last_polled_at IS NULL THEN true
            WHEN last_polled_at < NOW() - INTERVAL '7 days' THEN true
            ELSE false
          END AS stale
        FROM regulatory_source
        ORDER BY source_name
      `;
    return reply.send({ sources });
  });
}
