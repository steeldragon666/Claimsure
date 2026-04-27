import { z } from 'zod';
import { employee } from './employee.js';

/**
 * POST /v1/auth/magic-link/redeem (T-F7).
 *
 * The mobile app posts the raw token from the invite email along with a
 * stable per-device fingerprint (Expo `Application.androidId` / iOS
 * keychain UUID) and an optional Expo Push token. The server validates
 * the token, marks it consumed, mints an aud='mobile' access token + a
 * refresh token, and persists the refresh-token hash on a fresh
 * `mobile_session` row.
 *
 * `device_fingerprint` is required so the F8 refresh path can assert it
 * matches on rotation — the magic link itself is single-use, but a
 * stolen refresh-token still benefits from device-binding.
 *
 * `push_token` is optional because the user might decline the push
 * permission prompt; F8 has its own update path for late-arriving tokens.
 */
export const magicLinkRedeemBody = z.object({
  token: z.string().min(1).max(200),
  device_fingerprint: z.string().min(1).max(200),
  push_token: z.string().max(200).optional(),
});
export type MagicLinkRedeemBody = z.infer<typeof magicLinkRedeemBody>;

/**
 * Public brand subset returned with the redeem response. Mirrors what
 * `req.resolvedBrand` exposes — display fields only, no operational
 * fields (DKIM status, ACM ARN). The mobile app uses these to theme
 * the post-login UI before the next /v1/brand-config call.
 */
export const magicLinkRedeemBrand = z.object({
  display_name: z.string(),
  primary_color: z.string(),
  accent_color: z.string(),
  logo_s3_key: z.string().nullable(),
});
export type MagicLinkRedeemBrand = z.infer<typeof magicLinkRedeemBrand>;

/**
 * Response shape: short-lived access_token (1h, aud='mobile') + long-
 * lived refresh_token (90d sliding window in mobile_session) + the
 * employee row + the firm brand. Everything the app needs to bootstrap.
 */
export const magicLinkRedeemResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  employee,
  brand_config: magicLinkRedeemBrand,
});
export type MagicLinkRedeemResponse = z.infer<typeof magicLinkRedeemResponse>;
