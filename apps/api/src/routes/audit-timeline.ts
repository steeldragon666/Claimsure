import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { verifyChain, type ChainStatus } from '@cpa/db';
import { sql } from '@cpa/db/client';

/**
 * P7 Theme C Task C.1 — Activity audit timeline endpoint.
 *
 * Returns a chronological timeline of all audit-relevant events for a given
 * activity: chain events, narrative draft versions, audit_log entries,
 * prompt_suggestions, and (when p7d lands) multi_entity_similarity_score rows.
 *
 * Chain verification is batched: one `verifyChain()` call per request over
 * the activity's subject_tenant chain — NOT per-row. This avoids the N+1
 * anti-pattern flagged as risk R-C1 in the design doc.
 */

interface TimelineRow {
  kind: 'event' | 'narrative_version' | 'audit_log' | 'suggestion' | 'similarity_flag';
  id: string;
  timestamp: string;
  event_kind?: string;
  chain_verified?: boolean;
  payload?: unknown;
  metadata?: unknown;
  /** Forensic fields returned per-row for the audit hover-card (C.3). */
  forensic?: {
    first_recorded_at?: string;
    content_hash?: string;
    chain_position?: number;
    edit_count?: number;
    prev_hash?: string | null;
  };
}

export function registerAuditTimeline(app: FastifyInstance): void {
  app.get<{ Params: { activityId: string } }>(
    '/v1/audit/activity/:activityId/timeline',
    { preHandler: requireSession },
    async (req, reply) => {
      const { activityId } = req.params;
      const tenantId = req.user!.tenantId!;

      // 1. Look up the activity to get its subject_tenant_id (and verify visibility)
      const activityLookup = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string; subject_tenant_id: string }[]>`
          SELECT a.id, c.subject_tenant_id
            FROM activity a
            JOIN claim c ON c.id = a.claim_id
           WHERE a.id = ${activityId}
             AND a.tenant_id = ${tenantId}
        `;
        return rows[0] ?? null;
      });

      if (!activityLookup) {
        return reply.status(404).send({
          error: 'activity_not_found',
          message: 'No activity with that id in this firm',
          requestId: req.id,
        });
      }

      const { subject_tenant_id } = activityLookup;

      // 2. Batch verifyChain — ONE call for the entire subject_tenant chain.
      //    Cached per request lifetime (called once, result used for all event rows).
      const chainStatus: ChainStatus = await verifyChain(subject_tenant_id);

      // 3. Query all timeline sources in parallel within one transaction
      const timeline = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        // audit_log uses a separate RLS GUC (app.current_firm_id)
        await tx`SELECT set_config('app.current_firm_id', ${tenantId}, true)`;

        // 3a. Events referencing this activity (via jsonb payload->>'activity_id')
        //     Include hash/prev_hash/received_at for forensic hover-card (C.3).
        const events = await tx<
          {
            id: string;
            kind: string;
            payload: unknown;
            captured_at: Date | string;
            hash: string;
            prev_hash: string | null;
            received_at: Date | string;
          }[]
        >`
          SELECT id, kind, payload, captured_at, hash, prev_hash, received_at
            FROM event
           WHERE subject_tenant_id = ${subject_tenant_id}
             AND payload->>'activity_id' = ${activityId}
           ORDER BY captured_at ASC
        `;

        // 3b. Narrative draft versions for this activity
        const narrativeVersions = await tx<
          {
            id: string;
            version: number;
            generation_kind: string;
            content_hash: string;
            created_at: Date | string;
          }[]
        >`
          SELECT ndv.id, ndv.version, ndv.generation_kind, ndv.content_hash, ndv.created_at
            FROM narrative_draft_version ndv
            JOIN narrative_draft nd ON nd.id = ndv.draft_id AND nd.tenant_id = ndv.tenant_id
           WHERE nd.activity_id = ${activityId}
             AND ndv.tenant_id = ${tenantId}
           ORDER BY ndv.created_at ASC
        `;

        // 3c. Audit log entries referencing this activity (via payload->>'activity_id')
        const auditLogs = await tx<
          { id: string; kind: string; payload: unknown; created_at: Date | string }[]
        >`
          SELECT id, kind, payload, created_at
            FROM audit_log
           WHERE firm_id = ${tenantId}
             AND payload->>'activity_id' = ${activityId}
           ORDER BY created_at ASC
        `;

        // 3d. Prompt suggestions referencing this activity (via source_payload->>'activity_id')
        const suggestions = await tx<
          { id: string; source_kind: string; issue_summary: string; flagged_at: Date | string }[]
        >`
          SELECT id, source_kind, issue_summary, flagged_at
            FROM prompt_suggestion
           WHERE tenant_id = ${tenantId}
             AND source_payload->>'activity_id' = ${activityId}
           ORDER BY flagged_at ASC
        `;

        // 3e. Multi-entity similarity scores — only if the table exists (p7d)
        let similarityFlags: { id: string; score: number; created_at: Date | string }[] = [];
        const tableCheck = await tx<{ exists: unknown }[]>`
          SELECT to_regclass('multi_entity_similarity_score') AS exists
        `;
        if (tableCheck[0]?.exists) {
          similarityFlags = await tx<{ id: string; score: number; created_at: Date | string }[]>`
            SELECT id, score, created_at
              FROM multi_entity_similarity_score
             WHERE activity_id = ${activityId}
               AND tenant_id = ${tenantId}
             ORDER BY created_at ASC
          `;
        }

        return { events, narrativeVersions, auditLogs, suggestions, similarityFlags };
      });

      // 4. Merge into a unified chronological timeline
      const rows: TimelineRow[] = [];

      const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());

      for (let i = 0; i < timeline.events.length; i++) {
        const e = timeline.events[i]!;
        rows.push({
          kind: 'event',
          id: e.id,
          timestamp: isoOf(e.captured_at),
          event_kind: e.kind,
          chain_verified: chainStatus.verified,
          payload: e.payload,
          forensic: {
            first_recorded_at: isoOf(e.received_at),
            content_hash: e.hash,
            chain_position: i + 1,
            prev_hash: e.prev_hash,
          },
        });
      }

      for (const nv of timeline.narrativeVersions) {
        rows.push({
          kind: 'narrative_version',
          id: nv.id,
          timestamp: isoOf(nv.created_at),
          metadata: {
            version: nv.version,
            generation_kind: nv.generation_kind,
            content_hash: nv.content_hash,
          },
          forensic: {
            first_recorded_at: isoOf(nv.created_at),
            content_hash: nv.content_hash,
            edit_count: nv.version,
          },
        });
      }

      for (const al of timeline.auditLogs) {
        rows.push({
          kind: 'audit_log',
          id: al.id,
          timestamp: isoOf(al.created_at),
          event_kind: al.kind,
          payload: al.payload,
        });
      }

      for (const s of timeline.suggestions) {
        rows.push({
          kind: 'suggestion',
          id: s.id,
          timestamp: isoOf(s.flagged_at),
          metadata: {
            source_kind: s.source_kind,
            issue_summary: s.issue_summary,
          },
        });
      }

      for (const sf of timeline.similarityFlags) {
        rows.push({
          kind: 'similarity_flag',
          id: sf.id,
          timestamp: isoOf(sf.created_at),
          metadata: { score: sf.score },
        });
      }

      // Sort chronologically
      rows.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      return {
        timeline: rows,
        chain_status: chainStatus,
      };
    },
  );
}
