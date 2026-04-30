import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql } from '@cpa/db/client';
import type { ExpenditureSource } from '@cpa/db/schema';
import {
  renderApportionmentReportPdf,
  renderClaimSummaryPdf,
  type ApportionmentExpenditure,
  type ApportionmentReportInput,
  type ClaimSummaryActivity,
  type ClaimSummaryInput,
} from '@cpa/documents';

/**
 * GET /v1/claims/:id/summary.pdf — claim-level summary deliverable (C7).
 *
 * Auth: requireSession; role gate (admin/consultant/viewer) — viewers can
 * download but not mutate (matches A8's activity-detail PDF gate).
 *
 * Visibility / cross-firm:
 *   - The claim lookup runs inside `sql.begin` with a `set_config` of
 *     `app.current_tenant_id` to the caller's tenant, so RLS scopes the
 *     claim row to the calling firm.
 *   - Defense-in-depth: the SQL also includes an explicit
 *     `AND tenant_id = ${tenantId}` even though RLS already constrains
 *     the row.
 *   - A miss (cross-firm or nonexistent) returns 404 (deliberately
 *     identical, no leakage of "exists in other tenant").
 *
 * Streaming:
 *   - Content-Type: application/pdf
 *   - Content-Disposition: attachment; filename="..."
 *   - Cache-Control: private, no-store (PDFs include claimant data)
 *
 * Filename: `claim-${fiscal_year}-${firm_short}-summary.pdf`. Both the
 * year and the firm slug are sanitised — any non-`[a-zA-Z0-9-]` bytes
 * collapse to `-`. The firm name is truncated to 32 chars for sanity.
 *
 * Per-activity apportioned amount aggregation (the value-add of this
 * PDF):
 *   - Sums `expenditure.total_amount` for each parent-mapped expenditure
 *     pointing at the activity (counts as 100%).
 *   - Sums `(expenditure.total_amount * allocation.percentage / 100)` for
 *     each apportionment allocation pointing at the activity.
 *   - Skips line-level mappings (those need a different join through
 *     `expenditure_line` + the existing `EXPENDITURE_LINE_MAPPED` events;
 *     deferred to F5+ when the line-level mapping UI ships).
 *
 * Today's reality: neither `EXPENDITURE_MAPPED` nor `EXPENDITURE_APPORTIONED`
 * event kinds exist (those land via the A-swimlane per C5 / C6 docs).
 * Without those events the aggregation projection sees no inputs and
 * every activity's apportioned amount is 0. The SQL is in place anyway
 * — when the events do land the PDF starts populating without further
 * code changes.
 *
 * Per-activity `artefact_count` and `uncertainty_event_count`:
 *   - The current event/media schemas don't carry `activity_id` (event
 *     has `project_id` only; media_artefact has `event_id`). A truthful
 *     per-activity count would require either a new column or a
 *     denormalised projection that we don't have today. We default to 0
 *     and document the upgrade path.
 */

interface ClaimRow {
  id: string;
  tenant_id: string;
  subject_tenant_id: string;
  fiscal_year: number;
  stage: string;
}

interface FirmRow {
  id: string;
  name: string;
}

interface SubjectTenantRow {
  id: string;
  name: string;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
}

interface ActivityRow {
  id: string;
  code: string;
  title: string;
  kind: 'core' | 'supporting';
  description: string | null;
}

interface ExpenditureSummaryRow {
  total_amount: string | number | null;
  count_total: string | number | null;
}

interface ExpenditureRow {
  id: string;
  source: ExpenditureSource;
  source_external_id: string | null;
  vendor_name: string;
  reference: string | null;
  expenditure_date: Date | string;
  total_amount: string | number;
  currency: string;
}

const isoOrNull = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null;
  return typeof v === 'string' ? v : v.toISOString();
};

/** Sanitise a string for use in a Content-Disposition filename. */
function sanitiseFilenamePart(input: string, maxLen = 32): string {
  // Keep ASCII alphanum + hyphens; collapse any other byte to `-`.
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, maxLen) || 'unknown';
}

