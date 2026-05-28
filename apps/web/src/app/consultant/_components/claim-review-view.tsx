'use client';

/**
 * Claim review wizard — the consultant's per-step APPROVAL surface.
 *
 * Per docs/product/workflow.md (LOCKED): the claimant captures evidence and
 * triggers "Prepare claim"; the AI prepares the claim; the consultant
 * renders judgement by approving it step-by-step. The consultant approves,
 * they do not author.
 *
 * IA position: Clients → Client → CLAIMS list → **Claim** (this view).
 *
 * Gating model (the real wiring):
 *   - GET /v1/claims/:id/workflow returns { workflow_state, derived } where
 *     `derived.canAdvance['N']` is computed LIVE from claim data per step,
 *     and `workflow_state.steps['N']` records who approved step N and when.
 *   - A step's Approve action is enabled iff its canAdvance gate is ok.
 *   - Step N+1 unlocks only once step N is approved (steps['N'] !== null).
 *     NO "approve all" — judgement is per-step by design.
 *   - The engagement letter gates the entire wizard: until the client's
 *     engagement is signed + countersigned, every step renders locked
 *     behind the ENGAGEMENT REQUIRED overlay (Wizard Step 1's backing
 *     feature, already wired via <EngagementPanel> + isEngagementUnblocked).
 *
 * Step model — the 6 spec steps map onto the backend's 5 agree-able
 * workflow steps + the terminal Review:
 *
 *   Spec step (UI)        backend canAdvance gate (claim-workflow.ts)
 *   ───────────────────   ─────────────────────────────────────────────
 *   1 Hypotheses          step 1 — ≥1 classified evidence event
 *   2 Activities          step 2 — every proposed activity agreed/rejected
 *   3 Apportionment       step 3 — every agreed activity has bound evidence
 *   4 Evidence            step 4 — narrative sections approved (*)
 *   5 Narrative           step 5 — terminal (no further advance)
 *   6 Review              all five steps approved → seal → finance
 *
 *   (*) The backend's 5-step machine predates the 6-label product spec, so
 *   gates 4/5 don't line up 1:1 with the Evidence/Narrative labels. The
 *   gating is still REAL — it reads canAdvance/steps from the API — but the
 *   underlying advance condition for a given label is whatever the backend
 *   computes. See the README note in the PR; a backend re-label to 6 steps
 *   would tighten this. We never fabricate step content: where the
 *   AI-prepared artefact for a step isn't yet exposed by an API, the step
 *   renders an honest "awaiting AI preparation" panel.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { Claim } from '@cpa/schemas';
import { ConflictError, NotFoundError } from '@/lib/api';
import {
  amber,
  amberSoft,
  bone,
  bone2,
  bone3,
  bone4,
  fMono,
  fSans,
  fSerif,
  ink,
  ink2,
  ink3,
  rule,
  ruleStrong,
  rust,
  sage,
} from './tokens';
import { Check, Diamond, MonoLabel, StatusPill, type StatusKind } from './atoms';
import { EngagementPanel, isEngagementUnblocked } from './engagement-panel';
import { useClaimEngagement } from '@/lib/hooks/use-claim-engagement';
import {
  useAgreeStep,
  useClaimWorkflow,
  useFinanceClaim,
  useInitializeWorkflow,
  useReopenStep,
  useSealClaim,
} from '@/lib/hooks/use-claim-workflow';
import type { FinanceResult, SealResult, WorkflowStepKey } from './claims-api';

/**
 * UI lifecycle a claim moves through in this view:
 *   drafting  → approving the six wizard steps (not all approved yet)
 *   approved  → all six approved, ready to SEAL
 *   sealed    → sealed onto the chain (block written); ready to FINANCE
 *   financing → refund submitted to the financing rail
 *
 * Seal/finance are not yet readable via any GET (the Claim row carries no
 * seal/finance columns), so the sealed/financing states are tracked LIVE
 * from the POST results within this session. When the consultant reopens
 * the claim later, the badge derives only from workflow_state (drafting /
 * approved) — an honest reflection of what the API exposes today.
 */
