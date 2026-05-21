import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import {
  EVIDENCE_FEED_KINDS,
  evidenceQuery,
  type EvidenceFeedItem,
  type EvidenceFeedResponse,
} from '@cpa/schemas';

/** Encode cursor as base64url JSON `{ at, id }`. */
function encodeCursor(captured_at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at: captured_at, id })).toString('base64url');
}
function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      'at' in decoded &&
      'id' in decoded &&
      typeof (decoded as { at: unknown }).at === 'string' &&
      typeof (decoded as { id: unknown }).id === 'string'
    ) {
      return decoded as { at: string; id: string };
    }
    return null;
  } catch {
    return null;
  }
}

interface RawRow {
  id: string;
  kind: string;
  captured_at: Date;
  payload_excerpt: string;
  claimant_id: string;
  claimant_name: string;
  classification_kind: string | null;
  classification_confidence: string | null;
  claim_id: string | null;
}

export function registerEvidenceRoutes(app: FastifyInstance): void {
  app.get('/v1/evidence', { preHandler: requireSession }, async (req, reply) => {
    const parsed = evidenceQuery.safeParse(req.query);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join('; ') || 'Invalid query';
      return reply.status(400).send({ error: 'invalid_query', message, requestId: req.id });
    }
    const { kinds, claimant_ids, since, limit, cursor } = parsed.data;

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      return reply
        .status(400)
        .send({ error: 'invalid_cursor', message: 'cursor is malformed', requestId: req.id });
    }

    // Effective kind filter = intersection of caller filter and allowlist.
    const effectiveKinds = (kinds ?? [...EVIDENCE_FEED_KINDS]) as string[];

    // RLS scopes by tenant_id automatically (cpa_app role + app.current_tenant_id GUC).
    const rows = await sql<RawRow[]>`
      SELECT
        e.id::text                          AS id,
        e.kind                              AS kind,
        e.captured_at                       AS captured_at,
        COALESCE(NULLIF(e.payload->>'filename', ''),
                 LEFT(COALESCE(e.payload->>'raw_text', ''), 240)) AS payload_excerpt,
        st.id::text                         AS claimant_id,
        st.name                             AS claimant_name,
        e.classification->>'kind'           AS classification_kind,
        e.classification->>'confidence'     AS classification_confidence,
        NULL::text                          AS claim_id
      FROM event e
      JOIN subject_tenant st ON st.id = e.subject_tenant_id
      WHERE e.kind = ANY(${effectiveKinds})
        AND (${claimant_ids ?? null}::uuid[] IS NULL OR e.subject_tenant_id = ANY(${claimant_ids ?? null}::uuid[]))
        AND (${since ?? null}::timestamptz IS NULL OR e.captured_at >= ${since ?? null}::timestamptz)
        AND (${decoded?.at ?? null}::timestamptz IS NULL
             OR (e.captured_at, e.id::text) < (${decoded?.at ?? null}::timestamptz, ${decoded?.id ?? null}::text))
      ORDER BY e.captured_at DESC, e.id DESC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];

    const items: EvidenceFeedItem[] = page.map((r) => ({
      id: r.id,
      kind: r.kind as EvidenceFeedItem['kind'],
      captured_at: r.captured_at.toISOString(),
      payload_excerpt: r.payload_excerpt ?? '',
      claimant: { id: r.claimant_id, name: r.claimant_name },
      classification:
        r.classification_kind !== null && r.classification_confidence !== null
          ? {
              kind: r.classification_kind,
              confidence: Number(r.classification_confidence),
            }
          : null,
      claim_id: r.claim_id,
    }));

    const next_cursor =
      hasMore && lastRow ? encodeCursor(lastRow.captured_at.toISOString(), lastRow.id) : null;

    const body: EvidenceFeedResponse = { items, next_cursor };
    return reply.send(body);
  });
}
