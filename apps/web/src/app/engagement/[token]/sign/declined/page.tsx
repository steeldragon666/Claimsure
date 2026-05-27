import {
  bone,
  bone2,
  fSans,
  fSerif,
  ink,
  ink2,
  rule,
  rust,
} from '../../../../consultant/_components/tokens';
import { Diamond, MonoLabel } from '../../../../consultant/_components/atoms';

/**
 * Terminal "declined" page (web fallback for the mobile sign flow).
 *
 * Route: `/engagement/[token]/sign/declined` — PUBLIC, token-gated.
 *
 * Reached either by:
 *   - posting decline successfully from the `<SignForm>` on the
 *     parent /sign page (router.push lands here), or
 *   - revisiting the original signing link after it's been marked
 *     declined — the parent server component sees `status === 'declined'`
 *     and redirects here.
 *
 * Static copy with no action buttons. The claimant has explicitly
 * chosen not to engage; the next step is consultant-mediated (re-issue
 * a new letter or close out the claim) and lives outside this fallback
 * surface. No re-render of the letter — the row's `declined_at` is set
 * and the token is considered consumed for sign/decline purposes.
 */
export default function EngagementDeclinedPage() {
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
          <Diamond size={10} color={rust} />
          <MonoLabel color={rust}>Engagement declined</MonoLabel>
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
          Decline recorded.
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.7, color: bone2, margin: 0 }}>
          You have declined to sign this engagement letter. Your consultant has been notified and
          will be in touch to discuss next steps. You can close this page.
        </p>
      </div>
    </main>
  );
}
