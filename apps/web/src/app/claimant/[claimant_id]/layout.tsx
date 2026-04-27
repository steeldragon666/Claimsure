/**
 * PWA-claimant layout (T-C12).
 *
 * Pure passthrough — auth gating happens at each page's own server
 * component via `requireClaimantSession()` (in `_lib/auth.ts`). Layouts
 * in App Router run for ALL children including /m (redemption) and
 * /expired (the failure target), so a layout-level redirect-on-missing-
 * cookie would either loop (redirect to /expired which itself redirects
 * because the cookie is still missing) or special-case those routes
 * via brittle path detection.
 *
 * Pages that require a session import `requireClaimantSession()` and
 * call it at the top — that helper redirects to /expired on missing /
 * invalid cookie. /m and /expired skip the helper entirely.
 *
 * This layout exists so the route segment is registered (Next App
 * Router requires a `layout.tsx` to be present for shared metadata or
 * future per-claimant chrome) and to give us a stable place to land
 * page-wide brand theming once it's wired in (e.g. inject CSS variables
 * derived from the firm's primary_color / accent_color).
 */
export default function ClaimantLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
