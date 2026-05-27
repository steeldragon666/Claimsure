'use client';

/**
 * ClaimSure broadcast consultant workspace — port of
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
import { WizardView } from './_components/wizard-view';
import { WatchView } from './_components/watch-view';
import { FinancingView } from './_components/financing-view';
import { bone, fSans, ink } from './_components/tokens';

const DEMO_USER: ConsultantUser = {
  name: 'Anna Pemberton',
  initials: 'AP',
  firm: 'PEMBERTON & COLE',
};

export default function ConsultantWorkspace() {
  const [view, setView] = useState<ConsultantView>('dashboard');

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
      <TopBar user={DEMO_USER} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar view={view} setView={setView} />
        <main style={{ flex: 1, background: ink, overflow: 'hidden' }}>
          {view === 'dashboard' && <DashboardView />}
          {view === 'claims' && <DashboardView />}
          {view === 'wizard' && <WizardView />}
          {view === 'evidence' && <WizardView />}
          {view === 'chain' && <WizardView />}
          {view === 'watch' && <WatchView />}
          {view === 'financing' && <FinancingView />}
        </main>
      </div>
    </div>
  );
}
