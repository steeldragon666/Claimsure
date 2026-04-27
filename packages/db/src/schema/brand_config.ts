import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenant } from './tenant.js';

/**
 * White-label config per consultant firm (Q7d=C "full" per design doc §1).
 *
 * `tenant_id` is BOTH PK and FK to `tenant.id` — exactly one brand_config
 * row per firm, lifetime-bound to the tenant.
 *
 * Custom-domain lifecycle is a state machine driven by pg-boss jobs (per
 * design doc §6): `unconfigured` → `cname_pending` (owner creates DNS
 * record) → `cert_pending` (ACM issues cert) → `active` (CloudFront has
 * cert and domain) | `failed` (any step errored).
 *
 * `email_sender_dkim_status` tracks the same state machine for outbound
 * email DKIM verification — independent of custom-domain lifecycle.
 *
 * Colors (`primary_color`, `accent_color`) default to the platform palette;
 * a CHECK constraint (T-F2) enforces `^#[0-9a-fA-F]{6}$` (6-digit hex).
 *
 * `landing_page_config` jsonb is the freeform per-firm landing page
 * customisation (hero text, feature toggles, testimonials). Schema-on-read.
 *
 * RLS-protected (T-F2): tenant_id =
 *   current_setting('app.current_tenant_id', true)::uuid
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */
export const DKIM_STATUSES = ['unconfigured', 'pending', 'verified', 'failed'] as const;
export type DkimStatus = (typeof DKIM_STATUSES)[number];

export const CUSTOM_DOMAIN_STATUSES = [
  'unconfigured',
  'cname_pending',
  'cert_pending',
  'active',
  'failed',
] as const;
export type CustomDomainStatus = (typeof CUSTOM_DOMAIN_STATUSES)[number];

export const brandConfig = pgTable('brand_config', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenant.id),
  displayName: text('display_name').notNull(),
  logoS3Key: text('logo_s3_key'),
  primaryColor: text('primary_color').notNull().default('#0066cc'),
  accentColor: text('accent_color').notNull().default('#00a86b'),
  emailSenderDomain: text('email_sender_domain'),
  emailSenderDkimStatus: text('email_sender_dkim_status', { enum: DKIM_STATUSES })
    .notNull()
    .default('unconfigured'),
  supportEmail: text('support_email'),
  termsOfServiceUrl: text('terms_of_service_url'),
  customSubdomain: text('custom_subdomain').unique(),
  customDomain: text('custom_domain').unique(),
  customDomainAcmArn: text('custom_domain_acm_arn'),
  customDomainStatus: text('custom_domain_status', { enum: CUSTOM_DOMAIN_STATUSES })
    .notNull()
    .default('unconfigured'),
  landingPageConfig: jsonb('landing_page_config'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
