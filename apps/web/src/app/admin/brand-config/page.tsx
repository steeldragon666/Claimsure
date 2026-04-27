'use client';
import { Suspense } from 'react';
import { AuthGuard } from '@/components/auth-guard';
import { BrandConfigForm } from './_components/brand-config-form';

/**
 * /admin/brand-config — firm-level white-label settings (T-C1).
 *
 * Wraps content in <AuthGuard>, matching the P1+P2 flat-route convention
 * used by `/users`, `/tenants`, and `/subject-tenants` (no `(authed)`
 * route group). Render structure:
 *
 *   AuthGuard → page chrome (h1 + description) → Suspense → form.
 *
 * The form is a client component because it pulls TanStack Query for the
 * read + react-hook-form for the edit, and resolves the active tenant
 * from useWhoami. C1 scaffolds the page; C2-C4 layer in logo upload,
 * theme picker, and the text fields (display_name, support_email,
 * terms_of_service_url).
 */
export default function BrandConfigPage() {
  return (
    <AuthGuard>
      <main className="container mx-auto py-8 px-4 space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">Brand &amp; White-Label</h1>
          <p className="text-sm text-muted-foreground">
            Configure your firm&apos;s logo, colors, and branding. The mobile app and claimant
            dashboard inherit these settings.
          </p>
        </div>
        <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
          <BrandConfigForm />
        </Suspense>
      </main>
    </AuthGuard>
  );
}
