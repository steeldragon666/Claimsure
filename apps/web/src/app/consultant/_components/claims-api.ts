'use client';

/**
 * Typed fetchers for the consultant claim workflow — clients → claims →
 * the per-step approve wizard.
 *
 * Every call routes through `apiFetch` (apps/web/src/lib/api.ts), which
 * sends the cpa_session cookie (`credentials: 'include'`), parses the
 * Fastify error envelope into typed errors, and proxies `/v1/*` to the
 * API via the Next rewrite.
 *
 * The endpoints wired here all already exist in apps/api — this module is
 * the web-side contract mirror only; NO backend was added. The two
 * route files this mirrors:
 *
 *   Claims    → apps/api/src/routes/claims.ts
 *               GET  /v1/claims?subject_tenant_id=...   (scoped list)
 *               POST /v1/claims                          (create)
 *   Workflow  → apps/api/src/routes/claim-workflow.ts
 *               POST /v1/claims/:id/workflow/initialize  ("Prepare claim")
 *               GET  /v1/claims/:id/workflow             (state + canAdvance)
 *               POST /v1/claims/:id/workflow/step/:n/agree
 *               POST /v1/claims/:id/workflow/step/:n/reopen
 *
 * The two FINALIZE actions (seal + finance) below mirror endpoints being
 * built in PARALLEL — they may not exist at runtime yet. The fetchers wire
 * to the exact agreed contract; callers detect a 404 (NotFoundError) and
 * render a graceful "not available yet" state rather than crashing.
 */

import type { Claim } from '@cpa/schemas';
import { apiFetch } from '@/lib/api';

/* ───────────────────────────── Claims ──────────────────────────────── */

interface ClaimsEnvelope {
  claims: Claim[];
}
interface ClaimEnvelope {
  claim: Claim;
}

/**
 * List the claims for one client (subject_tenant). RLS already scopes to
 * the calling firm; the `subject_tenant_id` filter narrows to one client.
 * Sorted server-side by fiscal_year DESC, created_at DESC.
 */
export async function listClaimsForClient(subjectTenantId: string): Promise<Claim[]> {
  const res = await apiFetch<ClaimsEnvelope>(
    `/v1/claims?subject_tenant_id=${encodeURIComponent(subjectTenantId)}`,
  );
  return res.claims;
}

/**
 * Create a claim for a client + fiscal year. POST /v1/claims already
 * seeds `workflow_state` transactionally (every new claim is a wizard
 * claim from the moment it exists — see claims.ts INSERT), so the row
 * comes back with `is_wizard_claim === true`.
 *
 * The regulator enforces UNIQUE (subject_tenant_id, fiscal_year): one
 * claim per claimant per FY → a duplicate create returns 409 (surfaced
 * by the caller as ConflictError).
 */
export async function createClaim(subjectTenantId: string, fiscalYear: number): Promise<Claim> {
  const res = await apiFetch<ClaimEnvelope>('/v1/claims', {
    method: 'POST',
    body: JSON.stringify({ subject_tenant_id: subjectTenantId, fiscal_year: fiscalYear }),
  });
  return res.claim;
}

/* ───────────────────────────── Workflow ────────────────────────────── */

/**
 * Per-step state stored at `claim.workflow_state`. `steps['N']` is null
 * until the consultant clicks Approve on step N, at which point it records
 * who agreed and when. Keys are EXACTLY '1'..'5' (matches WorkflowState in
 * @cpa/schemas — web mirrors the shape rather than importing across the
 * package boundary).
 */
export interface WorkflowStepEntry {
  agreed_at: string;
  agreed_by: string;
}

/**
 * Financing marker written by POST /v1/claims/:id/finance. `status` is
 * currently always 'requested'; `requested_at` is the handoff stamp.
 */
export interface WorkflowFinancing {
  status: string;
  requested_at: string;
}

export interface WorkflowState {
  initialized_at: string;
  steps: {
    '1': WorkflowStepEntry | null;
    '2': WorkflowStepEntry | null;
    '3': WorkflowStepEntry | null;
    '4': WorkflowStepEntry | null;
    '5': WorkflowStepEntry | null;
  };
  /**
   * Finalize markers written by the seal/finance routes (claim-finalize.ts).
   * Present once the claim is sealed / financed — these make the lifecycle
   * READ-BACK across sessions, not just in-session. Optional because a claim
   * mid-approval carries none of them.
   */
  sealed_at?: string;
  seal_block_id?: string;
  financing?: WorkflowFinancing;
}

export type WorkflowStepKey = '1' | '2' | '3' | '4' | '5';

export type CanAdvanceResult = { ok: true } | { ok: false; reason: string };

export type NarrativeSectionStatus = 'streaming' | 'complete' | 'accepted' | 'absent';

