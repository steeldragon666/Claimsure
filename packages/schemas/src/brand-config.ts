import { z } from 'zod';
import { Uuid } from './primitives.js';

/**
 * Hex-color regex (T-F9). Mirrors the DB CHECK on
 * `brand_config.primary_color` / `accent_color` (migration 0008).
 *
 * 6-digit only; 3-digit shorthand (`#fff`) is rejected to keep the
 * format normalised across UI (mobile clients lerp / blend these and
 * the math is simpler with full 6 digits).
 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const hexColor = z.string().regex(HEX_COLOR, 'must be a 6-digit hex color like #00aaff');

/**
 * Custom-domain lifecycle status (T-C6 / T-C7). Mirrors
 * `brand_config.custom_domain_status` in the DB schema. The state
 * machine drives transitions:
 *   unconfigured → cname_pending → cert_pending → active
 *                                              ↘  failed
 */
export const customDomainStatus = z.enum([
  'unconfigured',
  'cname_pending',
  'cert_pending',
  'active',
  'failed',
]);
export type CustomDomainStatusValue = z.infer<typeof customDomainStatus>;

/**
 * DKIM verification status (T-C8 / T-C9). Mirrors
 * `brand_config.email_sender_dkim_status` in the DB schema. Lifecycle:
 *   unconfigured → pending → verified | failed
 *
 * v1 stub flips pending → verified directly via the C9 manual check;
 * real DNS TXT lookup + DKIM token validation lands with the SES
 * wiring task.
 */
export const dkimStatus = z.enum(['unconfigured', 'pending', 'verified', 'failed']);
export type DkimStatusValue = z.infer<typeof dkimStatus>;

export const brandConfig = z.object({
  tenant_id: Uuid,
  display_name: z.string(),
  primary_color: hexColor,
  accent_color: hexColor,
  logo_s3_key: z.string().nullable(),
  support_email: z.string().email().nullable(),
  terms_of_service_url: z.string().url().nullable(),
  custom_subdomain: z.string().nullable(),
  custom_domain: z.string().nullable(),
  /**
   * Lifecycle status — surfaced on admin endpoints only (PATCH response,
   * future admin-GET). Public unauthed GET intentionally omits it; the
   * mobile app doesn't need state-machine internals to render a logo.
   * `.optional()` here so `BrandConfig` is the same type either side of
   * the privacy boundary.
   */
  custom_domain_status: customDomainStatus.optional(),
  /**
   * Email sender + DKIM status — admin-only on the same boundary as
   * custom_domain_status. The wizard reads these to decide whether to
   * render the "set sender" form or the "verify TXT" instructions.
   */
  email_sender_domain: z.string().nullable().optional(),
  email_sender_dkim_status: dkimStatus.optional(),
  landing_page_config: z.unknown().nullable(),
});
export type BrandConfig = z.infer<typeof brandConfig>;

/**
 * Subdomain regex (T-C5).
 *
 * 3-30 chars, alphanumeric + dashes, no leading/trailing dash. The
 * format is shared between the wizard's check-availability endpoint
 * and the PATCH validator so a pasted slug from the URL bar can't
 * sneak in via the flat PATCH route either.
 */
const CUSTOM_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
export const customSubdomain = z
  .string()
  .regex(
    CUSTOM_SUBDOMAIN,
    'must be 3-30 chars, lowercase alphanumeric + dashes (no leading/trailing dash)',
  );

/**
 * PATCH body (T-F9 / T-C5).
 *
 * Editable subset for the admin-PATCH route. Custom-domain lifecycle
 * (the CNAME / ACM / CloudFront state machine) goes through the
 * dedicated POST endpoints in the C6-C9 wizard, not this PATCH —
 * `custom_subdomain` is the one wizard field that's safe to flat-PATCH
 * because it has no DNS / cert side effects, just a uniqueness check.
 *
 * `landing_page_config` is `unknown` — schema-on-read jsonb. Validation
 * of the shape inside happens at the landing-page renderer.
 */
export const updateBrandConfigBody = z
  .object({
    display_name: z.string().min(1).max(200).optional(),
    primary_color: hexColor.optional(),
    accent_color: hexColor.optional(),
    /**
     * Set by the logo-upload flow (T-C2): the client first POSTs to
     * `/v1/brand-config/logo-upload-url` for a pre-signed PUT URL +
     * tenant-scoped key, then PATCHes here with the returned key. The
     * server validates the shape but does NOT verify that the object
     * exists in S3 yet — that lands with the storage-infra task.
     */
    logo_s3_key: z.string().min(1).max(500).optional(),
    support_email: z.string().email().optional(),
    terms_of_service_url: z.string().url().optional(),
    /**
     * Set by the custom-subdomain wizard (T-C5). Format-validated here +
     * uniqueness-checked server-side; a 409 surfaces back through the
     * mutation if another firm grabbed the slug between availability
     * check and save.
     */
    custom_subdomain: customSubdomain.optional(),
    landing_page_config: z.unknown().optional(),
  })
  .strict();
export type UpdateBrandConfigBody = z.infer<typeof updateBrandConfigBody>;

/**
 * Check-availability body (T-C5).
 *
 * Wizard pings this on every keystroke (debounced 300ms). Reserved-word
 * filtering happens server-side — the regex catches format issues, the
 * RESERVED_SUBDOMAINS set catches names we own at the platform level
 * (www, api, app, admin, …).
 */
export const checkSubdomainAvailabilityBody = z
  .object({
    subdomain: customSubdomain,
  })
  .strict();
export type CheckSubdomainAvailabilityBody = z.infer<typeof checkSubdomainAvailabilityBody>;

/**
 * Custom-domain regex (T-C6).
 *
 * Lowercase FQDN, 4-253 chars, at least one label + TLD ≥2 chars.
 * Mirrors the server-side validator on POST /v1/brand-config/custom-domain.
 * Pure-format check — actual ownership / reachability is verified by
 * the C7 state machine via DNS CNAME resolution.
 */
const CUSTOM_DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}$/;
export const customDomain = z
  .string()
  .min(4)
  .max(253)
  .regex(CUSTOM_DOMAIN, 'must be a lowercase FQDN like platform.acme.com.au');

/**
 * Custom-domain initiation body (T-C6).
 *
 * Wizard POSTs here; server sets `custom_domain` + `custom_domain_status`
 * to `cname_pending` and returns the CNAME instructions the firm must
 * publish. The state machine (T-C7) flips it to `cert_pending` once the
 * CNAME resolves to our platform target.
 */
export const setCustomDomainBody = z
  .object({
    custom_domain: customDomain,
  })
  .strict();
export type SetCustomDomainBody = z.infer<typeof setCustomDomainBody>;

/**
 * Email-sender domain body (T-C8).
 *
 * Sets `email_sender_domain` + flips `email_sender_dkim_status` to
 * `pending`; the response carries 3 placeholder DKIM records the firm
 * publishes. Real DKIM token generation lands with the SES wiring task.
 */
export const setEmailSenderBody = z
  .object({
    email_sender_domain: customDomain,
  })
  .strict();
export type SetEmailSenderBody = z.infer<typeof setEmailSenderBody>;
