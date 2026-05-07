'use client';

import { AuthGuard } from '@/components/auth-guard';

/**
 * P9 Phase 3 — Financier portal route-group layout.
 *
 * Minimal chrome, read-only layout for financier partners viewing
 * shared claim data via federation_share. No admin navigation,
 * no edit surfaces — read-only by design.
 *
 * Design system: cream paper base (#FAF8F3), patina green (#5C7A6B),
 * Fraunces serif headings (via font-display utility).
 */
export default function FinancierLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#FAF8F3]">
        <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm">
          <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
            <div>
              <h1 className="text-lg font-display font-semibold text-[#5C7A6B]">CPA Platform</h1>
              <p className="text-xs text-slate-500 font-body">Financier Portal</p>
            </div>
            <span className="inline-flex items-center rounded-full bg-[#5C7A6B]/10 px-3 py-1 text-xs font-medium text-[#5C7A6B]">
              Read-only
            </span>
          </div>
        </header>
        <main className="max-w-5xl mx-auto px-6 py-8">{children}</main>
      </div>
    </AuthGuard>
  );
}
