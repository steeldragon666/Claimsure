'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { BrandConfig } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useWhoami } from '@/hooks/use-whoami';
import { getAdminBrandConfig, updateBrandConfig } from '../_lib/api';
import { CustomDomainWizard } from './custom-domain-wizard';
import { CustomSubdomainWizard } from './custom-subdomain-wizard';
import { EmailSenderWizard } from './email-sender-wizard';
import { LogoUpload } from './logo-upload';
import { ThemePicker } from './theme-picker';

/**
 * Brand-config form (T-C1 / T-C2 / T-C3 / T-C4).
 *
 * The page wraps this component in <AuthGuard> (matching P1+P2 — see
 * `apps/web/src/app/users/page.tsx`), so this component itself just
 * resolves the active tenant from /v1/whoami and fetches the public
 * brand_config via the unauthed by-tenant endpoint.
 *
 * Layout (top to bottom):
 *   1. Read-only summary of current settings.
 *   2. <LogoUpload>         — pre-signed S3 PUT (C2).
 *   3. <ThemePicker>        — primary + accent colors with preview (C3).
 *   4. <DetailsForm>        — display_name, support_email, ToS URL (C4).
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
    queryFn: () => getAdminBrandConfig(),
  });

  if (brand.isLoading) {
    return <p className="text-slate-500">Loading brand settings…</p>;
  }
  if (brand.error || !brand.data) {
    return <p className="text-red-500">Failed to load brand settings. Refresh to retry.</p>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Current settings</CardTitle>
          <CardDescription>Read-only snapshot of the active brand_config row.</CardDescription>
        </CardHeader>
        <CardContent>
          <ReadOnlyFields config={brand.data} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Logo</CardTitle>
          <CardDescription>
            PNG/JPEG/WEBP/SVG, up to 2 MB. Replaces the firm&apos;s logo across the mobile app and
            claimant dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LogoUpload currentLogo={brand.data.logo_s3_key} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>
            Pick the primary and accent colors used across mobile + web. Live preview updates as you
            type.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ThemePicker primary={brand.data.primary_color} accent={brand.data.accent_color} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>
            Display name shows in the mobile app header. Support email + terms-of-service link
            appear in the claimant onboarding flow.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DetailsForm config={brand.data} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>White-label subdomain</CardTitle>
          <CardDescription>
            Pick a subdomain on platform.com.au. Mobile employees and claimants reach your firm at{' '}
            <code>your-firm.platform.com.au</code>. 3-30 characters, lowercase letters / digits /
            dashes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CustomSubdomainWizard currentSubdomain={brand.data.custom_subdomain} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Custom domain (optional)</CardTitle>
          <CardDescription>
            Bring your own domain — e.g. <code>platform.acmeconsulting.com.au</code>. We&apos;ll
            verify a CNAME record at your DNS provider, then issue an SSL certificate automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CustomDomainWizard
            currentDomain={brand.data.custom_domain}
            currentStatus={brand.data.custom_domain_status ?? 'unconfigured'}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Email sender domain</CardTitle>
          <CardDescription>
            Send transactional emails (magic links, invites) from your own domain. Publish 3 DKIM
            TXT records to authorise <code>mail.your-firm.com</code> as a sender.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmailSenderWizard
            currentDomain={brand.data.email_sender_domain ?? null}
            currentStatus={brand.data.email_sender_dkim_status ?? 'unconfigured'}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Editable text fields (T-C4): display_name, support_email,
 * terms_of_service_url. Schema validates each field's shape; empty
 * string is treated as "leave unset" by the submit handler, which
 * filters those out before PATCH so the server's `.strict()`
 * validator doesn't see optional fields the user didn't touch.
 */
const DetailsSchema = z.object({
  display_name: z.string().min(1, 'Required').max(200),
  support_email: z.union([z.literal(''), z.string().email('Must be a valid email')]),
  terms_of_service_url: z.union([z.literal(''), z.string().url('Must be a valid URL')]),
});
type DetailsValues = z.infer<typeof DetailsSchema>;

function DetailsForm({ config }: { config: BrandConfig }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const form = useForm<DetailsValues>({
    resolver: zodResolver(DetailsSchema),
    defaultValues: {
      display_name: config.display_name,
      support_email: config.support_email ?? '',
      terms_of_service_url: config.terms_of_service_url ?? '',
    },
  });

  const save = useMutation({
    mutationFn: (values: DetailsValues) => {
      // Empty strings stand in for "no change" — the server-side
      // `.strict()` schema rejects unknown keys, but `support_email`
      // and `terms_of_service_url` are optional, so omitting them when
      // blank is the right move.
      const patch: Parameters<typeof updateBrandConfig>[0] = {
        display_name: values.display_name,
      };
      if (values.support_email !== '') patch.support_email = values.support_email;
      if (values.terms_of_service_url !== '')
        patch.terms_of_service_url = values.terms_of_service_url;
      return updateBrandConfig(patch);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['brand-config'] });
      toast({ title: 'Brand updated' });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      }),
  });

  return (
    <Form {...form}>
      <form
        onSubmit={(e) => void form.handleSubmit((v) => save.mutate(v))(e)}
        className="space-y-4"
      >
        <FormField
          control={form.control}
          name="display_name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Display name</FormLabel>
              <FormControl>
                <Input placeholder="Acme Tax Co." {...field} />
              </FormControl>
              <FormDescription>Shown in the mobile app header.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="support_email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Support email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="help@acme.com" {...field} />
              </FormControl>
              <FormDescription>
                Where claimants email for help. Leave blank to omit.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="terms_of_service_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Terms of service URL</FormLabel>
              <FormControl>
                <Input type="url" placeholder="https://acme.com/tos" {...field} />
              </FormControl>
              <FormDescription>
                Linked from the mobile sign-in screen. Leave blank to omit.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save details'}
        </Button>
      </form>
    </Form>
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
