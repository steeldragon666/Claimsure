import Link from 'next/link';
import {
  amber,
  bone,
  bone2,
  fMono,
  fSans,
  fSerif,
  ink,
  ink2,
  rule,
} from '../../../../consultant/_components/tokens';
import { Diamond, MonoLabel } from '../../../../consultant/_components/atoms';

/**
 * Terminal "signed" page (web fallback for the mobile sign flow).
 *
 * Route: `/engagement/[token]/sign/signed` — PUBLIC, token-gated.
 *
 * The same `[token]` URL segment is reused after signing so the
 * claimant can bookmark / return to this page from the email later
 * and still pull down the rendered PDF. The PDF is exposed by the API
 * at `GET /v1/engagement/[token]/pdf` (task 03 — engagement-letter
 * PDF render job populates `signed_pdf_s3_key`, the route then
 * streams the signed PDF back out under the same token credential).
 *
 * Static page (no server fetch) — keeping it deterministic means a
 * stale browser tab that lands here after the job is still pending
 * will get a redirect or a "still preparing" message from the PDF
 * endpoint itself rather than this page rendering a half-state.
 */

interface Props {
  params: Promise<{ token: string }>;
}

export default async function EngagementSignedPage({ params }: Props) {
  const { token } = await params;
  const pdfHref = `/v1/engagement/${encodeURIComponent(token)}/pdf`;

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
          maxWidth: 560,
          width: '100%',
          border: `1px solid ${rule}`,
          background: ink2,
          padding: 40,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <Diamond size={10} color={amber} />
          <MonoLabel color={amber}>Engagement signed</MonoLabel>
        </div>
        <h1
          style={{
            fontFamily: fSerif,
            fontWeight: 300,
            fontSize: 36,
            lineHeight: 1.1,
            margin: '0 0 16px',
            color: bone,
          }}
        >
          Thank you.
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.7, color: bone2, margin: '0 0 28px' }}>
          Your engagement letter has been signed. A signed PDF copy is being prepared and will be
          available below. Your consultant has been notified.
        </p>
        <Link
          href={pdfHref}
          // Native browser download — the API streams the PDF with a
          // `Content-Disposition: attachment` header so we don't need
          // a `download` attribute, but keeping it makes the intent
          // explicit and lets older browsers fall back gracefully.
          download
          style={{
            display: 'inline-block',
            fontFamily: fMono,
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            padding: '14px 22px',
            background: amber,
            color: ink,
            border: `1px solid ${amber}`,
            textDecoration: 'none',
          }}
        >
          Download signed PDF
        </Link>
      </div>
    </main>
  );
}
