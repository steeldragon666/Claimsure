'use client';

/**
 * Functional consultant onboarding flow.
 *
 * Three steps, all wired to live APIs (no fixtures):
 *   1. Agency details — the consultant's own firm. GET/PATCH brand-config
 *      + logo-upload-url.
 *   2. Add client company — a `claimant` subject_tenant. List existing or
 *      create a new one.
 *   3. Per-client actions — Evidence (list + create via /v1/events) and
 *      Connect accounting (Xero / MYOB → /v1/integrations).
 *
 * Every API call shows loading / empty / error states explicitly. When an
 * endpoint is genuinely unconfigured (e.g. accounting OAuth client IDs in
 * prod), the UI surfaces the server's message rather than crashing.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SubjectTenant } from '@cpa/schemas';
import { ForbiddenError, UnauthenticatedError } from '@/lib/api';
import { amber, bone, bone2, bone3, fMono, fSans, ink2, ink3, rule, ruleStrong } from './tokens';
import { Diamond, MonoLabel } from './atoms';
import { Panel, SectionHeading } from './onboarding-ui';
import { AgencyDetailsSection } from './onboarding-agency';
import { ClientSection } from './onboarding-client';
import { EvidenceSection } from './onboarding-evidence';
import { AccountingSection } from './onboarding-accounting';
import { listClients } from './onboarding-api';

type StepKey = 'agency' | 'client' | 'actions';

interface StepDef {
  k: StepKey;
  n: number;
  label: string;
}
const STEP_DEFS: StepDef[] = [
  { k: 'agency', n: 1, label: 'Agency details' },
  { k: 'client', n: 2, label: 'Client company' },
  { k: 'actions', n: 3, label: 'Evidence & accounting' },
];

export function OnboardingView() {
  const [step, setStep] = useState<StepKey>('agency');

  // Selected client drives step 3. Lifted here so the stepper + client
  // section + actions stay in sync.
  const [selectedClient, setSelectedClient] = useState<SubjectTenant | null>(null);

  // Clients list is owned here so creating one in step 2 immediately
  // refreshes the dropdown and the count, and so step 3 can reference it.
  const [clients, setClients] = useState<SubjectTenant[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [clientsLoading, setClientsLoading] = useState(true);

  const refreshClients = useCallback(async () => {
    setClientsLoading(true);
    setClientsError(null);
    try {
      const rows = await listClients();
      setClients(rows);
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        setClientsError('Your session has expired — sign in again to load clients.');
      } else if (err instanceof ForbiddenError) {
        setClientsError('Your role cannot view clients for this firm.');
      } else {
        setClientsError(err instanceof Error ? err.message : 'Failed to load clients.');
      }
      setClients(null);
    } finally {
      setClientsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshClients();
  }, [refreshClients]);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 28 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Diamond size={9} />
          <MonoLabel size={10} color={amber}>
            Setup · onboarding
          </MonoLabel>
        </div>
        <h1
          style={{
            marginTop: 10,
            fontFamily: fSans,
            fontSize: 26,
            fontWeight: 600,
            color: bone,
            letterSpacing: '-0.01em',
          }}
        >
          Get your workspace live
        </h1>
        <p
          style={{
            marginTop: 6,
            fontFamily: fSans,
            fontSize: 13.5,
            color: bone3,
            maxWidth: 560,
            lineHeight: 1.5,
          }}
        >
          Set up your agency, add the first client company, then start collecting evidence and
          connect their accounting system.
        </p>
      </div>

      {/* Stepper */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        {STEP_DEFS.map((s) => {
          const active = step === s.k;
          const locked = s.k === 'actions' && !selectedClient;
          return (
            <button
              key={s.k}
              type="button"
              disabled={locked}
              onClick={() => setStep(s.k)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 16px',
                background: active ? 'rgba(225,162,58,0.10)' : ink2,
                border: `1px solid ${active ? 'rgba(225,162,58,0.32)' : rule}`,
                borderRadius: 3,
                cursor: locked ? 'not-allowed' : 'pointer',
                opacity: locked ? 0.4 : 1,
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  border: `1px solid ${active ? amber : ruleStrong}`,
                  color: active ? amber : bone3,
                  fontFamily: fMono,
                  fontSize: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {s.n}
              </span>
              <span
                style={{
                  fontFamily: fSans,
                  fontSize: 13,
                  fontWeight: 500,
                  color: active ? amber : bone2,
                }}
              >
                {s.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div style={{ maxWidth: 720 }}>
        {step === 'agency' && <AgencyDetailsSection onDone={() => setStep('client')} />}

        {step === 'client' && (
          <ClientSection
            clients={clients}
            clientsLoading={clientsLoading}
            clientsError={clientsError}
            selectedClient={selectedClient}
            onSelect={setSelectedClient}
            onCreated={async (c) => {
              await refreshClients();
              setSelectedClient(c);
            }}
            onContinue={() => setStep('actions')}
          />
        )}

        {step === 'actions' &&
          (selectedClient ? (
            <ActionsStep client={selectedClient} />
          ) : (
            <Panel>
              <SectionHeading kicker="Step 3" title="Evidence & accounting" />
              <div style={{ fontFamily: fSans, fontSize: 13.5, color: bone3 }}>
                Pick or create a client company in step 2 first.
              </div>
            </Panel>
          ))}
      </div>
    </div>
  );
}

/**
 * Step 3 wrapper — renders the per-client evidence + accounting panels.
 */
function ActionsStep({ client }: { client: SubjectTenant }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 16px',
          background: ink3,
          border: `1px solid ${rule}`,
          borderRadius: 4,
        }}
      >
        <Diamond size={7} />
        <span style={{ fontFamily: fMono, fontSize: 10, color: bone3, letterSpacing: '0.16em' }}>
          ACTIVE CLIENT
        </span>
        <span style={{ fontFamily: fSans, fontSize: 14, fontWeight: 600, color: bone }}>
          {client.name}
        </span>
      </div>

      <EvidenceSection client={client} />
      <AccountingSection />
    </div>
  );
}
