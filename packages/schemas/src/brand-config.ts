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
 * Public-facing brand-config shape (T-F9).
 *
 * The unauthed GET endpoint returns this subset — display fields, plus
 * the hostnames and the freeform `landing_page_config` jsonb. NEVER
 * includes operational fields (`email_sender_dkim_status`,
 * `custom_domain_acm_arn`, `custom_domain_status`) — those are admin-
 * only and surfaced through a separate /v1/brand-config/admin route in
 * a future task (C7).
 */
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
  .regex(CUSTOM_SUBDOMAIN, 'must be 3-30 chars, lowercase alphanumeric + dashes (no leading/trailing dash)');

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
