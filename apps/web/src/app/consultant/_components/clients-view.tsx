'use client';

/**
 * Clients view — the entry point for the claim workflow IA:
 *
 *     Clients (list)  →  Client  →  that client's CLAIMS list  →  Claim
 *
 * Per docs/product/workflow.md, a Client is a claimant company and a Claim
 * is a single R&DTI claim for a period (a client has MANY per year because
 * they finance each refund). This view owns the navigation between those
 * three levels; the per-step approve wizard lives in <ClaimReviewView>.
 *
 * All data is live: clients via GET /v1/subject-tenants?kind=claimant, a
 * client's claims via GET /v1/claims?subject_tenant_id=..., and "Prepare
 * claim" via POST /v1/claims (which seeds workflow_state transactionally).
 * Loading / empty / error states are explicit — no fabricated rows.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Claim, SubjectTenant } from '@cpa/schemas';
import { ConflictError, ForbiddenError, UnauthenticatedError } from '@/lib/api';
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
import { Diamond, MonoLabel } from './atoms';
import { listClients } from './onboarding-api';
import { useClientClaims, usePrepareClaim } from '@/lib/hooks/use-claims';
import { ClaimReviewView } from './claim-review-view';

type Level =
  | { kind: 'clients' }
  | { kind: 'claims'; client: SubjectTenant }
  | { kind: 'claim'; client: SubjectTenant; claim: Claim };

export function ClientsView() {
  const [level, setLevel] = useState<Level>({ kind: 'clients' });

  if (level.kind === 'claim') {
    return (
      <ClaimReviewView
        claim={level.claim}
        clientName={level.client.name}
        onBack={() => setLevel({ kind: 'claims', client: level.client })}
      />
    );
  }

  if (level.kind === 'claims') {
    return (
      <ClientClaimsList
        client={level.client}
        onBack={() => setLevel({ kind: 'clients' })}
        onOpenClaim={(claim) => setLevel({ kind: 'claim', client: level.client, claim })}
      />
    );
  }

  return <ClientsList onSelect={(client) => setLevel({ kind: 'claims', client })} />;
}

/* ───────────────────────────── Clients list ────────────────────────── */

function ClientsList({ onSelect }: { onSelect: (c: SubjectTenant) => void }) {
  const [clients, setClients] = useState<SubjectTenant[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setClients(await listClients());
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        setError('Your session has expired — sign in again to load clients.');
      } else if (err instanceof ForbiddenError) {
        setError('Your role cannot view clients for this firm.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load clients.');
      }
      setClients(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 28 }}>
      <Header
        kicker="CLIENTS"
        title="Client companies"
        subtitle="Pick a client to see their claims. New clients are added in Setup."
      />

      {loading && <CenteredNote>Loading clients…</CenteredNote>}
      {!loading && error && <CenteredNote tone="error">{error}</CenteredNote>}
      {!loading && !error && clients && clients.length === 0 && (
        <CenteredNote>
          No client companies yet. Add one in the Setup view to get started.
        </CenteredNote>
      )}

      {!loading && !error && clients && clients.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 760 }}>
          {clients.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '16px 18px',
                background: ink2,
                border: `1px solid ${ruleStrong}`,
                borderRadius: 4,
                cursor: 'pointer',
                textAlign: 'left',
                width: '100%',
              }}
            >
              <Diamond size={8} />
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: fSerif, fontSize: 18, color: bone, fontWeight: 400 }}>
                  {c.name}
                </div>
                <MonoLabel size={9} color={bone4} tracking="0.16em">
                  {c.kind.toUpperCase()} · {c.id.slice(0, 8)}
                </MonoLabel>
              </div>
              <MonoLabel size={10} color={amber}>
                VIEW CLAIMS →
              </MonoLabel>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Claims list ─────────────────────────── */

/** Default FY for a new claim: the current Australian FY (ending 30 June). */
function currentFiscalYear(now = new Date()): number {
  // Jan–Jun → FY = calendar year; Jul–Dec → FY = next calendar year.
  const month = now.getMonth(); // 0-based
  return month >= 6 ? now.getFullYear() + 1 : now.getFullYear();
}

function fyLabel(fiscalYear: number): string {
  return `FY${String(fiscalYear).slice(-2)}`;
}

