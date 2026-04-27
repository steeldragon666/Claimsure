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
 * PATCH body (T-F9).
 *
 * Editable subset for the admin-PATCH route. Custom-domain editing
 * (`custom_subdomain` / `custom_domain`) goes through the C5-C9 wizard
 * not this endpoint — those fields ride along with a state machine
 * (DNS verify → ACM cert → CloudFront), so a flat PATCH would skip the
 * lifecycle.
 *
 * `landing_page_config` is `unknown` — schema-on-read jsonb. Validation
 * of the shape inside happens at the landing-page renderer.
 */
export const updateBrandConfigBody = z
  .object({
    display_name: z.string().min(1).max(200).optional(),
    primary_color: hexColor.optional(),
    accent_color: hexColor.optional(),
    support_email: z.string().email().optional(),
    terms_of_service_url: z.string().url().optional(),
    landing_page_config: z.unknown().optional(),
  })
  .strict();
export type UpdateBrandConfigBody = z.infer<typeof updateBrandConfigBody>;