type ClaimLifecycle = 'drafting' | 'approved' | 'sealed' | 'financing';

const LIFECYCLE_PILL: Record<ClaimLifecycle, StatusKind> = {
  drafting: 'review',
  approved: 'approved',
  sealed: 'sealed',
  financing: 'financing',
};

interface ClaimReviewViewProps {
  claim: Claim;
  clientName: string;
  /** Back to this client's claims list. */
  onBack: () => void;
}

/** Australian FY label: fiscal_year 2026 → "FY26". */
function fyLabel(fiscalYear: number): string {
  return `FY${String(fiscalYear).slice(-2)}`;
}

interface StepDef {
  /** Backend workflow step this UI step approves (1..5). */
  key: WorkflowStepKey;
  /** 1-based UI ordinal. */
  ordinal: number;
  label: string;
  /** The judgement question shown in the step header. */
  question: string;
  /** Short note on what the AI prepares for this step. */
  prepares: string;
}

const STEP_DEFS: StepDef[] = [
  {
    key: '1',
    ordinal: 1,
    label: 'HYPOTHESES',
    question: 'What did the company set out to learn?',
    prepares:
      'The AI classified captured evidence and ran an IP / prior-art search per hypothesis.',
  },
  {
    key: '2',
    ordinal: 2,
    label: 'ACTIVITIES',
    question: 'Which work is Core? Which is Supporting?',
    prepares: 'The AI drafted Core vs Supporting activities against Division 355.',
  },
  {
    key: '3',
    ordinal: 3,
    label: 'APPORTIONMENT',
    question: 'How does the ledger map to the activities?',
    prepares: 'The AI apportioned the connected accounting ledger onto the activities.',
  },
  {
    key: '4',
    ordinal: 4,
    label: 'EVIDENCE',
    question: 'What artefacts prove each activity?',
    prepares: 'The AI bound captured artefacts to the activities they evidence.',
  },
  {
    key: '5',
    ordinal: 5,
    label: 'NARRATIVE',
    question: 'Does the cited technical narrative hold up?',
    prepares: 'The AI drafted the cited technical narrative for each activity.',
  },
];

const REVIEW_ORDINAL = 6;

