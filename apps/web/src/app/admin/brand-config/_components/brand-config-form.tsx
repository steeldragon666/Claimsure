'use client';
import { useQuery } from '@tanstack/react-query';
import type { BrandConfig } from '@cpa/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useWhoami } from '@/hooks/use-whoami';
import { getBrandConfig } from '../_lib/api';

/**
 * Brand-config form (T-C1 read-only scaffold).
 *
 * The page wraps this component in <AuthGuard> (matching P1+P2 — see
 * `apps/web/src/app/users/page.tsx`), so this component itself just
 * resolves the active tenant from /v1/whoami and fetches the public
 * brand_config via the unauthed by-tenant endpoint. C2 adds the logo
 * upload, C3 adds the theme picker, C4 adds the editable text fields.
 */
export function BrandConfigForm() {
  const whoami = useWhoami();

  if (whoami.data?.user.role !== 'admin') {
    return <p className="text-slate-500">Admin role required to edit brand settings.</p>;
  }

  const tenantId = whoami.data.user.tenantId;
  if (!tenantId) {
    return <p className="text-slate-500">No active firm. Switch firms from the menu.</p>;
  }

  return <BrandReadView tenantId={tenantId} />;
}

function BrandReadView({ tenantId }: { tenantId: string }) {
  const brand = useQuery({
    queryKey: ['brand-config', tenantId],
    queryFn: () => getBrandConfig(tenantId),
  });

  if (brand.isLoading) {
    return <p className="text-slate-500">Loading brand settings…</p>;
  }
  if (brand.error || !brand.data) {
    return (
      <p className="text-red-500">
        Failed to load brand settings. Refresh to retry.
      </p>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Current settings</CardTitle>
          <CardDescription>
            Editing is disabled in this build. The logo uploader, theme picker, and text fields
            land in C2–C4.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReadOnlyFields config={brand.data} />
        </CardContent>
      </Card>
    </div>
  );
}

function ReadOnlyFields({ config }: { config: BrandConfig }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <Row label="Display name" value={config.display_name} />
      <Row label="Primary color">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-4 w-4 rounded border"
            style={{ backgroundColor: config.primary_color }}
          />
          <code>{config.primary_color}</code>
        </div>
      </Row>
      <Row label="Accent color">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-4 w-4 rounded border"
            style={{ backgroundColor: config.accent_color }}
          />
          <code>{config.accent_color}</code>
        </div>
      </Row>
      <Row label="Logo S3 key" value={config.logo_s3_key ?? '—'} />
      <Row label="Support email" value={config.support_email ?? '—'} />
      <Row label="Terms of service" value={config.terms_of_service_url ?? '—'} />
      <Row label="Custom subdomain" value={config.custom_subdomain ?? '—'} />
      <Row label="Custom domain" value={config.custom_domain ?? '—'} />
    </dl>
  );
}

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <dt className="font-medium text-slate-700">{label}</dt>
      <dd className="text-slate-600">{children ?? value}</dd>
    </>
  );
}
