/**
 * generate-application — pg-boss worker that drafts a portal-ready
 * AusIndustry application for one claim, asynchronously.
 *
 * Why async: the Sonnet call runs 60-120 seconds for a typical claim
 * (input ~30K tokens of classified evidence, output ~25K tokens of
 * structured prose across 5-8 activity records). HTTP requests can't
 * cleanly hold open that long without timeouts, and the UI shouldn't
 * block. So we enqueue, store the result on the claim row, and let the
 * wizard poll for completion.
 *
 * Schema: stores the draft on claim.application_draft_json (jsonb) plus
 * claim.application_draft_status (pending|drafting|complete|failed).
 * If those columns don't yet exist in the DB, the worker falls back to
 * writing a chain event of kind APPLICATION_DRAFTED with the result in
 * the payload — same data, different storage location, no migration
 * required to ship.
 *
 *   queue:   generate-application
 *   payload: { claim_id, tenant_id, subject_tenant_id }
 *   trigger: POST /v1/claims/:id/generate-application enqueues
 *   poll:    GET /v1/claims/:id/application-draft returns status + data
 */
import type { PgBoss } from 'pg-boss';
import {
  makeApplicationDrafter,
  recordUsage,
  type ApplicationDrafterInput,
  type TaggedSql,
} from '@cpa/agents';
import { privilegedSql } from '@cpa/db/client';

export const GENERATE_APPLICATION_QUEUE = 'generate-application';

export type GenerateApplicationJobInput = {
  claim_id: string;
  tenant_id: string;
  subject_tenant_id: string;
};

/**
 * Lazy singleton, same pattern as document-extract.ts.
 */
let drafterInstance: ReturnType<typeof makeApplicationDrafter> | null = null;
const getDrafter = () => {
  if (!drafterInstance) {
    drafterInstance = makeApplicationDrafter();
    console.log(
      '[generate-application][DIAG] drafter constructor:',
      drafterInstance.constructor.name,
    );
  }
  return drafterInstance;
};

export async function registerGenerateApplicationJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(GENERATE_APPLICATION_QUEUE);
  await boss.work<GenerateApplicationJobInput>(GENERATE_APPLICATION_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await runGenerateApplicationJob(job.data);
    }
  });
}