export function ClaimReviewView({ claim, clientName, onBack }: ClaimReviewViewProps) {
  const claimId = claim.id;
  const fy = fyLabel(claim.fiscal_year);

  // Engagement gate — until signed/countersigned the whole wizard is locked.
  const { data: engagement } = useClaimEngagement(claimId);
  const downstreamUnlocked = isEngagementUnblocked(engagement?.status);

  // Per-step state machine + live canAdvance gates.
  const { data: workflow, isLoading, error, notInitialized } = useClaimWorkflow(claimId);
  const initialize = useInitializeWorkflow(claimId);

  const approvedKeys = useMemo(() => {
    const set = new Set<WorkflowStepKey>();
    if (workflow) {
      (['1', '2', '3', '4', '5'] as WorkflowStepKey[]).forEach((k) => {
        if (workflow.workflow_state.steps[k]) set.add(k);
      });
    }
    return set;
  }, [workflow]);

  const allApproved = approvedKeys.size === STEP_DEFS.length;

  // ── Finalize actions (seal → finance). The hooks bubble 404
  // (NotFoundError) so we render an honest "not available yet" state instead
  // of crashing if the endpoints aren't deployed.
  const seal = useSealClaim(claimId);
  const finance = useFinanceClaim(claimId);
  // Live POST results captured this session.
  const [sealLive, setSealLive] = useState<SealResult | null>(null);
  const [financeLive, setFinanceLive] = useState<FinanceResult | null>(null);

  // The seal/finance markers are persisted on workflow_state (claim-finalize
  // writes sealed_at / seal_block_id / financing), so the lifecycle READS
  // BACK across sessions — a reopened sealed claim renders sealed without a
  // fresh POST. Prefer the persisted marker; fall back to this session's
  // live POST result.
  const persisted = workflow?.workflow_state;
  const sealResult: SealResult | null =
    sealLive ??
    (persisted?.sealed_at
      ? { ok: true, sealed_at: persisted.sealed_at, block_id: persisted.seal_block_id ?? '' }
      : null);
  const financeResult: FinanceResult | null =
    financeLive ?? (persisted?.financing ? { ok: true, financing: persisted.financing } : null);

  const sealed = sealResult !== null;
  const financed = financeResult !== null;

  const lifecycle: ClaimLifecycle = financed
    ? 'financing'
    : sealed
      ? 'sealed'
      : allApproved
        ? 'approved'
        : 'drafting';

  // Once sealed, the claim is immutable — the per-step wizard goes
  // read-only (approvals + reopen are locked).
  const wizardReadOnly = sealed;

  const onSeal = () => seal.mutate(undefined, { onSuccess: (res) => setSealLive(res) });
  const onFinance = () => finance.mutate(undefined, { onSuccess: (res) => setFinanceLive(res) });

  // The active step the consultant is reviewing. Until they manually pick a
  // step (selectedOrdinal), we derive it: the lowest not-yet-approved step,
  // or the terminal Review step once all five are approved. This keeps the
  // wizard auto-advancing as approvals land without an effect/state sync.
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(null);
  const derivedOrdinal = (() => {
    const firstUnapproved = STEP_DEFS.find((s) => !approvedKeys.has(s.key));
    return firstUnapproved ? firstUnapproved.ordinal : REVIEW_ORDINAL;
  })();
  const activeOrdinal = selectedOrdinal ?? derivedOrdinal;
  const setActiveOrdinal = setSelectedOrdinal;

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 28 }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          marginBottom: 22,
        }}
      >
        <div>
          <button
            type="button"
            onClick={onBack}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: fMono,
              fontSize: 10,
              letterSpacing: '0.16em',
              color: bone3,
              marginBottom: 12,
            }}
          >
            ← {clientName.toUpperCase()} · CLAIMS
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <MonoLabel size={10} color={amber}>
              {fy}
            </MonoLabel>
            <span style={{ width: 24, height: 1, background: ruleStrong }} />
            <MonoLabel size={10} color={bone3}>
              {clientName.toUpperCase()}
            </MonoLabel>
            <StatusPill kind={LIFECYCLE_PILL[lifecycle]} />
          </div>
          <h1
            style={{
              fontFamily: fSerif,
              fontWeight: 300,
              fontSize: 34,
              lineHeight: 1,
              letterSpacing: '-0.025em',
              color: bone,
              margin: '14px 0 0',
            }}
          >
            {clientName} — {fy} R&amp;DTI claim
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {sealed && sealResult && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Diamond size={7} color={amber} />
              <MonoLabel size={9.5} color={amber}>
                SEALED · {sealResult.block_id.slice(0, 10)}
              </MonoLabel>
            </span>
          )}
        </div>
      </div>

      {/* Step 1 backing feature — Engagement Letter panel. */}
      <EngagementPanel claimId={claimId} claimantName={clientName} fiscalYearLabel={fy} />

      {/* Step rail (6 spec steps: 5 approve-able + terminal Review). */}
      <StepRail
        activeOrdinal={activeOrdinal}
        approvedKeys={approvedKeys}
        allApproved={allApproved}
        onSelect={setActiveOrdinal}
      />

      {/* Workflow body, gated behind the engagement overlay. */}
      <div style={{ position: 'relative' }}>
        <div
          style={{
            opacity: downstreamUnlocked ? 1 : 0.35,
            pointerEvents: downstreamUnlocked ? 'auto' : 'none',
            filter: downstreamUnlocked ? 'none' : 'grayscale(0.4)',
            transition: 'opacity 120ms ease, filter 120ms ease',
          }}
          aria-hidden={!downstreamUnlocked}
        >
          {isLoading && <CenteredNote>Loading the prepared claim…</CenteredNote>}

          {!isLoading && notInitialized && (
            <NotInitializedPanel
              pending={initialize.isPending}
              error={initialize.error}
              onPrepare={() => initialize.mutate()}
            />
          )}

          {!isLoading && error && !notInitialized && (
            <CenteredNote tone="error">
              Couldn&rsquo;t load the claim workflow. {error.message}
            </CenteredNote>
          )}

          {!isLoading && workflow && (
            <>
              {activeOrdinal <= STEP_DEFS.length ? (
                <WizardStep
                  claimId={claimId}
                  def={STEP_DEFS[activeOrdinal - 1]!}
                  approvedKeys={approvedKeys}
                  canAdvance={workflow.derived.canAdvance[STEP_DEFS[activeOrdinal - 1]!.key]}
                  agreedAt={
                    workflow.workflow_state.steps[STEP_DEFS[activeOrdinal - 1]!.key]?.agreed_at ??
                    null
                  }
                  readOnly={wizardReadOnly}
                  // Drop the manual pin on approve so the wizard auto-advances
                  // to the next unapproved step (derivedOrdinal takes over).
                  onApproved={() => setSelectedOrdinal(null)}
                />
              ) : (
                <ReviewStep
                  allApproved={allApproved}
                  approvedCount={approvedKeys.size}
                  lifecycle={lifecycle}
                  sealResult={sealResult}
                  financeResult={financeResult}
                  seal={{
                    onSeal,
                    pending: seal.isPending,
                    error: seal.error,
                  }}
                  finance={{
                    onFinance,
                    pending: finance.isPending,
                    error: finance.error,
                  }}
                />
              )}
            </>
          )}
        </div>
        {!downstreamUnlocked && <EngagementRequiredOverlay />}
      </div>
    </div>
  );
}

