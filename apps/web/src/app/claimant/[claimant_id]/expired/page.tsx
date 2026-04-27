import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Expired-link landing — shown after a failed magic-link redeem (T-C11).
 *
 * Server component, no auth gate (the user explicitly doesn't have a
 * session yet). Static copy directing the claimant employee back to
 * their consultant — the firm-side admin re-issues invites via the
 * employees route (F6).
 *
 * Path-segment based (`/claimant/[claimant_id]/expired`) so the URL is
 * still anchored to the claimant context; the layout chrome above can
 * still render the firm's brand (looked up via `claimant_id` →
 * subject_tenant.tenant_id) once C12 lands. For C11 this is the bare
 * minimum so the redeem failure path doesn't 404.
 */
export default function LinkExpiredPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center">Link expired</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-600">
          <p>
            This sign-in link has expired or has already been used. Magic links are valid for 15
            minutes from the time they&apos;re sent.
          </p>
          <p>
            To get a new link, contact your R&amp;D consultant — they can resend the invite from
            their admin dashboard.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
