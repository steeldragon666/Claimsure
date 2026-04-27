import { z } from 'zod';

/**
 * POST /v1/auth/refresh (T-F8 + T-A12).
 *
 * Mobile clients hit this every ~50 minutes to swap a soon-to-expire
 * access token for a fresh one. Each refresh ALSO rotates the refresh
 * token (the previous one is invalidated by the hash overwrite) and
 * extends the session expiry by another 90 days — a sliding window so
 * an active user never has to re-redeem a magic link.
 *
 * `device_fingerprint` is required and MUST match the value stored on
 * the mobile_session row at redemption-time. Mismatch → 403 (not 401):
 * the token is structurally valid, but it's being used from a device
 * different to the one the session is bound to. F5 verifier rejects on
 * the access-token side; this is the equivalent gate on refresh.
 *
 * `push_token` is OPTIONAL — when present, the server updates the
 * mobile_session row's push_token column. This is the late-arrival
 * path: the user redeemed the magic-link before granting push
 * permission, so the F7 redeem captured a session without a token;
 * once they accept the OS prompt the next refresh carries the new
 * Expo Push token. Subsequent refreshes can also rotate the token
 * (Expo issues new ones occasionally).
 */
export const refreshTokenBody = z.object({
  refresh_token: z.string().min(1).max(200),
  device_fingerprint: z.string().min(1).max(200),
  push_token: z.string().max(200).optional(),
});
export type RefreshTokenBody = z.infer<typeof refreshTokenBody>;

/**
 * Response shape: rotated refresh_token + a fresh 1h access_token. Same
 * shape as the magic-link redeem trims to (no employee / brand — those
 * don't change between refreshes; the app holds onto the originals).
 */
export const refreshTokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
});
export type RefreshTokenResponse = z.infer<typeof refreshTokenResponse>;
