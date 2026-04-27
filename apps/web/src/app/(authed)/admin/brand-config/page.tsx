import { Suspense } from 'react';
import { BrandConfigForm } from './_components/brand-config-form.js';

/**
 * /admin/brand-config — firm-level white-label settings (T-C1).
 *
 * Server-component shell. The actual form is a client component (it
 * needs TanStack Query for the read + react-hook-form for the edit, and
 * resolves the active tenant from useWhoami). This shell only renders
 * the page chrome + Suspense boundary so the rest of the route tree
 * isn't blocked on client hydration.
 *
 * C1 scaffolds the page and wires the read; C2-C4 layer in logo
 * upload, theme picker, and the text fields (display_name, support_
 * email, terms_of_service_url).
 */
export default function BrandConfigPage() {
  return (
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
  );
}
