'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  amber,
  bone,
  bone2,
  bone3,
  bone4,
  fMono,
  fSans,
  ink,
  ink2,
  ink3,
  rule,
  ruleStrong,
  rust,
} from '../../../consultant/_components/tokens';
import { MonoLabel } from '../../../consultant/_components/atoms';

/**
 * Engagement-letter sign form (web fallback).
 *
 * Client component — the form state (typed name, checkbox, submitting,
 * server error) is local; the only network surface is the two POST
 * endpoints. The token is passed in as a prop from the server-rendered
 * parent page so we never have to re-read it from the URL on the
 * client. The signer's typed name only enters the network as the POST
 * body — never the URL.
 *
 * UX mirrors the mobile sign screen (task 05):
 *   - Type your full name to attest authorship.
 *   - Check the acknowledgement box.
 *   - Sign (primary) or Decline (secondary). Decline is always enabled
 *     so claimants who don't want to sign aren't blocked by the
 *     attestation gate; we just don't require a typed name for decline.
 *
 * On success the page router pushes to /signed or /declined — the
 * parent server-component would also redirect there on a fresh load if
 * the page were reopened, but `router.push` gives an immediate
 * client-side transition without re-fetching.
 *
 * Network errors surface as a single inline message under the buttons
 * (the API returns `{ error, message }` shapes; we display the
 * `message` if present, falling back to a generic phrase).
 */

interface SignFormProps {
  token: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

const sectionStyle: CSSProperties = {
  border: `1px solid ${rule}`,
  background: ink2,
  padding: 28,
};

const inputStyle: CSSProperties = {
  width: '100%',
  background: ink3,
  border: `1px solid ${ruleStrong}`,
  color: bone,
  fontFamily: fSans,
  fontSize: 15,
  padding: '12px 14px',
  outline: 'none',
  boxSizing: 'border-box',
};

const buttonBase: CSSProperties = {
  fontFamily: fMono,
  fontSize: 11,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  padding: '14px 22px',
  border: '1px solid transparent',
  cursor: 'pointer',
  background: 'transparent',
};

export function SignForm({ token }: SignFormProps) {
  const router = useRouter();
  const [typedName, setTypedName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState<'sign' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSign = typedName.trim().length > 0 && acknowledged && submitting === null;
  const canDecline = submitting === null;

  const postAction = async (
    action: 'sign' | 'decline',
    body: Record<string, string>,
  ): Promise<boolean> => {
    setSubmitting(action);
    setError(null);
    try {
      // Browser fetch — runs against the same origin so the Next.js
      // dev rewrite (or production proxy) forwards to the Fastify
      // API. No Authorization / cookie header: the route is
      // token-gated by URL.
      const res = await fetch(`/v1/engagement/${encodeURIComponent(token)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `Could not ${action} (HTTP ${res.status}).`;
        try {
          const parsed = (await res.json()) as ApiErrorBody;
          if (parsed.message) msg = parsed.message;
        } catch {
          // non-JSON; keep default
        }
        setError(msg);
        setSubmitting(null);
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      setSubmitting(null);
      return false;
    }
  };

  // ESLint's @typescript-eslint/no-misused-promises rejects async
  // handlers passed directly to JSX attributes (onSubmit/onClick expect
  // a void-returning function, not a Promise<void>). Wrap the async
  // work in fire-and-forget sync wrappers — the inner async function
  // owns its own try/catch (via `postAction`) so an unhandled rejection
  // can't escape the wrapper.
  const onSign = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSign) return;
    void (async () => {
      const ok = await postAction('sign', { typedName: typedName.trim() });
      if (ok) router.push(`/engagement/${encodeURIComponent(token)}/sign/signed`);
    })();
  };

  const onDecline = () => {
    if (!canDecline) return;
    void (async () => {
      const ok = await postAction('decline', {});
      if (ok) router.push(`/engagement/${encodeURIComponent(token)}/sign/declined`);
    })();
  };

  return (
    <form onSubmit={onSign} style={sectionStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <MonoLabel color={amber}>Sign or decline</MonoLabel>
      </div>

      <label style={{ display: 'block', marginBottom: 20 }}>
        <span
          style={{
            display: 'block',
            fontFamily: fMono,
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: bone3,
            marginBottom: 8,
          }}
        >
          Type your full name
        </span>
        <input
          type="text"
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
          autoComplete="name"
          // Browsers run spellcheck on text inputs; turn it off so the
          // signer's legal name isn't underlined as a typo.
          spellCheck={false}
          disabled={submitting !== null}
          style={inputStyle}
          placeholder="Full legal name"
        />
      </label>

      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 24,
          cursor: submitting === null ? 'pointer' : 'default',
        }}
      >
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          disabled={submitting !== null}
          style={{
            marginTop: 3,
            width: 16,
            height: 16,
            accentColor: amber,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 13, lineHeight: 1.6, color: bone2 }}>
          I confirm the name above is mine and I agree to the engagement letter terms.
        </span>
      </label>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="submit"
          disabled={!canSign}
          style={{
            ...buttonBase,
            background: canSign ? amber : ink3,
            color: canSign ? ink : bone4,
            borderColor: canSign ? amber : ruleStrong,
            cursor: canSign ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting === 'sign' ? 'Signing…' : 'Sign engagement letter'}
        </button>
        <button
          type="button"
          onClick={onDecline}
          disabled={!canDecline}
          style={{
            ...buttonBase,
            background: 'transparent',
            color: canDecline ? rust : bone4,
            borderColor: canDecline ? rust : ruleStrong,
            cursor: canDecline ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting === 'decline' ? 'Declining…' : 'Decline'}
        </button>
      </div>

      {error !== null && (
        <p
          role="alert"
          style={{
            marginTop: 20,
            padding: '10px 14px',
            border: `1px solid ${rust}`,
            background: 'rgba(196,106,72,0.12)',
            color: rust,
            fontFamily: fMono,
            fontSize: 11,
            letterSpacing: '0.06em',
          }}
        >
          {error}
        </p>
      )}
    </form>
  );
}