export function registerClaimPdf(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id/summary.pdf',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant' && role !== 'viewer') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin, consultant, or viewer role required',
          requestId: req.id,
        });
      }

      const claimId = req.params.id;
      const tenantId = req.user!.tenantId!;

      const fetched = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // 1. Claim row, scoped to the firm (RLS + defense-in-depth).
        //    Cross-firm or nonexistent → empty array → 404 in the caller.
        const claimRows = await tx<ClaimRow[]>`
          SELECT id, tenant_id, subject_tenant_id, fiscal_year, stage
            FROM claim
           WHERE id = ${claimId}
             AND tenant_id = ${tenantId}
        `;
        const claim = claimRows[0];
        if (!claim) return null;

        // 2. Firm (tenant) — global table; fetch by id directly.
        const firmRows = await tx<FirmRow[]>`
          SELECT id, name FROM tenant WHERE id = ${claim.tenant_id}
        `;
        const firm = firmRows[0];
        if (!firm) return null;

        // 3. Subject tenant (claimant). RLS-scoped, deleted_at null.
        const subjectRows = await tx<SubjectTenantRow[]>`
          SELECT id, name FROM subject_tenant
           WHERE id = ${claim.subject_tenant_id} AND deleted_at IS NULL
        `;
        const subject = subjectRows[0];
        if (!subject) return null;

        // 4. Project — pick the most recently-started project for the
        //    claimant. This is a simplification: claims today have no
        //    project_id FK on `claim`, and a single claimant may have
        //    several projects. Surfacing the most-recent project gives
        //    the PDF something meaningful while a richer claim ↔ project
        //    relationship lands later. If no project exists we return a
        //    placeholder block.
        const projectRows = await tx<ProjectRow[]>`
          SELECT id, name, description, started_at, ended_at
            FROM project
           WHERE subject_tenant_id = ${claim.subject_tenant_id}
             AND archived_at IS NULL
           ORDER BY started_at DESC
           LIMIT 1
        `;
        const project = projectRows[0];

        // 5. Activities for this claim.
        const activityRows = await tx<ActivityRow[]>`
          SELECT id, code, title, kind, description
            FROM activity
           WHERE claim_id = ${claim.id}
           ORDER BY code ASC
        `;

        // 6. Expenditures summary — total spend + counts. The mapped /
        //    apportioned / unmapped split is computed against the events
        //    table once those event kinds exist. For now, the count of
        //    expenditures becomes the unmapped count (no mappings → all
        //    unmapped).
        const expSummaryRows = await tx<ExpenditureSummaryRow[]>`
          SELECT
            COALESCE(SUM(total_amount), 0) AS total_amount,
            COUNT(*)                        AS count_total
          FROM expenditure
          WHERE subject_tenant_id = ${claim.subject_tenant_id}
            AND voided_at IS NULL
        `;
        const expSummary = expSummaryRows[0] ?? { total_amount: 0, count_total: 0 };

        // TODO(A-swimlane): once `EXPENDITURE_MAPPED` and
        // `EXPENDITURE_APPORTIONED` event kinds exist, replace the zero
        // mapped/apportioned counts with a projection over those events
        // and split the count_total across the three buckets. The
        // per-activity aggregation in step 7 below also unblocks at the
        // same point.
        const mappedCount = 0;
        const apportionedCount = 0;
        const unmappedCount = Number(expSummary.count_total ?? 0);

        // 7. Per-activity apportioned amount. Today this returns 0 for
        //    every activity (no EXPENDITURE_MAPPED / EXPENDITURE_APPORTIONED
        //    events emitted yet — A-swimlane). When those events land,
        //    the projection becomes:
        //
        //      SELECT activity_id,
        //             SUM(CASE WHEN kind = 'EXPENDITURE_MAPPED'
        //                       THEN expenditure.total_amount
        //                      WHEN kind = 'EXPENDITURE_APPORTIONED'
        //                       THEN expenditure.total_amount
        //                            * (allocation.percentage / 100)
        //                 END) AS total_apportioned_amount
        //        FROM event
        //        JOIN expenditure ON expenditure.id = (event.payload->>'expenditure_id')::uuid
        //        ...
        //       GROUP BY activity_id
        //
        //    Line-level mappings (EXPENDITURE_LINE_MAPPED) join through
        //    expenditure_line and are F5+ territory.
        const apportionedByActivity = new Map<string, number>();

        return {
          claim,
          firm,
          subject,
          project,
          activities: activityRows,
          expSummary: {
            total_amount: Number(expSummary.total_amount ?? 0),
            mapped_count: mappedCount,
            apportioned_count: apportionedCount,
            unmapped_count: unmappedCount,
          },
          apportionedByActivity,
        };
      });

      if (fetched == null) {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      const projectStartedAt = fetched.project?.started_at ?? null;
      const projectEndedAt = fetched.project?.ended_at ?? null;

      const activities: ClaimSummaryActivity[] = fetched.activities.map((row) => ({
        code: row.code,
        title: row.title,
        kind: row.kind === 'core' ? ('CORE' as const) : ('SUPPORTING' as const),
        description: row.description,
        // TODO(A-swimlane): wire artefact_count + uncertainty_event_count
        // once events / media gain `activity_id` (or a denormalised
        // projection ships). See file-level comment.
        artefact_count: 0,
        uncertainty_event_count: 0,
        total_apportioned_amount: fetched.apportionedByActivity.get(row.id) ?? 0,
      }));

      const input: ClaimSummaryInput = {
        firm: { name: fetched.firm.name, abn: null },
        subject_tenant: { name: fetched.subject.name, abn: null },
        project: {
          name: fetched.project?.name ?? '(no project)',
          description: fetched.project?.description ?? null,
        },
        claim: {
          id: fetched.claim.id,
          fiscal_year: fetched.claim.fiscal_year,
          stage: fetched.claim.stage,
          started_at: isoOrNull(projectStartedAt),
          ended_at: isoOrNull(projectEndedAt),
        },
        activities,
        expenditures_summary: {
          total_amount: fetched.expSummary.total_amount,
          // AUD-only in P4 (CHECK constraint in F4); the column type is
          // open and we surface whatever the row says — but every row in
          // this tenant will be AUD.
          currency: 'AUD',
          mapped_count: fetched.expSummary.mapped_count,
          apportioned_count: fetched.expSummary.apportioned_count,
          unmapped_count: fetched.expSummary.unmapped_count,
        },
        generated_at: new Date().toISOString(),
      };

      const bytes = await renderClaimSummaryPdf(input);

      const firmShort = sanitiseFilenamePart(fetched.firm.name);
      const fyShort = sanitiseFilenamePart(String(fetched.claim.fiscal_year), 8);
      const filename = `claim-${fyShort}-${firmShort}-summary.pdf`;

      void reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'private, no-store');
      // Send the raw bytes (Buffer-wrapped so Fastify routes it directly
      // to the underlying response without serialising as JSON).
      return reply.send(Buffer.from(bytes));
    },
  );

  /**
   * GET /v1/claims/:id/apportionment.pdf — apportionment report (C9).
   *
   * Same auth + cross-firm + streaming model as `summary.pdf` above:
   *   - admin/consultant/viewer can download
   *   - claim lookup runs inside `sql.begin` with `set_config` of
   *     `app.current_tenant_id` so RLS scopes the row; explicit
   *     `AND tenant_id = ${tenantId}` is defense-in-depth
   *   - cross-firm or nonexistent => 404 (identical messages, no leakage)
   *   - Content-Type: application/pdf
   *   - Content-Disposition: attachment; filename="..."
   *   - Cache-Control: private, no-store
   *
   * Filename: `apportionment-${fiscal_year}-${firm_short}.pdf` (per spec).
   *
   * Mapping/apportionment projection (today's reality):
   *   Neither EXPENDITURE_MAPPED nor EXPENDITURE_APPORTIONED event
   *   kinds exist yet (deferred to A-swimlane per C5/C6 docs). Without
   *   those events the projection sees no inputs and EVERY expenditure
   *   resolves to `{ type: 'unmapped' }`. The activity rollup is
   *   therefore empty and the totals reflect 100% unmapped.
   *
   *   The PDF still renders — that's the point of the document. It
   *   shows the pre-A-swimlane baseline so a later implementer can
   *   diff "before vs after events land". When EXPENDITURE_MAPPED /
   *   EXPENDITURE_APPORTIONED events do arrive, the projection
   *   replaces the zero-state branch below and the activity_rollup
   *   gains real entries — without API surface change.
   *
   *   The activity rollup CTE in step 6 is therefore a simple "no
   *   activities, no expenditures contribute" placeholder today; once
   *   events land, it grows into the GROUP BY documented in summary's
   *   step 7 comment.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/claims/:id/apportionment.pdf',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant' && role !== 'viewer') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin, consultant, or viewer role required',
          requestId: req.id,
        });
      }

      const claimId = req.params.id;
      const tenantId = req.user!.tenantId!;

      const fetched = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        // 1. Claim row, scoped to the firm (RLS + defense-in-depth).
        //    Cross-firm or nonexistent → empty array → 404 in the caller.
        const claimRows = await tx<ClaimRow[]>`
          SELECT id, tenant_id, subject_tenant_id, fiscal_year, stage
            FROM claim
           WHERE id = ${claimId}
             AND tenant_id = ${tenantId}
        `;
        const claim = claimRows[0];
        if (!claim) return null;

        // 2. Firm (tenant) — global table; fetch by id directly.
        const firmRows = await tx<FirmRow[]>`
          SELECT id, name FROM tenant WHERE id = ${claim.tenant_id}
        `;
        const firm = firmRows[0];
        if (!firm) return null;

        // 3. Subject tenant (claimant). RLS-scoped, deleted_at null.
        const subjectRows = await tx<SubjectTenantRow[]>`
          SELECT id, name FROM subject_tenant
           WHERE id = ${claim.subject_tenant_id} AND deleted_at IS NULL
        `;
        const subject = subjectRows[0];
        if (!subject) return null;

        // 4. Project — same most-recent-by-started_at simplification as
        //    summary.pdf. Claims today have no project_id FK.
        const projectRows = await tx<ProjectRow[]>`
          SELECT id, name, description, started_at, ended_at
            FROM project
           WHERE subject_tenant_id = ${claim.subject_tenant_id}
             AND archived_at IS NULL
           ORDER BY started_at DESC
           LIMIT 1
        `;
        const project = projectRows[0];

        // 5. Expenditures — every row scoped to the claim's subject
        //    tenant, voided rows excluded. Sorted by date ASC then id
        //    so the rendered detail table is deterministic across runs
        //    (the secondary id sort breaks ties when several
        //    expenditures share the same date — a common case in
        //    practice e.g. all rows from one Xero sync batch).
        const expenditureRows = await tx<ExpenditureRow[]>`
          SELECT id, source, source_external_id, vendor_name, reference,
                 expenditure_date, total_amount, currency
            FROM expenditure
           WHERE subject_tenant_id = ${claim.subject_tenant_id}
             AND voided_at IS NULL
           ORDER BY expenditure_date ASC, id ASC
        `;

        return { claim, firm, subject, project, expenditureRows };
      });

      if (fetched == null) {
        return reply.status(404).send({
          error: 'claim_not_found',
          message: 'No claim with that id in this firm',
          requestId: req.id,
        });
      }

      // Transform DB rows into the @cpa/documents input shape.
      //
      // Source classification: the four DB sources collapse to three
      // PDF kinds — see `classifyKind` below for the canonical mapping
      // (and the cross-swimlane note documenting `manual` → `RECEIPT`).
      const expenditures: ApportionmentExpenditure[] = fetched.expenditureRows.map((r) => ({
        id: r.id,
        kind: classifyKind(r.source),
        date:
          r.expenditure_date instanceof Date
            ? r.expenditure_date.toISOString()
            : r.expenditure_date,
        payee: r.vendor_name,
        reference: r.reference,
        amount: Number(r.total_amount),
        currency: r.currency,
        // TODO(A-swimlane): replace with a real projection over
        // EXPENDITURE_MAPPED / EXPENDITURE_APPORTIONED events. Today
        // those event kinds don't exist; everything is unmapped. Once
        // they land, this becomes:
        //
        //   const apportioned = apportionedById.get(r.id);
        //   if (apportioned) return { type: 'apportioned', allocations };
        //   const mapped = mappedById.get(r.id);
        //   if (mapped) return { type: 'mapped', activity_code, activity_title };
        //   return { type: 'unmapped' };
        //
        // (Mirrors the projection rules in
        // `apps/web/src/app/claims/[claim_id]/_lib/expenditure-projection.ts`
        // and the row-UI composition order: line > apportionment >
        // parent > unmapped.)
        mapping_state: { type: 'unmapped' as const },
      }));

      // Totals roll up directly from the projected expenditures. With
      // every row unmapped today: total_apportioned === 0, total_unmapped
      // === total_expenditure, and total_unmapped_count === expenditures.
      // length. Once mappings land the same arithmetic produces real
      // numbers without code changes — the projection above is the only
      // place that needs to flip from stubbed-zero to real data.
      const totalExpenditure = expenditures.reduce((acc, e) => acc + e.amount, 0);
      const totalApportioned = expenditures.reduce((acc, e) => {
        if (e.mapping_state.type === 'unmapped') return acc;
        if (e.mapping_state.type === 'mapped') return acc + e.amount;
        return acc + e.mapping_state.allocations.reduce((s, a) => s + a.amount, 0);
      }, 0);
      const totalUnmappedCount = expenditures.filter(
        (e) => e.mapping_state.type === 'unmapped',
      ).length;
      const totalUnmapped = expenditures.reduce(
        (acc, e) => (e.mapping_state.type === 'unmapped' ? acc + e.amount : acc),
        0,
      );

      // Activity rollup — derived from the mapping_state aggregation.
      // Today every expenditure is unmapped so the rollup is empty.
      // When events land, walk the expenditures and accumulate per-
      // activity counts + amounts (one entry per distinct activity
      // code, even if multiple expenditures map there).
      //
      // TODO(C9-followup-kind): when EXPENDITURE_MAPPED events emit, the
      // route should join `activity` (by claim_id + code) to populate
      // `activity_kind` on each mapping_state.mapped /
      // mapping_state.apportioned.allocations entry. Until then, the
      // rollup is empty (no events, no rows), so the placeholder is
      // unreachable in production but rendered correctly in tests with
      // synthetic input. The renderer falls back to '—' (em dash) when
      // kind is undefined rather than silently relabelling SUPPORTING
      // activities as 'Core'.
      const rollupMap = new Map<
        string,
        {
          code: string;
          title: string;
          kind?: 'CORE' | 'SUPPORTING';
          count: number;
          amount: number;
        }
      >();
      // The TODO above will populate this map; today the loop is a
      // no-op because every mapping_state.type === 'unmapped'.
      //
      // `kind` is set conditionally (spread on the literal) so an
      // undefined value doesn't surface as an explicit `kind: undefined`
      // property — the workspace runs `exactOptionalPropertyTypes: true`,
      // which rejects that shape against the optional-`kind?:` rollup
      // entry type.
      for (const e of expenditures) {
        if (e.mapping_state.type === 'mapped') {
          const key = e.mapping_state.activity_code;
          const existing = rollupMap.get(key);
          if (existing) {
            existing.count += 1;
            existing.amount += e.amount;
          } else {
            const kind = e.mapping_state.activity_kind;
            rollupMap.set(key, {
              code: e.mapping_state.activity_code,
              title: e.mapping_state.activity_title,
              // Pass through whatever the upstream mapping carries; the
              // route join (TODO above) will populate this once events
              // land. Today: undefined → renderer shows em-dash.
              ...(kind !== undefined ? { kind } : {}),
              count: 1,
              amount: e.amount,
            });
          }
        } else if (e.mapping_state.type === 'apportioned') {
          for (const alloc of e.mapping_state.allocations) {
            const existing = rollupMap.get(alloc.activity_code);
            if (existing) {
              existing.count += 1;
              existing.amount += alloc.amount;
            } else {
              const kind = alloc.activity_kind;
              rollupMap.set(alloc.activity_code, {
                code: alloc.activity_code,
                title: alloc.activity_title,
                ...(kind !== undefined ? { kind } : {}),
                count: 1,
                amount: alloc.amount,
              });
            }
          }
        }
      }
      const activityRollup = Array.from(rollupMap.values())
        .map((r) => ({
          code: r.code,
          title: r.title,
          // Conditionally include `kind` so undefined doesn't surface as
          // an explicit `kind: undefined` property under
          // exactOptionalPropertyTypes (renderer treats absence and
          // explicit-undefined identically; this keeps the wire shape
          // clean and the type narrow).
          ...(r.kind !== undefined ? { kind: r.kind } : {}),
          expenditure_count: r.count,
          total_amount: r.amount,
        }))
        .sort((a, b) => a.code.localeCompare(b.code));

      const input: ApportionmentReportInput = {
        firm: { name: fetched.firm.name, abn: null },
        subject_tenant: { name: fetched.subject.name, abn: null },
        project: {
          name: fetched.project?.name ?? '(no project)',
          description: fetched.project?.description ?? null,
        },
        claim: {
          fiscal_year: fetched.claim.fiscal_year,
          stage: fetched.claim.stage,
        },
        expenditures,
        activity_rollup: activityRollup,
        totals: {
          total_expenditure: totalExpenditure,
          total_apportioned: totalApportioned,
          total_unmapped: totalUnmapped,
          total_unmapped_count: totalUnmappedCount,
          // AUD-only in P4 (CHECK constraint in F4); the column type is
          // open and we surface whatever the row says — but every row in
          // this tenant will be AUD.
          currency: 'AUD',
        },
        generated_at: new Date().toISOString(),
      };

      const bytes = await renderApportionmentReportPdf(input);

      const firmShort = sanitiseFilenamePart(fetched.firm.name);
      const fyShort = sanitiseFilenamePart(String(fetched.claim.fiscal_year), 8);
      const filename = `apportionment-${fyShort}-${firmShort}.pdf`;

      void reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'private, no-store');
      return reply.send(Buffer.from(bytes));
    },
  );
}

/**
 * Map the DB-level `source` enum to the PDF's `kind` discriminator.
 *
 * Four DB values collapse to three PDF kinds:
 *   - xero_invoice → INVOICE
 *   - xero_bank_tx → BANK_TX
 *   - xero_receipt → RECEIPT
 *   - manual       → RECEIPT (see comment in the `manual` arm below
 *     for the cross-swimlane reconciliation rationale)
 *
 * The regulator-facing document doesn't distinguish "manual vs Xero"
 * origin — that's an audit-trail concern carried by `source` itself,
 * not the document kind. The collapse keeps the PDF column terse.
 *
 * `source` is typed as `ExpenditureSource` (the enum from `@cpa/db`)
 * rather than a loose `string`. When a future migration adds a 5th
 * source value, the typecheck fails at this site and forces an
 * explicit decision.
 */
function classifyKind(source: ExpenditureSource): 'INVOICE' | 'BANK_TX' | 'RECEIPT' {
  switch (source) {
    case 'xero_bank_tx':
      return 'BANK_TX';
    case 'xero_receipt':
      return 'RECEIPT';
    case 'xero_invoice':
      return 'INVOICE';
    case 'manual':
      // 'manual' source maps to 'RECEIPT' kind. This was reconciled
      // across swimlanes during the P4 merge — see
      // docs/decisions/0006-p4-merge-plan.md section 4.1. The
      // rationale: manual entries are user-captured proof (closer to
      // a receipt than a vendor-issued invoice). Both this file and
      // preview-rules.ts must agree.
      return 'RECEIPT';
  }
}