/* ───────────────────────────── Step rail ───────────────────────────── */

function StepRail({
  activeOrdinal,
  approvedKeys,
  allApproved,
  onSelect,
}: {
  activeOrdinal: number;
  approvedKeys: Set<WorkflowStepKey>;
  allApproved: boolean;
  onSelect: (ordinal: number) => void;
}) {
  // A step is reachable if it's step 1, OR the previous step is approved.
  const isUnlocked = (ordinal: number): boolean => {
    if (ordinal === 1) return true;
    const prev = STEP_DEFS[ordinal - 2];
    if (!prev) return allApproved; // Review (ordinal 6) unlocks when all approved
    return approvedKeys.has(prev.key);
  };

  const labels: { ordinal: number; label: string; key?: WorkflowStepKey }[] = [
    ...STEP_DEFS.map((s) => ({ ordinal: s.ordinal, label: s.label, key: s.key })),
    { ordinal: REVIEW_ORDINAL, label: 'REVIEW' },
  ];

  const approvedCount = approvedKeys.size;

  return (
    <div
      style={{
        background: ink2,
        border: `1px solid ${ruleStrong}`,
        borderRadius: 4,
        padding: '18px 22px',
        marginBottom: 18,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <MonoLabel size={10} color={bone3}>
          WIZARD · STEP {String(activeOrdinal).padStart(2, '0')} / 06
        </MonoLabel>
        <MonoLabel size={10} color={bone3}>
          {approvedCount} OF 5 STEPS APPROVED
        </MonoLabel>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {labels.map((l) => {
          const approved = l.key ? approvedKeys.has(l.key) : allApproved;
          const active = l.ordinal === activeOrdinal;
          return (
            <div
              key={l.ordinal}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                background: approved ? amber : active ? amberSoft : rule,
              }}
            />
          );
        })}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          marginTop: 12,
          gap: 12,
        }}
      >
        {labels.map((l) => {
          const approved = l.key ? approvedKeys.has(l.key) : allApproved;
          const active = l.ordinal === activeOrdinal;
          const unlocked = isUnlocked(l.ordinal);
          return (
            <button
              key={l.ordinal}
              type="button"
              disabled={!unlocked}
              onClick={() => unlocked && onSelect(l.ordinal)}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: unlocked ? 'pointer' : 'not-allowed',
                padding: 0,
                textAlign: 'left',
                opacity: unlocked ? 1 : 0.45,
              }}
            >
              <div
                style={{
                  fontFamily: fMono,
                  fontSize: 10,
                  letterSpacing: '0.16em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: active ? amber : approved ? bone2 : bone4,
                }}
              >
                {approved && <Check size={11} color={amber} />}
                {String(l.ordinal).padStart(2, '0')} · {l.label}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────────────────── Wizard step ─────────────────────────── */

function WizardStep({
  claimId,
  def,
  approvedKeys,
  canAdvance,
  agreedAt,
  readOnly,
  onApproved,
}: {
  claimId: string;
  def: StepDef;
  approvedKeys: Set<WorkflowStepKey>;
  canAdvance: { ok: true } | { ok: false; reason: string };
  agreedAt: string | null;
  /** Sealed claims are immutable — approvals + reopen are locked. */
  readOnly: boolean;
  onApproved: () => void;
}) {
  const agree = useAgreeStep(claimId);
  const reopen = useReopenStep(claimId);

  // This step is reachable only if the prior step is approved (or it's
  // step 1). The rail already gates selection, but we belt-and-suspender it.
  const priorApproved =
    def.ordinal === 1 || approvedKeys.has(STEP_DEFS[def.ordinal - 2]!.key);

  const approved = agreedAt !== null;
  const conflictReason =
    agree.error instanceof ConflictError ? agree.error.message : null;

  return (
    <div style={{ background: ink2, border: `1px solid ${ruleStrong}`, borderRadius: 4 }}>
      <div style={{ padding: '18px 22px', borderBottom: `1px solid ${rule}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <MonoLabel size={11}>
            STEP {String(def.ordinal).padStart(2, '0')} · {def.label}
          </MonoLabel>
          {approved && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Check size={13} color={sage} />
              <MonoLabel size={9.5} color={sage}>
                APPROVED
              </MonoLabel>
            </span>
          )}
        </div>
        <div
          style={{
            fontFamily: fSerif,
            fontWeight: 400,
            fontSize: 24,
            lineHeight: 1.25,
            letterSpacing: '-0.01em',
            color: bone,
            margin: '10px 0 0',
          }}
        >
          {def.question}
        </div>
        <div style={{ fontFamily: fSans, fontSize: 13.5, color: bone3, marginTop: 8 }}>
          {def.prepares}
        </div>
      </div>

      {/* Prepared-content surface.
          The AI-prepared artefact for each step is produced by backend jobs
          (claim-activity-proposal, claim-evidence-binding, narrative drafter)
          but is not yet exposed through a single per-step read API. Rather
          than fabricate content, we present the live readiness signal from
          canAdvance — which IS derived from the prepared data — plus an
          honest "awaiting AI preparation" state when the gate isn't met. */}
      <div style={{ padding: '20px 22px' }}>
        {!priorApproved ? (
          <Locked reason={`Approve step ${def.ordinal - 1} first to unlock this step.`} />
        ) : canAdvance.ok ? (
          <ReadyPanel label={def.label} approved={approved} />
        ) : (
          <AwaitingPanel reason={canAdvance.reason} />
        )}
      </div>

      {/* Footer — the per-step Approve action. */}
      <div
        style={{
          padding: '16px 22px',
          borderTop: `1px solid ${ruleStrong}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 14,
        }}
      >
        <div style={{ fontFamily: fMono, fontSize: 10, color: bone4, letterSpacing: '0.08em' }}>
          {readOnly
            ? `SEALED — READ ONLY${agreedAt ? ` · APPROVED ${formatTs(agreedAt)}` : ''}`
            : approved && agreedAt
              ? `APPROVED ${formatTs(agreedAt)}`
              : 'CONSULTANT JUDGEMENT REQUIRED — APPROVE TO UNLOCK THE NEXT STEP'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {conflictReason && <ErrorText>{conflictReason}</ErrorText>}
          {agree.error && !conflictReason && <ErrorText>Approve failed. Try again.</ErrorText>}
          {readOnly ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Diamond size={6} color={amber} />
              <MonoLabel size={9.5} color={amber}>
                LOCKED ON CHAIN
              </MonoLabel>
            </span>
          ) : approved ? (
            <button
              type="button"
              onClick={() => reopen.mutate(def.key)}
              disabled={reopen.isPending}
              style={ghostBtn(reopen.isPending)}
            >
              {reopen.isPending ? 'REOPENING…' : 'REOPEN'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => agree.mutate(def.key, { onSuccess: onApproved })}
              disabled={!priorApproved || !canAdvance.ok || agree.isPending}
              style={primaryBtn(!priorApproved || !canAdvance.ok || agree.isPending)}
            >
              {agree.isPending ? 'APPROVING…' : `APPROVE ${def.label}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── Review step ─────────────────────────── */

interface FinalizeAction {
  pending: boolean;
  error: Error | null;
}

function ReviewStep({
  allApproved,
  approvedCount,
  lifecycle,
  sealResult,
  financeResult,
  seal,
  finance,
}: {
  allApproved: boolean;
  approvedCount: number;
  lifecycle: ClaimLifecycle;
  sealResult: SealResult | null;
  financeResult: FinanceResult | null;
  seal: FinalizeAction & { onSeal: () => void };
  finance: FinalizeAction & { onFinance: () => void };
}) {
  const sealed = lifecycle === 'sealed' || lifecycle === 'financing';
  const financed = lifecycle === 'financing';

  return (
    <div style={{ background: ink2, border: `1px solid ${ruleStrong}`, borderRadius: 4 }}>
      <div style={{ padding: '18px 22px', borderBottom: `1px solid ${rule}` }}>
        <MonoLabel size={11}>STEP 06 · REVIEW</MonoLabel>
        <div
          style={{
            fontFamily: fSerif,
            fontWeight: 400,
            fontSize: 24,
            color: bone,
            margin: '10px 0 0',
          }}
        >
          Anything to flag before sign-off?
        </div>
        <div style={{ fontFamily: fSans, fontSize: 13.5, color: bone3, marginTop: 8 }}>
          Final check. Once every step is approved the claim is sealed onto the evidence chain, then
          its refund is submitted to financing.
        </div>
      </div>

      <div style={{ padding: '22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!allApproved && (
          <AwaitingPanel
            reason={`${approvedCount} of 5 steps approved — approve the remaining ${5 - approvedCount} to unlock sealing.`}
          />
        )}

        {/* Terminal action 1 — SEAL. */}
        <FinalizeRow
          ordinal="A"
          title="Seal onto the evidence chain"
          body="Writes an immutable, audit-ready block. Available once all steps are approved."
        >
          {sealed && sealResult ? (
            <SealedState result={sealResult} />
          ) : (
            <FinalizeButton
              label="SEAL CLAIM"
              pendingLabel="SEALING…"
              enabled={allApproved}
              disabledHint="Approve all steps first"
              pending={seal.pending}
              error={seal.error}
              conflictReason={conflictReasonFor(seal.error, 'not_approved')}
              onClick={seal.onSeal}
            />
          )}
        </FinalizeRow>

        {/* Terminal action 2 — FINANCE. */}
        <FinalizeRow
          ordinal="B"
          title="Finance the refund"
          body="Submits the sealed claim to the financing rail. Available once the claim is sealed."
        >
          {financed && financeResult ? (
            <FinancingState result={financeResult} />
          ) : (
            <FinalizeButton
              label="FINANCE THE REFUND"
              pendingLabel="SUBMITTING…"
              enabled={sealed}
              disabledHint="Seal the claim first"
              pending={finance.pending}
              error={finance.error}
              conflictReason={conflictReasonFor(finance.error, 'not_sealed')}
              onClick={finance.onFinance}
            />
          )}
        </FinalizeRow>
      </div>
    </div>
  );
}

/* ─────────────────────────── Finalize sub-UI ───────────────────────── */

function FinalizeRow({
  ordinal,
  title,
  body,
  children,
}: {
  ordinal: string;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        padding: '16px 18px',
        background: ink3,
        border: `1px solid ${rule}`,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 18,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <MonoLabel size={10} color={bone3}>
          {ordinal} · {title}
        </MonoLabel>
        <div style={{ marginTop: 5, fontFamily: fSans, fontSize: 13, color: bone3 }}>{body}</div>
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function FinalizeButton({
  label,
  pendingLabel,
  enabled,
  disabledHint,
  pending,
  error,
  conflictReason,
  onClick,
}: {
  label: string;
  pendingLabel: string;
  enabled: boolean;
  disabledHint: string;
  pending: boolean;
  error: Error | null;
  /** 409 reason to surface inline (e.g. not_approved / not_sealed). */
  conflictReason: string | null;
  onClick: () => void;
}) {
  // A 404 means the endpoint is being built in parallel and isn't live yet —
  // surface an honest "not available yet" affordance, never a crash.
  const notAvailableYet = error instanceof NotFoundError;
  const disabled = !enabled || pending;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={enabled ? undefined : disabledHint}
        style={primaryBtn(disabled)}
      >
        {pending ? pendingLabel : label}
      </button>
      {notAvailableYet && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Diamond size={6} filled={false} color={bone3} />
          <MonoLabel size={9} color={bone3} tracking="0.12em">
            NOT AVAILABLE YET
          </MonoLabel>
        </span>
      )}
      {conflictReason && <ErrorText>{conflictReason}</ErrorText>}
      {error && !notAvailableYet && !conflictReason && (
        <ErrorText>Couldn&rsquo;t complete that. Try again.</ErrorText>
      )}
    </div>
  );
}

function SealedState({ result }: { result: SealResult }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        background: 'rgba(225,162,58,0.12)',
        border: `1px solid ${amber}`,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Diamond size={7} color={amber} />
      <div>
        <MonoLabel size={9.5} color={amber}>
          SEALED · BLOCK {result.block_id.slice(0, 12)}
        </MonoLabel>
        <div style={{ marginTop: 3, fontFamily: fMono, fontSize: 9.5, color: bone3 }}>
          {formatTs(result.sealed_at)}
        </div>
      </div>
    </div>
  );
}

function FinancingState({ result }: { result: FinanceResult }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        background: 'rgba(122,150,133,0.14)',
        border: `1px solid ${sage}`,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Diamond size={7} color={sage} />
      <div>
        <MonoLabel size={9.5} color={sage}>
          FINANCING REQUESTED · {result.financing.status.toUpperCase()}
        </MonoLabel>
        <div style={{ marginTop: 3, fontFamily: fMono, fontSize: 9.5, color: bone3 }}>
          {formatTs(result.financing.requested_at)}
        </div>
      </div>
    </div>
  );
}

/**
 * Surface a 409 conflict message inline. The expected code (not_approved /
 * not_sealed) is documented for clarity; we show the server's message for
 * any 409 so an unexpected conflict still reaches the consultant.
 */
function conflictReasonFor(error: Error | null, _expectedCode: string): string | null {
  return error instanceof ConflictError ? error.message : null;
}

/* ───────────────────────────── Sub-panels ──────────────────────────── */

function ReadyPanel({ label, approved }: { label: string; approved: boolean }) {
  return (
    <div
      style={{
        padding: '14px 16px',
        background: approved ? 'rgba(122,150,133,0.08)' : 'rgba(225,162,58,0.06)',
        border: `1px solid ${approved ? sage : amber}`,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <Diamond size={7} color={approved ? sage : amber} />
      <div>
        <MonoLabel size={10} color={approved ? sage : amber}>
          {approved ? `${label} APPROVED` : `${label} PREPARED — READY FOR YOUR JUDGEMENT`}
        </MonoLabel>
        <div style={{ marginTop: 4, fontFamily: fSans, fontSize: 13, color: bone3 }}>
          {approved
            ? 'You have approved this step. Reopen it to revisit the AI-prepared content.'
            : 'The AI-prepared content for this step is ready and meets the advance gate. Review it, then approve.'}
        </div>
      </div>
    </div>
  );
}

function AwaitingPanel({ reason }: { reason: string }) {
  return (
    <div
      style={{
        padding: '14px 16px',
        background: ink3,
        border: `1px dashed ${ruleStrong}`,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <Diamond size={6} filled={false} color={bone3} />
      <div>
        <MonoLabel size={10} color={bone3}>
          AWAITING AI PREPARATION
        </MonoLabel>
        <div style={{ marginTop: 4, fontFamily: fSans, fontSize: 13, color: bone3 }}>{reason}</div>
      </div>
    </div>
  );
}

function Locked({ reason }: { reason: string }) {
  return (
    <div
      style={{
        padding: '14px 16px',
        background: ink3,
        border: `1px solid ${rule}`,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <Diamond size={6} filled={false} color={bone4} />
      <div style={{ fontFamily: fSans, fontSize: 13, color: bone3 }}>{reason}</div>
    </div>
  );
}

function NotInitializedPanel({
  pending,
  error,
  onPrepare,
}: {
  pending: boolean;
  error: Error | null;
  onPrepare: () => void;
}) {
  return (
    <div
      style={{
        background: ink2,
        border: `1px solid ${ruleStrong}`,
        borderRadius: 4,
        padding: '24px',
      }}
    >
      <MonoLabel size={10} color={amber}>
        CLAIM NOT YET PREPARED
      </MonoLabel>
      <div
        style={{
          marginTop: 10,
          fontFamily: fSans,
          fontSize: 14,
          color: bone2,
          lineHeight: 1.5,
          maxWidth: 540,
        }}
      >
        This claim has no workflow yet. Trigger &ldquo;Prepare claim&rdquo; to start the AI
        preparation pipeline — it will classify evidence, draft activities, apportion the ledger and
        draft the narrative for your per-step approval.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
        <button type="button" onClick={onPrepare} disabled={pending} style={primaryBtn(pending)}>
          {pending ? 'PREPARING…' : 'PREPARE CLAIM'}
        </button>
        {error && <ErrorText>{error.message}</ErrorText>}
      </div>
    </div>
  );
}

function EngagementRequiredOverlay() {
  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          padding: '14px 22px',
          background: ink2,
          border: `1px solid ${ruleStrong}`,
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
          pointerEvents: 'auto',
        }}
      >
        <Diamond size={7} />
        <div>
          <MonoLabel size={10} color={amber} tracking="0.18em">
            ENGAGEMENT REQUIRED
          </MonoLabel>
          <div style={{ marginTop: 4, fontFamily: fSans, fontSize: 12.5, color: bone3 }}>
            Send and countersign the engagement letter to unlock the per-step approval wizard.
          </div>
        </div>
      </div>
    </div>
  );
}

function CenteredNote({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'error';
}) {
  return (
    <div
      style={{
        padding: '40px 22px',
        textAlign: 'center',
        fontFamily: fSans,
        fontSize: 13.5,
        color: tone === 'error' ? rust : bone3,
      }}
    >
      {children}
    </div>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: fSans, fontSize: 12, color: rust }}>{children}</span>;
}

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    padding: '9px 16px',
    background: disabled ? amberSoft : amber,
    color: ink,
    border: 'none',
    borderRadius: 3,
    fontFamily: fMono,
    fontSize: 11,
    letterSpacing: '0.16em',
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
  };
}

function ghostBtn(disabled: boolean): CSSProperties {
  return {
    padding: '9px 14px',
    background: 'transparent',
    color: bone2,
    border: `1px solid ${ruleStrong}`,
    borderRadius: 3,
    fontFamily: fMono,
    fontSize: 11,
    letterSpacing: '0.16em',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-AU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
