import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import { renderActivityApplicationPdf, type ActivityApplicationInput } from '@cpa/documents';

/**
 * Register the activity-application PDF endpoint (T-A8 of the P4 plan).
 *
 *   GET /v1/activities/:id/application.pdf
 *
 * Roles: admin, consultant, viewer (same gate as GET /v1/activities/:id —
 * read-only download is fine for read-only roles).
 *
 * Behavior:
 *   - Loads the activity, its parent project, claim, subject_tenant, and
 *     firm in a single RLS-scoped transaction. Defense-in-depth: explicit
 *     `AND tenant_id = ${tenantId}` on the activity SELECT (matches A3 /
 *     A4's pattern).
 *   - Folds the artefact-link chain (LINKED − UNLINKED) and pulls the
 *     uncertainty events whose payload->>'activity_id' matches.
 *   - Builds an `ActivityApplicationInput` from the joined rows and
 *     streams the rendered PDF as the response body.
 *
 * Cache-Control: `private, no-store` — the PDF is a render of CURRENT
 * state. Auditors expect the chain itself to be the canonical history;
 * the PDF reflects "what the consultant saw at generation time" and must
 * never be served from a CDN/intermediate cache.
 *
 * No PDF_GENERATED chain event is emitted — this is a derived report,
 * not a committed artefact. The chain is the source of truth.
 *
 * Cross-firm activity ⇒ 404 (mirrors GET /v1/activities/:id).
 */
