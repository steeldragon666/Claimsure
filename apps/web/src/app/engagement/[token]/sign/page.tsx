import { redirect } from 'next/navigation';
import {
  amber,
  bone,
  bone2,
  bone3,
  fMono,
  fSans,
  fSerif,
  ink,
  ink2,
  rule,
} from '../../../consultant/_components/tokens';
import { Diamond, MonoLabel } from '../../../consultant/_components/atoms';
import { SignForm } from './sign-form';

/**
 * Public web-fallback engagement-letter sign page (Wizard Step 1, Task 06).
 *
 * Route: `/engagement/[token]/sign` — PUBLIC, token-gated.
 *
 * The mobile claimant app is the primary signing surface; this page
 * exists for the email-link fallback when a claimant doesn't install
 * the app. The token in the URL is the only credential — no session
 * middleware applies. The signer's typed name is collected in the
 * `<SignForm>` client component and POSTed to the API directly.
 *
 * Flow:
 *   1. Server-side fetch `GET /v1/engagement/[token]` (the public,
 *      token-gated read endpoint defined in task 02).
 *   2. 404 → render terminal "expired or invalid" page in-place.
 *   3. Status already terminal (signed / declined / expired) → redirect
 *      to the appropriate `/signed` or `/declined` page. Expired falls
 *      through to the same "expired or invalid" copy as 404 because
 *      from the claimant's perspective the link is no longer actionable.
 *   4. Otherwise → render letter content + the `<SignForm>` client
 *      component for the sign / decline action.
 *
 * The API base URL is read from `INTERNAL_API_URL` (same env var as the
 * existing claimant PWA server fetchers — see
 * `apps/web/src/app/claimant/[claimant_id]/_lib/api.ts`). This route is
 * intentionally separate from the consultant workspace layout (no nav,
 * no firm chrome) — the claimant sees a focused single-page letter.
 *
 * `react-markdown` is not in the web app's dependencies, so the
 * rendered letter is displayed as a monospaced `<pre>` block. The API
 * returns pre-rendered markdown (template variables already substituted
 * by `renderTemplate` server-side), so the only thing missing here is
 * the markdown-to-HTML transform — acceptable for v1 since the letter
 * is plain prose with no rich formatting requirements yet.
 */

interface EngagementByToken {
  renderedMarkdown: string;
  consultantName: string;
  firmName: string;
  status: 'sent' | 'signed' | 'declined' | 'expired';
}

interface Props {
  params: Promise<{ token: string }>;
}

const apiBaseUrl = (): string => {
  return process.env['INTERNAL_API_URL'] ?? 'http://localhost:3000';
};

async function fetchEngagement(token: string): Promise<EngagementByToken | 'not_found'> {
  const res = await fetch(`${apiBaseUrl()}/v1/engagement/${encodeURIComponent(token)}`, {
    method: 'GET',
    // The engagement letter contents are stable for a given token
    // (rendered at send time) and the status only changes via the
    // sign/decline POST round-trip — but we still disable Next's
    // fetch cache so the post-action redirect lands on a fresh
    // status read rather than a memoised "sent" view.
    cache: 'no-store',
  });
  if (res.status === 404) return 'not_found';
  if (!res.ok) {
    throw new Error(`engagement by-token fetch failed: ${res.status}`);
  }
  return (await res.json()) as EngagementByToken;
}

export default async function EngagementSignPage({ params }: Props) {
  const { token } = await params;
  const result = await fetchEngagement(token);

  if (result === 'not_found') {
    return <ExpiredOrInvalid />;
  }

  if (result.status === 'signed') {
    redirect(`/engagement/${encodeURIComponent(token)}/sign/signed`);
  }
  if (result.status === 'declined') {
    redirect(`/engagement/${encodeURIComponent(token)}/sign/declined`);
  }
  if (result.status === 'expired') {
    return <ExpiredOrInvalid />;
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        background: ink,
        color: bone,
        fontFamily: fSans,
        padding: '48px 24px',
      }}
    >
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 32,
            paddingBottom: 24,
            borderBottom: `1px solid ${rule}`,
          }}
        >
          <Diamond size={10} />
          <MonoLabel>{result.firmName} — engagement letter</MonoLabel>
        </header>

        <section style={{ marginBottom: 40 }}>
          <h1
            style={{
              fontFamily: fSerif,
              fontWeight: 300,
              fontSize: 40,
              lineHeight: 1.1,
              letterSpacing: '-0.01em',
              margin: '0 0 16px',
              color: bone,
            }}
          >
            Engagement letter
          </h1>
          <p
            style={{
              fontFamily: fSans,
              fontSize: 14,
              lineHeight: 1.7,
              color: bone2,
              margin: 0,
            }}
          >
            Prepared by {result.consultantName}. Review the letter below, then sign or decline at
            the bottom of the page. By signing you confirm the typed name is yours and that you
            agree to the terms of engagement.
          </p>
        </section>

        <section
          style={{
            border: `1px solid ${rule}`,
            background: ink2,
            padding: 28,
            marginBottom: 40,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 20,
              color: amber,
            }}
          >
            <MonoLabel color={amber}>Letter content</MonoLabel>
          </div>
          {/* react-markdown not in deps; render the API's pre-substituted
              markdown as a monospaced pre-block. Whitespace preserved
              so paragraph breaks survive; `bone3` keeps it readable
              against the dark surface without competing with the
              heading hierarchy above. */}
          <pre
            style={{
              fontFamily: fMono,
              fontSize: 13,
              lineHeight: 1.7,
              color: bone3,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
            }}
          >
            {result.renderedMarkdown}
          </pre>
        </section>

        <SignForm token={token} />
      </div>
    </main>
  );
}

function ExpiredOrInvalid() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: ink,
        color: bone,
        fontFamily: fSans,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 520,
          width: '100%',
          border: `1px solid ${rule}`,
          background: ink2,
          padding: 40,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <Diamond size={10} filled={false} />
          <MonoLabel>Link expired</MonoLabel>
        </div>
        <h1
          style={{
            fontFamily: fSerif,
            fontWeight: 300,
            fontSize: 32,
            lineHeight: 1.15,
            margin: '0 0 16px',
            color: bone,
          }}
        >
          This link is no longer valid.
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.7, color: bone2, margin: 0 }}>
          The engagement letter link has expired or could not be found. Contact your R&amp;D
          consultant to have a new letter sent.
        </p>
      </div>
    </main>
  );
}