function ClientClaimsList({
  client,
  onBack,
  onOpenClaim,
}: {
  client: SubjectTenant;
  onBack: () => void;
  onOpenClaim: (claim: Claim) => void;
}) {
  const { data: claims, isLoading, error, refetch } = useClientClaims(client.id);
  const prepare = usePrepareClaim(client.id);

  // The period is implicit — a claim is created by hitting "Prepare claim",
  // not by picking a date range up front (per workflow.md). We default the
  // new claim to the current Australian FY.
  const fy = currentFiscalYear();

  const onPrepare = () => {
    prepare.mutate(fy, {
      onSuccess: (claim) => {
        void refetch();
        // Jump straight into the freshly prepared claim's approve wizard.
        onOpenClaim(claim);
      },
    });
  };

  const duplicate = prepare.error instanceof ConflictError;

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 28 }}>
      <div style={{ marginBottom: 24 }}>
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
          ← CLIENTS
        </button>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
          }}
        >
          <div>
            <MonoLabel size={10} color={amber}>
              CLIENT
            </MonoLabel>
            <h1
              style={{
                marginTop: 8,
                fontFamily: fSerif,
                fontSize: 30,
                fontWeight: 300,
                color: bone,
                letterSpacing: '-0.02em',
              }}
            >
              {client.name}
            </h1>
            <div style={{ fontFamily: fSans, fontSize: 13.5, color: bone3, marginTop: 6 }}>
              One claim per period — clients file several a year to finance each refund.
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            {/* Consultant-side "Prepare claim" trigger. The claimant-side
                trigger is a separate surface in the MOBILE app (apps/mobile)
                — not built here. */}
            <button
              type="button"
              onClick={onPrepare}
              disabled={prepare.isPending}
              style={{
                padding: '10px 18px',
                background: prepare.isPending ? amberSoft : amber,
                color: ink,
                border: 'none',
                borderRadius: 3,
                fontFamily: fMono,
                fontSize: 11,
                letterSpacing: '0.16em',
                fontWeight: 600,
                cursor: prepare.isPending ? 'not-allowed' : 'pointer',
                opacity: prepare.isPending ? 0.7 : 1,
              }}
            >
              {prepare.isPending ? 'PREPARING…' : `+ PREPARE CLAIM · ${fyLabel(fy)}`}
            </button>
            {prepare.error && (
              <span style={{ fontFamily: fSans, fontSize: 12, color: rust }}>
                {duplicate
                  ? `A ${fyLabel(fy)} claim already exists for this client.`
                  : prepare.error.message}
              </span>
            )}
          </div>
        </div>
      </div>

      {isLoading && <CenteredNote>Loading claims…</CenteredNote>}
      {!isLoading && error && (
        <CenteredNote tone="error">Couldn&rsquo;t load claims. {error.message}</CenteredNote>
      )}
      {!isLoading && !error && claims && claims.length === 0 && (
        <CenteredNote>
          No claims yet for {client.name}. Hit &ldquo;Prepare claim&rdquo; to create the first one.
        </CenteredNote>
      )}

      {!isLoading && !error && claims && claims.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 820 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr 160px 120px',
              padding: '8px 18px',
              gap: 16,
              fontFamily: fMono,
              fontSize: 10,
              color: bone4,
              letterSpacing: '0.16em',
            }}
          >
            <span>PERIOD</span>
            <span>STAGE</span>
            <span>TYPE</span>
            <span style={{ textAlign: 'right' }} />
          </div>
          {claims.map((claim) => (
            <ClaimRow key={claim.id} claim={claim} onOpen={() => onOpenClaim(claim)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClaimRow({ claim, onOpen }: { claim: Claim; onOpen: () => void }) {
  const stageLabel = claim.stage.replace(/_/g, ' ').toUpperCase();
  const isWizard = claim.is_wizard_claim;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 1fr 160px 120px',
        alignItems: 'center',
        gap: 16,
        padding: '16px 18px',
        background: ink2,
        border: `1px solid ${ruleStrong}`,
        borderRadius: 4,
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
      }}
    >
      <span style={{ fontFamily: fSerif, fontSize: 18, color: bone }}>
        {fyLabel(claim.fiscal_year)}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: claim.stage === 'submitted' ? sage : amber,
            flexShrink: 0,
          }}
        />
        <MonoLabel size={9.5} color={bone2} tracking="0.12em">
          {stageLabel}
        </MonoLabel>
      </span>
      <MonoLabel size={9} color={isWizard ? amber : bone4} tracking="0.14em">
        {isWizard ? 'APPROVE-WIZARD' : 'LEGACY CLAIM'}
      </MonoLabel>
      <span style={{ textAlign: 'right' }}>
        <MonoLabel size={10} color={amber}>
          OPEN →
        </MonoLabel>
      </span>
    </button>
  );
}

/* ───────────────────────────── Shared ──────────────────────────────── */

function Header({
  kicker,
  title,
  subtitle,
}: {
  kicker: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Diamond size={9} />
        <MonoLabel size={10} color={amber}>
          {kicker}
        </MonoLabel>
      </div>
      <h1
        style={{
          marginTop: 10,
          fontFamily: fSerif,
          fontSize: 30,
          fontWeight: 300,
          color: bone,
          letterSpacing: '-0.02em',
        }}
      >
        {title}
      </h1>
      <p style={{ marginTop: 6, fontFamily: fSans, fontSize: 13.5, color: bone3, maxWidth: 560 }}>
        {subtitle}
      </p>
    </div>
  );
}

function CenteredNote({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
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
        background: ink3,
        border: `1px solid ${rule}`,
        borderRadius: 4,
        maxWidth: 760,
      }}
    >
      {children}
    </div>
  );
}