export function registerActivityPdf(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    '/v1/activities/:id/application.pdf',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      // Phase 1 — load everything we need for the PDF in one tx so a
      // racing PATCH/UNLINK can't interleave between joins. The shape we
      // load mirrors `ActivityApplicationInput` so the assembly below is
      // mostly straight field copies.
      const loaded = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const activityRows = await tx<
          {
            id: string;
            code: string;
            title: string;
            kind: 'core' | 'supporting';
            description: string | null;
            hypothesis: string | null;
            technical_uncertainty: string | null;
            experimentation_log: string | null;
            expected_outcome: string | null;
            actual_outcome: string | null;
            project_id: string;
            claim_id: string;
            subject_tenant_id: string;
            project_name: string;
            project_description: string | null;
            project_started_at: Date | string;
            project_ended_at: Date | string | null;
            claim_fiscal_year: number;
            claim_stage: string;
            subject_tenant_name: string;
            tenant_name: string;
          }[]
        >`
          SELECT a.id, a.code, a.title, a.kind,
                 a.description, a.hypothesis, a.technical_uncertainty,
                 a.experimentation_log, a.expected_outcome, a.actual_outcome,
                 a.project_id, a.claim_id,
                 c.subject_tenant_id,
                 p.name AS project_name,
                 p.description AS project_description,
                 p.started_at AS project_started_at,
                 p.ended_at AS project_ended_at,
                 c.fiscal_year AS claim_fiscal_year,
                 c.stage AS claim_stage,
                 st.name AS subject_tenant_name,
                 t.name AS tenant_name
            FROM activity a
            JOIN project p ON p.id = a.project_id
            JOIN claim c ON c.id = a.claim_id
            JOIN subject_tenant st ON st.id = c.subject_tenant_id
            JOIN tenant t ON t.id = a.tenant_id
           WHERE a.id = ${id}
             AND a.tenant_id = ${tenantId}
        `;
        const activity = activityRows[0];
        if (!activity) return { kind: 'not_found' as const };

        // Artefact link/unlink fold — same algorithm as
        // `getActivityArtefacts`, but inlined inside the same tx so we
        // get a coherent snapshot with the activity load above.
        const linkRows = await tx<
          {
            id: string;
            kind: 'ARTEFACT_LINKED' | 'ARTEFACT_UNLINKED';
            payload: {
              activity_id: string;
              artefact_kind: string;
              artefact_id: string;
              link_reason?: string;
              reason?: string;
            };
            captured_at: Date | string;
          }[]
        >`
          SELECT id, kind, payload, captured_at
            FROM event
           WHERE kind IN ('ARTEFACT_LINKED', 'ARTEFACT_UNLINKED')
             AND payload ->> 'activity_id' = ${id}
           ORDER BY captured_at ASC, received_at ASC, id ASC
        `;

        // Uncertainty register feed — the kinds that the A6 register
        // page surfaces. Order chronologically (oldest first) for the
        // PDF. We pull payload + captured_at + the optional
        // classification (rationale + confidence) for the inline
        // confidence block in the PDF.
        const eventRows = await tx<
          {
            kind: string;
            payload: { raw_text?: string } & Record<string, unknown>;
            captured_at: Date | string;
            classification: { confidence: number; rationale: string } | null;
          }[]
        >`
          SELECT kind, payload, captured_at, classification
            FROM event
           WHERE kind IN ('HYPOTHESIS', 'DESIGN', 'EXPERIMENT', 'OBSERVATION',
                          'ITERATION', 'NEW_KNOWLEDGE', 'UNCERTAINTY')
             AND payload ->> 'activity_id' = ${id}
           ORDER BY captured_at ASC, received_at ASC, id ASC
        `;

        return { kind: 'ok' as const, activity, linkRows, eventRows };
      });

      if (loaded.kind === 'not_found') {
        return reply.status(404).send({
          error: 'activity_not_found',
          message: 'No activity with that id in this firm',
          requestId: req.id,
        });
      }

      // Materialise currently-linked artefacts. The DB rows are sorted
      // chronologically; toggle each (kind, id) pair on/off so a re-link
      // sequence (LINKED → UNLINKED → LINKED) leaves the artefact in.
      const live = new Map<
        string,
        {
          kind: string;
          artefact_id: string;
          link_reason: string | null;
          linked_at: string;
        }
      >();
      for (const row of loaded.linkRows) {
        const key = `${row.payload.artefact_kind}|${row.payload.artefact_id}`;
        const linked_at =
          typeof row.captured_at === 'string' ? row.captured_at : row.captured_at.toISOString();
        if (row.kind === 'ARTEFACT_LINKED') {
          live.set(key, {
            kind: row.payload.artefact_kind,
            artefact_id: row.payload.artefact_id,
            link_reason: row.payload.link_reason ?? null,
            linked_at,
          });
        } else {
          live.delete(key);
        }
      }
      const artefacts = Array.from(live.values())
        .sort((a, b) => a.linked_at.localeCompare(b.linked_at))
        .map((a) => ({
          kind: a.kind,
          // We don't have a denormalised title for artefacts (would require
          // a per-kind join — out of scope here). Surface the artefact id
          // as the title; the consultant portal renders the same in its
          // "Linked artefacts" panel.
          title: a.artefact_id,
          uri: null,
          linked_at: a.linked_at,
          reason: a.link_reason,
        }));

      const uncertainty_events = loaded.eventRows.map((row) => {
        const captured_at =
          typeof row.captured_at === 'string' ? row.captured_at : row.captured_at.toISOString();
        // Best-effort summary: prefer raw_text when present (chain notes
        // captured via POST /v1/events carry it), otherwise stringify the
        // payload's most interesting field. Cap at 240 chars so the PDF
        // register entries stay one-or-two lines.
        const raw = typeof row.payload.raw_text === 'string' ? row.payload.raw_text : '';
        const summary =
          raw.length > 0 ? (raw.length > 240 ? raw.slice(0, 237) + '…' : raw) : `${row.kind} event`;
        return {
          kind: row.kind,
          captured_at,
          summary,
          classification: row.classification,
        };
      });

      const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());

      const input: ActivityApplicationInput = {
        firm: {
          name: loaded.activity.tenant_name,
          // TODO(P4-followup): schema gap — `firm.abn` column does not exist;
          // rendering "ABN not on file" placeholder until migration lands.
          // ABN is not yet a column on the tenant table; surface null so
          // the renderer prints "ABN not on file". Schema work to add the
          // column is tracked separately (out of scope for A8).
          abn: null,
        },
        subject_tenant: {
          name: loaded.activity.subject_tenant_name,
          // TODO(P4-followup): schema gap — `subject_tenant.abn` column does not exist;
          // rendering "ABN not on file" placeholder until migration lands.
          abn: null,
        },
        project: {
          name: loaded.activity.project_name,
          description: loaded.activity.project_description,
          started_at: isoOf(loaded.activity.project_started_at),
          ended_at:
            loaded.activity.project_ended_at !== null
              ? isoOf(loaded.activity.project_ended_at)
              : null,
        },
        claim: {
          fiscal_year: loaded.activity.claim_fiscal_year,
          stage: loaded.activity.claim_stage,
        },
        activity: {
          code: loaded.activity.code,
          title: loaded.activity.title,
          kind: loaded.activity.kind === 'core' ? 'CORE' : 'SUPPORTING',
          description: loaded.activity.description,
          // TODO(P4-followup): schema gap — `activity.objective` column does not exist;
          // bridging from `expected_outcome` until migration lands.
          // The activity table doesn't yet have separate `objective` and
          // `new_knowledge` columns — `expected_outcome` is the closest
          // analogue and the consultant portal treats it as the
          // objective. Surface it under both labels so the PDF section
          // looks complete; future schema migration can split if needed.
          objective: loaded.activity.expected_outcome,
          hypothesis: loaded.activity.hypothesis,
          technical_uncertainty: loaded.activity.technical_uncertainty,
          // TODO(P4-followup): schema gap — `activity.new_knowledge` column does not exist;
          // bridging from `actual_outcome` until migration lands.
          new_knowledge: loaded.activity.actual_outcome,
          // TODO(P4-followup): schema gap — `activity.activity_started_at` /
          // `activity.activity_ended_at` columns do not exist; rendering null +
          // "Not yet captured" placeholder until migration lands.
          // Activity-level start/end dates are not yet schema fields —
          // null until they are.
          activity_started_at: null,
          activity_ended_at: null,
        },
        artefacts,
        uncertainty_events,
        generated_at: new Date().toISOString(),
      };

      const pdf = await renderActivityApplicationPdf(input);

      // Defense against CWE-93 / response-splitting: even though activity.code is
      // constrained to [CS]A-NNN today, sanitize at the use site so future
      // constraint relaxation can't introduce a header-injection vector.
      const safeCode = loaded.activity.code.replace(/[^A-Za-z0-9._-]/g, '_');
      const safeYear = String(loaded.activity.claim_fiscal_year).replace(/[^0-9]/g, '');
      const filename = `activity-${safeCode}-${safeYear}.pdf`;
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Content-Length', pdf.byteLength.toString());
      // renderToBuffer materializes the full PDF before send. Fine for current
      // payloads (5-30 KB typical, 100 KB worst case with 50+ artefacts).
      // If a future activity has hundreds of artefacts and the buffered PDF
      // approaches 5 MB, switch to renderToStream + reply.send(stream).
      // See @react-pdf/renderer docs: renderToStream returns a Node Readable.
      //
      // Send as Buffer — Fastify will pass it through verbatim. We expose
      // Uint8Array on the documents package surface; convert to Buffer
      // here so downstream pipeline (Fastify serializer guard, content-
      // length detection) sees a Node-native binary type.
      return reply.status(200).send(Buffer.from(pdf));
    },
  );
}
