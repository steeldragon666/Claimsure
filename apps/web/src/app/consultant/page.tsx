'use client';

/**
 * ArchiveOne broadcast consultant workspace — port of
 * `claimsure-design-export-6/ui_kits/consultant-app/index.html`.
 *
 * The original is a self-contained React-on-Babel-standalone SPA composed
 * of an internal nav state (`view`) and four view components. We preserve
 * the same single-page shape here: a stateful App owns `view`, the TopBar
 * + Sidebar stay mounted, and the right-hand pane swaps between
 * Dashboard / Wizard / Watch / Financing.
 *
 * Routing notes:
 *   - This route lives at `/consultant` and is intentionally separate
 *     from the existing `(claimsure)/*` indigo-glass screens. Both
 *     coexist for now; pick one and retire the other when ready.
 *   - The middleware beta-gate (apps/web/src/middleware.ts) applies to
 *     `/consultant` like any other page — locally NODE_ENV=development
 *     bypasses it. In production the user needs a beta_session cookie.
 */

import { useState } from 'react';
import { TopBar, type ConsultantUser } from './_components/topbar';
import { Sidebar, type ConsultantView } from './_components/sidebar';
import { DashboardView } from './_components/dashboard-view';
import { ClientsView } from './_components/clients-view';
import { WizardView } from './_components/wizard-view';
import { WatchView } from './_components/watch-view';
import { FinancingView } from './_components/financing-view';
import { OnboardingView } from './_components/onboarding-view';
import { bone, fSans, ink } from './_components/tokens';
import { useWhoami, type WhoamiResponse } from '@/hooks/use-whoami';

/**
 * Derive the displayed name + initials from the session. The user table's
 * display_name is often null (magic-link signups don't set it), so we fall
 * back to the email. Initials prefer two name words, else the first two
 * characters of the name basis.
 */
function deriveIdentity(
  displayName: string | null,
  email: string,
): {
  name: string;
  initials: string;
} {
  const name = displayName?.trim() || email;
  const basis = displayName?.trim() || email.split('@')[0] || email;
  const parts = basis.split(/[\s._-]+/).filter(Boolean);
  const initials = (
    parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : basis.slice(0, 2)
  ).toUpperCase();
  return { name, initials };
}

/** Resolve the caller's active firm name from their tenant memberships. */
function resolveFirmName(data: WhoamiResponse | undefined): string {
  if (!data) return '';
  const tenants = data.availableTenants;
  const active =
    tenants.find((t) => t.tenantId === data.user.tenantId) ??
    tenants.find((t) => t.isDefault) ??
    tenants[0];
  return active?.name ?? '';
}

/**
 * Australian financial-year label (e.g. "FY26"). The AU FY runs 1 Jul –
 * 30 Jun, so from July onward we're in the year ending next June.
 */
function currentFyLabel(now = new Date()): string {
  const endYear = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  return `FY${String(endYear).slice(-2)}`;
}

export default function ConsultantWorkspace() {
  const [view, setView] = useState<ConsultantView>('dashboard');
  const { data } = useWhoami();

  const firmName = resolveFirmName(data);
  const { name, initials } = data
    ? deriveIdentity(data.user.displayName, data.user.email)
    : { name: '…', initials: '' };

  const sessionUser: ConsultantUser = {
    name,
    initials,
    firm: firmName.toUpperCase(),
  };

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: ink,
        color: bone,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: fSans,
      }}
    >
      <TopBar user={sessionUser} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar view={view} setView={setView} firm={firmName} fyLabel={currentFyLabel()} />
        <main style={{ flex: 1, background: ink, overflow: 'hidden' }}>
          {view === 'dashboard' && <DashboardView />}
          {/* Clients → Client → Claims → Claim (6-step approve-wizard).
              The real claim workflow lives here (clients-view.tsx). */}
          {view === 'clients' && <ClientsView />}
          {/* Evidence vault + Chain reuse the legacy wizard demo surface
              until their own per-claim views land — they're out of scope
              for this change (consultant claim-workflow IA only). */}
          {view === 'evidence' && <WizardView />}
          {view === 'chain' && <WizardView />}
          {view === 'watch' && <WatchView />}
          {view === 'financing' && <FinancingView />}
          {view === 'setup' && <OnboardingView />}
        </main>
      </div>
    </div>
  );
}
