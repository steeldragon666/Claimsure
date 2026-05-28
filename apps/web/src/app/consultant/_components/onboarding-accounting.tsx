'use client';

/**
 * Step 3b — Connect accounting (Xero / MYOB).
 *
 * Lists current integration connections (GET /v1/integrations) and offers
 * a connect button per provider (POST /v1/integrations/:provider/connect).
 *
 * Provider mapping (see onboarding-api.ts for the full note): the
 * integration_connection enum has no bare `xero` / `myob`. Xero maps to
 * `xero_payroll` (the only Xero-family provider in the enum). MYOB has no
 * enum value at all, so its connect call returns 400 invalid_provider —
 * surfaced as "Not yet available". Even for valid providers, OAuth client
 * IDs aren't configured in prod, so connect returns 412
 * provider_not_configured; we show the server's message and never crash.
 */

import { useCallback, useEffect, useState } from 'react';
import type { IntegrationConnection } from '@cpa/schemas';
import { ApiError, ForbiddenError, UnauthenticatedError } from '@/lib/api';
import { amber, bone, bone2, bone3, fMono, fSans, ink3, rule, ruleStrong, sage } from './tokens';
import { Panel, SectionHeading, StatusLine } from './onboarding-ui';
import { connectIntegration, listIntegrations } from './onboarding-api';
import { MyobIcon, XeroIcon } from './accounting-icons';

interface ProviderDef {
  key: string; // provider value sent to the API
  label: string;
  icon: () => React.ReactElement;
  // Provider values that, when present on a connection row, mean this
  // card is "connected" (Xero may surface as xero_payroll).
  matches: string[];
}

const PROVIDERS: ProviderDef[] = [
  { key: 'xero_payroll', label: 'Xero', icon: () => <XeroIcon />, matches: ['xero_payroll'] },
  // MYOB has no provider enum value yet — connect will 400; handled below.
  { key: 'myob', label: 'MYOB', icon: () => <MyobIcon />, matches: ['myob'] },
];

export function AccountingSection() {
  const [connections, setConnections] = useState<IntegrationConnection[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-provider connect feedback.
  const [connecting, setConnecting] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, { tone: 'error' | 'ok' | 'muted'; msg: string }>>(
    {},
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listIntegrations();
      setConnections(rows);
    } catch (err) {
      if (err instanceof UnauthenticatedError) setError('Session expired — sign in again.');
      else if (err instanceof ForbiddenError) setError('Your role cannot view integrations.');
      else setError(err instanceof Error ? err.message : 'Failed to load integrations.');
      setConnections(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function connectionFor(def: ProviderDef): IntegrationConnection | undefined {
    return connections?.find((c) => def.matches.includes(c.provider));
  }

  async function handleConnect(def: ProviderDef) {
    setConnecting(def.key);
    setFeedback((f) => ({ ...f, [def.key]: { tone: 'muted', msg: 'Starting connection…' } }));
    try {
      const { redirect_url } = await connectIntegration(def.key);
      // Real authorize URL — send the browser there to complete OAuth.
      window.location.assign(redirect_url);
    } catch (err) {
      let msg: string;
      let tone: 'error' | 'muted' = 'error';
      if (err instanceof ApiError && err.status === 412) {
        // provider_not_configured — expected in prod (no OAuth client ID).
        tone = 'muted';
        msg = `${def.label} connection isn't configured on this server yet.`;
      } else if (err instanceof ApiError && err.status === 400) {
        // invalid_provider — e.g. MYOB has no enum value yet.
        tone = 'muted';
        msg = `${def.label} integration isn't available yet.`;
      } else if (err instanceof ForbiddenError) {
        msg = 'Your role cannot connect integrations.';
      } else if (err instanceof UnauthenticatedError) {
        msg = 'Session expired — sign in again.';
      } else {
        msg = err instanceof Error ? err.message : 'Connection failed.';
      }
      setFeedback((f) => ({ ...f, [def.key]: { tone, msg } }));
    } finally {
      setConnecting(null);
    }
  }

  return (
    <Panel>
      <SectionHeading kicker="Step 3 · Accounting" title="Connect accounting" />
      <p style={{ fontFamily: fSans, fontSize: 13, color: bone3, marginBottom: 18, lineHeight: 1.5 }}>
        Link the client&apos;s accounting system to pull ledger data into the claim automatically.
      </p>

      {loading && (
        <div style={{ fontFamily: fMono, fontSize: 11, color: bone3, letterSpacing: '0.1em' }}>
          LOADING CONNECTIONS…
        </div>
      )}
      {error && <StatusLine tone="error">{error}</StatusLine>}

      {!loading && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {PROVIDERS.map((def) => {
            const conn = connectionFor(def);
            const connected = conn != null && conn.sync_state !== 'failed';
            return (
              <div
                key={def.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 16px',
                  background: ink3,
                  border: `1px solid ${rule}`,
                  borderRadius: 4,
                }}
              >
                {def.icon()}
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: fSans, fontSize: 14, fontWeight: 600, color: bone }}>
                    {def.label}
                  </div>
                  <div
                    style={{
                      marginTop: 2,
                      fontFamily: fMono,
                      fontSize: 9.5,
                      letterSpacing: '0.1em',
                      color: connected ? sage : bone3,
                    }}
                  >
                    {connected
                      ? `CONNECTED · ${conn?.sync_state?.toUpperCase() ?? 'IDLE'}`
                      : 'NOT CONNECTED'}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={connecting === def.key}
                  onClick={() => void handleConnect(def)}
                  style={{
                    padding: '9px 16px',
                    background: connected ? 'transparent' : 'rgba(225,162,58,0.14)',
                    border: `1px solid ${connected ? ruleStrong : amber}`,
                    borderRadius: 3,
                    color: connected ? bone2 : amber,
                    fontFamily: fMono,
                    fontSize: 10.5,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    cursor: connecting === def.key ? 'wait' : 'pointer',
                    opacity: connecting === def.key ? 0.6 : 1,
                  }}
                >
                  {connecting === def.key ? 'Connecting…' : connected ? 'Reconnect' : `Connect ${def.label}`}
                </button>
              </div>
            );
          })}
          {/* Per-provider inline feedback below the row group */}
          {PROVIDERS.map((def) => {
            const fb = feedback[def.key];
            if (!fb) return null;
            return (
              <StatusLine key={`fb-${def.key}`} tone={fb.tone}>
                {def.label}: {fb.msg}
              </StatusLine>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
