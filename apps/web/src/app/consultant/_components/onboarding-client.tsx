'use client';

/**
 * Step 2 — Add client company.
 *
 * Two paths, toggled by a segmented control:
 *   - Select existing: a dropdown over GET /v1/subject-tenants (claimants).
 *   - Create new: a form (name + ABN + primary contact) → POST
 *     /v1/subject-tenants. The API only persists `name` (a claimant
 *     subject_tenant has no ABN / contact column), so when those optional
 *     fields are filled they're recorded as the client's first evidence
 *     note via POST /v1/events rather than dropped.
 *
 * The clients list, selection, and refresh are owned by the parent
 * (onboarding-view) and passed down so the dropdown and step-3 stay in
 * sync after a create.
 */

import { useState } from 'react';
import type { SubjectTenant } from '@cpa/schemas';
import { ConflictError, ForbiddenError, UnauthenticatedError } from '@/lib/api';
import { amber, bone, bone2, bone3, fMono, fSans, ink3, ruleStrong } from './tokens';
import { Button, FieldLabel, Panel, SectionHeading, StatusLine, TextField } from './onboarding-ui';
import { createClient, createEvidence } from './onboarding-api';

interface ClientSectionProps {
  clients: SubjectTenant[] | null;
  clientsLoading: boolean;
  clientsError: string | null;
  selectedClient: SubjectTenant | null;
  onSelect: (c: SubjectTenant | null) => void;
  onCreated: (c: SubjectTenant) => Promise<void>;
  onContinue: () => void;
}

type Mode = 'existing' | 'new';

export function ClientSection({
  clients,
  clientsLoading,
  clientsError,
  selectedClient,
  onSelect,
  onCreated,
  onContinue,
}: ClientSectionProps) {
  const [mode, setMode] = useState<Mode>('existing');

  const [newName, setNewName] = useState('');
  const [newAbn, setNewAbn] = useState('');
  const [newContact, setNewContact] = useState('');
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<{ tone: 'error' | 'ok'; msg: string } | null>(
    null,
  );

  async function handleCreate() {
    setCreating(true);
    setCreateStatus(null);
    try {
      const created = await createClient(newName.trim());
      // Fold ABN + contact (no columns for them) into a first evidence
      // note so the detail isn't lost. Best-effort — a failure here
      // doesn't undo the client create.
      const extras: string[] = [];
      if (newAbn.trim()) extras.push(`ABN: ${newAbn.trim()}`);
      if (newContact.trim()) extras.push(`Primary contact: ${newContact.trim()}`);
      if (extras.length > 0) {
        try {
          await createEvidence(
            created.id,
            `Client onboarding details — ${extras.join('; ')}.`,
          );
        } catch {
          /* non-fatal: client still created */
        }
      }
      await onCreated(created);
      setCreateStatus({ tone: 'ok', msg: `Created "${created.name}".` });
      setNewName('');
      setNewAbn('');
      setNewContact('');
    } catch (err) {
      if (err instanceof ConflictError) {
        setCreateStatus({ tone: 'error', msg: 'A client with that name already exists.' });
      } else if (err instanceof ForbiddenError) {
        setCreateStatus({ tone: 'error', msg: 'Your role cannot create clients.' });
      } else if (err instanceof UnauthenticatedError) {
        setCreateStatus({ tone: 'error', msg: 'Session expired — sign in again.' });
      } else {
        setCreateStatus({
          tone: 'error',
          msg: err instanceof Error ? err.message : 'Failed to create client.',
        });
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <Panel>
      <SectionHeading kicker="Step 2" title="Client company" />
      <p style={{ fontFamily: fSans, fontSize: 13, color: bone3, marginBottom: 18, lineHeight: 1.5 }}>
        A client company is the entity making the R&amp;D claim. Pick one you&apos;ve already added,
        or create a new one.
      </p>

      {/* Mode toggle */}
      <div style={{ display: 'inline-flex', marginBottom: 20, border: `1px solid ${ruleStrong}`, borderRadius: 3, overflow: 'hidden' }}>
        {(['existing', 'new'] as Mode[]).map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              style={{
                padding: '8px 16px',
                background: active ? 'rgba(225,162,58,0.12)' : 'transparent',
                border: 'none',
                color: active ? amber : bone2,
                fontFamily: fMono,
                fontSize: 10.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              {m === 'existing' ? 'Select existing' : 'Create new'}
            </button>
          );
        })}
      </div>

      {mode === 'existing' && (
        <div>
          {clientsLoading && (
            <div style={{ fontFamily: fMono, fontSize: 11, color: bone3, letterSpacing: '0.1em' }}>
              LOADING CLIENTS…
            </div>
          )}
          {clientsError && <StatusLine tone="error">{clientsError}</StatusLine>}
          {!clientsLoading && !clientsError && clients && clients.length === 0 && (
            <div
              style={{
                padding: '18px 16px',
                background: ink3,
                border: `1px dashed ${ruleStrong}`,
                borderRadius: 4,
                fontFamily: fSans,
                fontSize: 13,
                color: bone3,
              }}
            >
              No clients yet. Switch to{' '}
              <button
                type="button"
                onClick={() => setMode('new')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: amber,
                  cursor: 'pointer',
                  fontFamily: fSans,
                  fontSize: 13,
                  padding: 0,
                  textDecoration: 'underline',
                }}
              >
                Create new
              </button>{' '}
              to add your first client company.
            </div>
          )}
          {!clientsLoading && !clientsError && clients && clients.length > 0 && (
            <>
              <FieldLabel>Existing clients ({clients.length})</FieldLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {clients.map((c) => {
                  const sel = selectedClient?.id === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => onSelect(c)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '11px 14px',
                        background: sel ? 'rgba(225,162,58,0.10)' : ink3,
                        border: `1px solid ${sel ? 'rgba(225,162,58,0.32)' : ruleStrong}`,
                        borderRadius: 3,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ fontFamily: fSans, fontSize: 13.5, color: bone, fontWeight: 500 }}>
                        {c.name}
                      </span>
                      <span
                        style={{
                          fontFamily: fMono,
                          fontSize: 9,
                          color: sel ? amber : bone3,
                          letterSpacing: '0.14em',
                        }}
                      >
                        {sel ? 'SELECTED' : c.id.slice(0, 8)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {mode === 'new' && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <FieldLabel>Company name *</FieldLabel>
            <TextField value={newName} onChange={setNewName} placeholder="e.g. Vantage Industries" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <FieldLabel>ABN</FieldLabel>
            <TextField value={newAbn} onChange={setNewAbn} placeholder="11 222 333 444" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <FieldLabel>Primary contact</FieldLabel>
            <TextField
              value={newContact}
              onChange={setNewContact}
              placeholder="Name / email of the day-to-day contact"
            />
          </div>
          <Button onClick={() => void handleCreate()} disabled={creating || newName.trim().length === 0}>
            {creating ? 'Creating…' : 'Create client'}
          </Button>
          {createStatus && <StatusLine tone={createStatus.tone}>{createStatus.msg}</StatusLine>}
        </div>
      )}

      {/* Continue */}
      {selectedClient && (
        <div
          style={{
            marginTop: 22,
            paddingTop: 16,
            borderTop: `1px solid rgba(240,235,226,.06)`,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <Button onClick={onContinue}>Continue with {selectedClient.name} →</Button>
        </div>
      )}
    </Panel>
  );
}
