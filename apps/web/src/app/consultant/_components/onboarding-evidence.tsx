'use client';

/**
 * Step 3a — Evidence for the selected client.
 *
 * Lists the client's evidence (GET /v1/evidence?claimant_ids=…) and lets
 * the consultant add evidence two ways:
 *   - Import a file (txt / md / csv / json read client-side, text
 *     extracted) → POST /v1/events.
 *   - Paste a note → POST /v1/events.
 *
 * The server classifies the text and extends the per-claimant hash chain;
 * the new item shows up on refetch. We deliberately read text client-side
 * because the events endpoint takes `raw_text` (binary upload + S3 is the
 * mobile /v1/media path, out of scope for this onboarding flow).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubjectTenant } from '@cpa/schemas';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@/lib/api';
import { amber, bone, bone2, bone3, fMono, fSans, ink3, rule, ruleStrong, sage } from './tokens';
import { Button, FieldLabel, Panel, SectionHeading, StatusLine, TextArea } from './onboarding-ui';
import { createEvidence, listEvidence, type EvidenceItem } from './onboarding-api';

const TEXT_ACCEPT = '.txt,.md,.csv,.json,.log,text/plain';
const MAX_TEXT_CHARS = 20_000; // matches createEventBody.raw_text max

export function EvidenceSection({ client }: { client: SubjectTenant }) {
  const [items, setItems] = useState<EvidenceItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ tone: 'error' | 'ok'; msg: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listEvidence(client.id);
      setItems(rows);
    } catch (err) {
      if (err instanceof UnauthenticatedError) setError('Session expired — sign in again.');
      else if (err instanceof ForbiddenError) setError('Your role cannot view evidence.');
      else setError(err instanceof Error ? err.message : 'Failed to load evidence.');
      setItems(null);
    } finally {
      setLoading(false);
    }
  }, [client.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submitText(rawText: string, successMsg: string) {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setStatus(null);
    try {
      await createEvidence(client.id, trimmed.slice(0, MAX_TEXT_CHARS));
      setStatus({ tone: 'ok', msg: successMsg });
      setNote('');
      await refresh();
    } catch (err) {
      if (err instanceof NotFoundError) {
        setStatus({ tone: 'error', msg: 'Client not found for this firm.' });
      } else if (err instanceof ForbiddenError) {
        setStatus({ tone: 'error', msg: 'Your role cannot add evidence.' });
      } else {
        setStatus({ tone: 'error', msg: err instanceof Error ? err.message : 'Failed to add evidence.' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFile(file: File) {
    try {
      const text = await file.text();
      if (!text.trim()) {
        setStatus({ tone: 'error', msg: 'That file has no readable text.' });
        return;
      }
      const header = `Imported file: ${file.name}\n\n`;
      await submitText(header + text, `Imported "${file.name}".`);
    } catch {
      setStatus({ tone: 'error', msg: 'Could not read that file as text.' });
    }
  }

  return (
    <Panel>
      <SectionHeading kicker="Step 3 · Evidence" title="Evidence for this client" />
      <p style={{ fontFamily: fSans, fontSize: 13, color: bone3, marginBottom: 18, lineHeight: 1.5 }}>
        Upload a document or paste a note. Each item is classified and sealed into the client&apos;s
        evidence chain.
      </p>

      {/* Add evidence */}
      <div style={{ marginBottom: 18 }}>
        <FieldLabel>Paste a note</FieldLabel>
        <TextArea
          value={note}
          onChange={setNote}
          disabled={submitting}
          placeholder="e.g. Lab log: ran the cyclic-stress rig at 850°C; yield loss dropped 9% vs baseline."
        />
        <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <Button
            onClick={() => void submitText(note, 'Note added to evidence chain.')}
            disabled={submitting || note.trim().length === 0}
          >
            {submitting ? 'Adding…' : 'Add note'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept={TEXT_ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          <Button variant="ghost" disabled={submitting} onClick={() => fileRef.current?.click()}>
            Import file
          </Button>
        </div>
        {status && <StatusLine tone={status.tone}>{status.msg}</StatusLine>}
      </div>

      {/* Existing evidence */}
      <div style={{ paddingTop: 16, borderTop: `1px solid ${rule}` }}>
        <FieldLabel>
          {items ? `Evidence on file (${items.length})` : 'Evidence on file'}
        </FieldLabel>
        {loading && (
          <div style={{ fontFamily: fMono, fontSize: 11, color: bone3, letterSpacing: '0.1em' }}>
            LOADING EVIDENCE…
          </div>
        )}
        {error && <StatusLine tone="error">{error}</StatusLine>}
        {!loading && !error && items && items.length === 0 && (
          <div
            style={{
              padding: '16px',
              background: ink3,
              border: `1px dashed ${ruleStrong}`,
              borderRadius: 4,
              fontFamily: fSans,
              fontSize: 13,
              color: bone3,
            }}
          >
            No evidence yet for {client.name}. Add a note or import a file above.
          </div>
        )}
        {!loading && !error && items && items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((it) => (
              <div
                key={it.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '11px 14px',
                  background: ink3,
                  border: `1px solid ${rule}`,
                  borderRadius: 3,
                }}
              >
                <span
                  style={{
                    fontFamily: fMono,
                    fontSize: 8.5,
                    letterSpacing: '0.12em',
                    color: amber,
                    border: `1px solid ${ruleStrong}`,
                    padding: '2px 6px',
                    borderRadius: 2,
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                >
                  {it.kind}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: fSans,
                      fontSize: 13,
                      color: bone,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {it.payload_excerpt || '(no excerpt)'}
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      fontFamily: fMono,
                      fontSize: 9.5,
                      color: bone3,
                      letterSpacing: '0.06em',
                    }}
                  >
                    {new Date(it.captured_at).toLocaleString('en-AU')}
                    {it.classification
                      ? ` · ${(it.classification.confidence * 100).toFixed(0)}% ${it.classification.kind}`
                      : ''}
                  </div>
                </div>
                {it.classification && (
                  <span
                    style={{ width: 6, height: 6, borderRadius: '50%', background: sage, marginTop: 6 }}
                    aria-hidden
                  />
                )}
              </div>
            ))}
          </div>
        )}
        {!loading && !error && (
          <button
            type="button"
            onClick={() => void refresh()}
            style={{
              marginTop: 12,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontFamily: fMono,
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: bone2,
            }}
          >
            ↻ Refresh
          </button>
        )}
      </div>
    </Panel>
  );
}
