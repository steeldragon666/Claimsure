import Constants from 'expo-constants';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { MagicLinkRedeemBody, MagicLinkRedeemResponse } from '../api-client/types.js';

/**
 * Resolve the API base URL.
 *
 * Order:
 *   1. EXPO_PUBLIC_API_URL (explicit override; useful for dev / staging)
 *   2. app.json -> expo.extra.apiUrl (set per-build via EAS profiles)
 *   3. Hard fallback (prod hostname)
 */
export function getApiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // `Constants.expoConfig?.extra` is typed `Record<string, any>` by
  // expo-constants, so the property access leaks `any` into our scope.
  // Annotate as `unknown` and let the typeof-string guard narrow it.
  const fromExtra: unknown = Constants.expoConfig?.extra?.apiUrl;
  if (typeof fromExtra === 'string' && fromExtra.length > 0) return fromExtra;
  return 'https://platform.com.au';
}

/**
 * Per-device fingerprint used by the F8 refresh path to detect token
 * theft (refresh from a device different to redemption-time fails 403).
 *
 * iOS: keychain-backed identifierForVendor — stable per app install.
 * Android: ANDROID_ID — stable per app install + device.
 *
 * Both wipe on app reinstall. That's fine: the user just re-redeems
 * a fresh magic link, gets a new mobile_session, and continues.
 */
export async function getDeviceFingerprint(): Promise<string> {
  if (Platform.OS === 'ios') {
    const v = await Application.getIosIdForVendorAsync();
    return v ?? 'unknown-ios-vendor';
  }
  if (Platform.OS === 'android') {
    return Application.getAndroidId() ?? 'unknown-android-id';
  }
  // web fallback — useful for dev only
  return 'web-dev';
}

/**
 * Resolve an Expo Push token, requesting OS permission first.
 *
 * Returns null on:
 *   - Permission denied by the user (iOS prompt or Android settings)
 *   - Web / simulator builds where `getExpoPushTokenAsync` rejects
 *   - Any unexpected error from the Notifications module
 *
 * The redeem path treats null as "no push for this session" — the
 * user can still capture events; the F8 refresh has its own update
 * path for late-arriving tokens (see refreshTokenBody.push_token).
 *
 * Crucially, this never throws — push registration must NOT fail the
 * magic-link redeem. The user got a legitimate magic link; if the OS
 * is in some state that breaks token registration (notification
 * service down, bad project config), they should still be signed in
 * and able to use the app.
 */
export async function getExpoPushTokenSafe(): Promise<string | null> {
  try {
    if (!Constants.isDevice && Platform.OS !== 'android') {
      // Simulators / web have no real APNs/FCM channel — skip the
      // request rather than rejecting noisily.
      return null;
    }

    const settings = await Notifications.getPermissionsAsync();
    let granted =
      settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    if (!granted) {
      const requested = await Notifications.requestPermissionsAsync();
      granted =
        requested.granted ||
        requested.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    }
    if (!granted) return null;

    // EAS project id resolution. `expoConfig.extra.eas.projectId` is the
    // canonical location; `easConfig.projectId` is a legacy mirror still
    // populated in some Expo SDK versions. Both come back as `any` from
    // `expo-constants`'s type defs — narrow to string defensively so an
    // accidentally numeric value can't crash the SDK call.
    const extra: unknown = Constants.expoConfig?.extra;
    const easExtra: unknown =
      extra && typeof extra === 'object' && 'eas' in extra
        ? (extra as { eas?: unknown }).eas
        : undefined;
    const fromExtra =
      easExtra && typeof easExtra === 'object' && 'projectId' in easExtra
        ? (easExtra as { projectId?: unknown }).projectId
        : undefined;
    const legacy: unknown = Constants.easConfig;
    const fromLegacy =
      legacy && typeof legacy === 'object' && 'projectId' in legacy
        ? (legacy as { projectId?: unknown }).projectId
        : undefined;
    const rawProjectId: unknown = fromExtra ?? fromLegacy;
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : undefined;

    const tokenResponse = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    return tokenResponse.data;
  } catch {
    // Notification service errors are non-fatal — see fn docstring.
    return null;
  }
}

/**
 * POST /v1/auth/magic-link/redeem.
 *
 * Wraps the network call so the redeem screen can stay declarative.
 * Returns the typed response or throws (caller is responsible for
 * surfacing the error to the user).
 *
 * If `pushToken` is omitted, the function attempts to acquire one via
 * `getExpoPushTokenSafe()` so the resulting `mobile_session` row gets
 * a non-null push_token from the start. Permission denial / simulator
 * runs leave it null and skip the bind — the user is still redeemed.
 */
export async function redeemMagicLink(args: {
  token: string;
  pushToken?: string;
}): Promise<MagicLinkRedeemResponse> {
  const fingerprint = await getDeviceFingerprint();
  // If the caller didn't pre-fetch the push token, attempt to acquire
  // one now. The acquire helper returns null on permission denial /
  // simulator runs and never throws, so this is a safe one-shot.
  const pushToken = args.pushToken ?? (await getExpoPushTokenSafe());
  const body: MagicLinkRedeemBody = {
    token: args.token,
    device_fingerprint: fingerprint,
    ...(pushToken ? { push_token: pushToken } : {}),
  };

  const url = `${getApiBaseUrl()}/v1/auth/magic-link/redeem`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`magic-link redeem failed (${res.status}): ${text}`);
  }

  return (await res.json()) as MagicLinkRedeemResponse;
}