export interface NarrativeSectionMap {
  new_knowledge: NarrativeSectionStatus;
  hypothesis: NarrativeSectionStatus;
  uncertainty: NarrativeSectionStatus;
  experiments_and_results: NarrativeSectionStatus;
}

/**
 * Shape returned by GET /v1/claims/:id/workflow. `derived.canAdvance` is
 * computed live from current claim data for each step 1..5 — this is the
 * per-step gating signal. Step 5 always returns `{ ok: false }` (terminal,
 * no step 6 to advance to) per the route's documented semantics.
 */
export interface WorkflowResponse {
  workflow_state: WorkflowState;
  derived: {
    canAdvance: Record<WorkflowStepKey, CanAdvanceResult>;
    narrativeSections: NarrativeSectionMap;
  };
}

/**
 * Fetch the per-step workflow state + the live `canAdvance` gates. Returns
 * the WorkflowResponse, or null when the claim has no workflow_state (a
 * legacy tabbed-view claim — the API returns 400 not_a_wizard_claim). The
 * caller renders that as an "initialize first" empty state.
 */
export async function getWorkflow(claimId: string): Promise<WorkflowResponse> {
  return apiFetch<WorkflowResponse>(`/v1/claims/${encodeURIComponent(claimId)}/workflow`);
}

/**
 * "Prepare claim" — first-time wizard activation. Sets
 * workflow_state.initialized_at. Idempotent at the fresh-claim boundary:
 * a claim created via POST /v1/claims is already initialized, so this is
 * only needed for legacy (NULL workflow_state) claims and returns 409 if
 * the claim already has a workflow_state.
 *
 * NOTE: the claimant-side "Prepare claim" trigger is a separate surface in
 * the MOBILE app (apps/mobile) — not built here. This is the consultant-
 * side trigger only.
 */