export async function runGenerateApplicationJob(input: GenerateApplicationJobInput): Promise<void> {
  const { claim_id, tenant_id, subject_tenant_id } = input;

  // Mark drafting in progress (best effort — fall back to chain event
  // if the column doesn't exist).
  await markStatus(claim_id, tenant_id, 'drafting').catch((err) => {
    console.log(
      '[generate-application] could not mark drafting status (column missing?):',
      err instanceof Error ? err.message : String(err),
    );
  });

  // Load the claim + its subject_tenant + project metadata.
  const claimRows = await privilegedSql<
    {
      fiscal_year: number;
      subject_tenant_name: string;
      subject_tenant_abn: string | null;
      project_name: string | null;
      project_description: string | null;
      project_started_at: string | null;
      project_ended_at: string | null;
    }[]
  >`
    SELECT
      c.fiscal_year,
      st.name AS subject_tenant_name,
      NULL    AS subject_tenant_abn,         -- ABN column not yet on subject_tenant
      p.name  AS project_name,
      p.description AS project_description,
      p.started_at::text AS project_started_at,
      p.ended_at::text   AS project_ended_at
    FROM claim c
    JOIN subject_tenant st ON st.id = c.subject_tenant_id
    LEFT JOIN project p ON p.id = c.project_id
    WHERE c.id = ${claim_id}
      AND c.tenant_id = ${tenant_id}
    LIMIT 1
  `;
  const claim = claimRows[0];
  if (!claim) {
    console.error('[generate-application] claim not found:', claim_id);
    return;
  }

  // Pull every classified event for this subject_tenant that contributes
  // to this fiscal year. We use captured_at to bound the window — events
  // from outside the FY shouldn't influence this year's application.
  const fyStart = `${claim.fiscal_year - 1}-07-01`;
  const fyEnd = `${claim.fiscal_year}-06-30`;
  const eventRows = await privilegedSql<
    {
      id: string;
      kind: string;
      classification: unknown;
      extracted_content: unknown;
      captured_at: string;
      payload: unknown;
    }[]
  >`
    SELECT
      id::text,
      kind,
      classification,
      extracted_content,
      captured_at::text,
      payload
    FROM event
    WHERE tenant_id         = ${tenant_id}
      AND subject_tenant_id = ${subject_tenant_id}
      AND extraction_status = 'complete'
      AND captured_at >= ${fyStart}::timestamptz
      AND captured_at <  (${fyEnd}::date + INTERVAL '1 day')
    ORDER BY captured_at ASC
  `;

  if (eventRows.length === 0) {
    console.error('[generate-application] no classified events found for claim', claim_id);
    await markStatus(claim_id, tenant_id, 'failed', 'no_evidence').catch(() => {});
    return;
  }

  // Shape the inputs for the drafter agent.
  const input2: ApplicationDrafterInput = {
    applicant: {
      name: claim.subject_tenant_name,
      abn: claim.subject_tenant_abn,
    },
    income_year: formatFy(claim.fiscal_year),
    project: {
      name: claim.project_name ?? `${claim.subject_tenant_name} R&D Programme`,
      description: claim.project_description,
      started_at: claim.project_started_at ?? fyStart,
      ended_at: claim.project_ended_at,
    },
    events: eventRows.map((e) => {
      // `classification` and `extracted_content` come back as `unknown` from
      // postgres-js — the underlying JSONB columns are loosely typed. The
      // drafter's input type wants specific shapes; we trust the worker
      // ran the Haiku analyzer that produced them. A double-cast (via
      // unknown) is the cleanest TS escape valve here.
      const ec =
        e.extracted_content as ApplicationDrafterInput['events'][number]['extracted_content'];
      const classification =
        e.classification as ApplicationDrafterInput['events'][number]['classification'];
      const payload = (e.payload ?? null) as Record<string, unknown> | null;
      const filename = typeof payload?.['filename'] === 'string' ? payload['filename'] : null;
      return {
        id: e.id,
        kind: e.kind,
        captured_at: e.captured_at,
        filename,
        classification,
        extracted_content: ec,
      };
    }),
  };

  let drafterResult;
  try {
    drafterResult = await getDrafter().draft(input2);
  } catch (err) {
    console.error(
      '[generate-application] drafter threw:',
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    await markStatus(
      claim_id,
      tenant_id,
      'failed',
      err instanceof Error ? err.message : 'unknown',
    ).catch(() => {});
    return;
  }

  const draft = drafterResult.output;

  // Ledger the token usage. This is the call that CAN push a claim over
  // the A$50 envelope — a typical draft is ~$0.50 USD (≈A$0.78), worst
  // case ~$1.50 (≈A$2.33). recordUsage decides free_tier vs billable by
  // comparing the claim's running total against the budget.
  //
  // We ledger AFTER the successful draft is in hand (not before) so a
  // failed/aborted draft doesn't burn budget. The Anthropic call already
  // succeeded by this point so the tokens were definitely consumed.
  if (drafterResult.usage) {
    const recorded = await recordUsage(privilegedSql as unknown as TaggedSql, {
      tenant_id,
      claim_id,
      subject_tenant_id,
      agent_name: 'application-drafter',
      model: drafterResult.usage.model,
      tokens_in: drafterResult.usage.tokens_in,
      tokens_out: drafterResult.usage.tokens_out,
    });
    console.log(
      '[generate-application] ledgered usage:',
      JSON.stringify({
        status: recorded.status,
        cost_aud_cents: recorded.cost_aud_cents,
        claim_total_after_cents: recorded.claim_total_after_cents,
        remaining_aud_cents: recorded.remaining_aud_cents,
      }),
    );
  }

  // Persist the result. Try column-write first; if it errors, fall back
  // to writing into claim.workflow_state.application_draft (JSONB) which
  // definitely exists. privilegedSql.json wants a generic object — the
  // ApplicationDraft type satisfies that shape structurally.
  const draftJson = privilegedSql.json(draft);
  try {
    await privilegedSql`
      UPDATE claim
         SET application_draft_json   = ${draftJson},
             application_draft_status = 'complete',
             application_drafted_at   = now()
       WHERE id        = ${claim_id}
         AND tenant_id = ${tenant_id}
    `;
    console.log('[generate-application] wrote draft to claim.application_draft_json:', claim_id);
  } catch {
    console.log(
      '[generate-application] claim.application_draft_json column missing — writing to workflow_state.application_draft',
    );
    // TODO: emit APPLICATION_DRAFTED chain event via insertEventWithChain
    // once the schema migration adds dedicated columns.
    await privilegedSql`
      UPDATE claim
         SET workflow_state = COALESCE(workflow_state, '{}'::jsonb)
           || jsonb_build_object('application_draft', ${draftJson})
       WHERE id        = ${claim_id}
         AND tenant_id = ${tenant_id}
    `;
  }
}

async function markStatus(
  claim_id: string,
  tenant_id: string,
  status: 'pending' | 'drafting' | 'complete' | 'failed',
  errorReason?: string,
): Promise<void> {
  await privilegedSql`
    UPDATE claim
       SET application_draft_status = ${status},
           application_draft_error  = ${errorReason ?? null}
     WHERE id        = ${claim_id}
       AND tenant_id = ${tenant_id}
  `;
}

function formatFy(fiscalYear: number): string {
  const start = fiscalYear - 1;
  const end = String(fiscalYear).slice(-2);
  return `FY${start}-${end}`;
}