export async function initializeWorkflow(claimId: string): Promise<WorkflowState> {
  const res = await apiFetch<{ workflow_state: WorkflowState }>(
    `/v1/claims/${encodeURIComponent(claimId)}/workflow/initialize`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return res.workflow_state;
}

/**
 * Approve (agree) step N. Gated server-side by `canAdvance(N, snapshot)` —
 * a 409 cannot_advance comes back if the underlying data isn't ready (e.g.
 * proposed activities still pending). Re-agreeing refreshes the timestamp.
 *
 * Step 5 is terminal in canAdvance and currently 409s by design — see the
 * route comment in claim-workflow.ts. The UI treats step 5 (Review) as a
 * read-only final check rather than offering an Approve action.
 */
export async function agreeStep(claimId: string, step: WorkflowStepKey): Promise<WorkflowState> {
  const res = await apiFetch<{ workflow_state: WorkflowState }>(
    `/v1/claims/${encodeURIComponent(claimId)}/workflow/step/${step}/agree`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return res.workflow_state;
}

/**
 * Reopen (soft un-agree) step N — clears its agreed_at. No cascade:
 * downstream steps keep their agreed_at and the UI surfaces a "data
 * changed since you last agreed" hint via the live canAdvance gate.
 */
export async function reopenStep(claimId: string, step: WorkflowStepKey): Promise<WorkflowState> {
  const res = await apiFetch<{ workflow_state: WorkflowState }>(
    `/v1/claims/${encodeURIComponent(claimId)}/workflow/step/${step}/reopen`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return res.workflow_state;
}

/* ─────────────────────── Prepared content (per step) ───────────────── */

/**
 * The AI-prepared content the consultant judges per wizard step, returned
 * by GET /v1/claims/:id/prepared. This is the READ surface for the artefacts
 * the "Prepare claim" pipeline authors — the wizard renders real content
 * above each Approve button instead of the "awaiting AI preparation"
 * placeholder. Each step carries a `prepared` flag (false + empty arrays
 * when nothing has been generated yet — never fabricated). Web mirrors the
 * API shape rather than importing across the package boundary.
 */

/** Step 1 — a hypothesis + its IP / prior-art verdict. */
export interface PreparedHypothesis {
  verdict_id: string;
  activity_id: string;
  activity_code: string | null;
  activity_title: string | null;
  hypothesis_text: string;
  verdict: 'pass' | 'fail' | 'inconclusive';
  draft_verdict: 'pass' | 'fail' | 'inconclusive' | null;
  analysis_markdown: string;
  approved_at: string | null;
  status: 'draft' | 'approved';
}

/** Step 2 — a proposed Core / Supporting activity (Div 355). */
export interface PreparedActivity {
  proposed_id: string;
  kind: 'core' | 'supporting';
  title: string;
  statutory_anchor: string | null;
  hypothesis: string | null;
  technical_uncertainty: string | null;
  rationale: string | null;
  confidence: number | null;
  accepted: boolean;
  activity_id: string | null;
  activity_code: string | null;
}

/** Step 3 — a ledger expenditure mapped (or not) onto activities. */
export interface PreparedExpenditureLine {
  expenditure_id: string;
  vendor_name: string;
  reference: string | null;
  expenditure_date: string;
  total_amount: number;
  mapping_kind: 'single' | 'apportioned' | null;
  allocations: Array<{
    activity_id: string;
    activity_code: string;
    activity_title: string;
    percentage: number;
  }>;
}

/** Step 4 — an activity with the artefacts the AI bound to it. */
export interface PreparedActivityEvidence {
  activity_id: string;
  activity_code: string;
  activity_title: string;
  artefacts: Array<{
    artefact_kind: string;
    artefact_id: string;
    link_reason: string | null;
    linked_at: string;
    artefact_label: string | null;
  }>;
}

/** Step 5 — a drafted narrative section for an activity. */
export interface PreparedNarrativeSection {
  activity_id: string;
  activity_code: string;
  activity_title: string;
  section_kind: string;
  status: 'streaming' | 'complete' | 'accepted' | 'archived';
  segments: Array<{
    type: 'prose' | 'claim';
    text: string;
    citing_events: string[];
  }>;
}

export interface PreparedStep<T> {
  prepared: boolean;
  items: T[];
}

export interface PreparedContent {
  step1_hypotheses: PreparedStep<PreparedHypothesis>;
  step2_activities: PreparedStep<PreparedActivity>;
  step3_apportionment: PreparedStep<PreparedExpenditureLine> & {
    total_amount: number;
    total_mapped: number;
  };
  step4_evidence: PreparedStep<PreparedActivityEvidence>;
  step5_narrative: PreparedStep<PreparedNarrativeSection>;
  step6_review: {
    hypothesis_count: number;
    activity_count: number;
    activities_accepted: number;
    expenditure_count: number;
    expenditure_mapped: number;
    evidence_links: number;
    narrative_sections: number;
    narrative_sections_accepted: number;
  };
}

/**
 * Fetch the per-step AI-prepared content for a claim. Returns the
 * PreparedContent envelope, or surfaces a 404 (claim not found in this
 * firm) as a NotFoundError the caller can render as an empty state.
 */
export async function getPreparedContent(claimId: string): Promise<PreparedContent> {
  const res = await apiFetch<{ prepared: PreparedContent }>(
    `/v1/claims/${encodeURIComponent(claimId)}/prepared`,
  );
  return res.prepared;
}

/* ───────────────────────────── Finalize ────────────────────────────── */

/**
 * Result of POST /v1/claims/:id/seal. The claim, once all six wizard steps
 * are approved, is sealed as an append-only block on the evidence chain
 * (immutable, audit-ready — see workflow.md step 4). `block_id` is the
 * chain block the seal wrote; `sealed_at` is the stamp.
 *
 * Per CLAUDE.md the seal writes the chain block transactionally; this is a
 * web-side contract mirror only — NO backend was added here.
 */
export interface SealResult {
  ok: true;
  sealed_at: string;
  block_id: string;
}

/**
 * Seal the claim onto the evidence chain. Enabled only once ALL six wizard
 * steps are approved (the caller gates the affordance; the server gates
 * authoritatively).
 *
 * Empty body, credentials included (apiFetch always sends the cookie).
 *
 * Errors surfaced to the caller:
 *   - 409 `not_approved`  → steps still pending; show inline message.
 *   - 404                 → endpoint not deployed yet (NotFoundError);
 *                           caller renders an honest "not available yet".
 */
export async function sealClaim(claimId: string): Promise<SealResult> {
  return apiFetch<SealResult>(`/v1/claims/${encodeURIComponent(claimId)}/seal`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Result of POST /v1/claims/:id/finance. A sealed claim is submitted to the
 * financing rail so the client finances this period's R&D refund
 * (workflow.md step 5). `financing.status` is the rail's accepted state;
 * `financing.requested_at` is the submission stamp.
 */
export interface FinanceResult {
  ok: true;
  financing: {
    status: string;
    requested_at: string;
  };
}

/**
 * Submit a SEALED claim's refund to financing. Enabled only once the claim
 * is sealed (the caller gates the affordance; the server gates
 * authoritatively).
 *
 * Empty body, credentials included.
 *
 * Errors surfaced to the caller:
 *   - 409 `not_sealed`  → claim isn't sealed yet; show inline message.
 *   - 404               → endpoint not deployed yet (NotFoundError);
 *                         caller renders an honest "not available yet".
 */
export async function financeClaim(claimId: string): Promise<FinanceResult> {
  return apiFetch<FinanceResult>(`/v1/claims/${encodeURIComponent(claimId)}/finance`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
