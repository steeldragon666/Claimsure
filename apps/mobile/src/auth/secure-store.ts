import * as SecureStore from 'expo-secure-store';

/**
 * Thin wrapper around expo-secure-store for the refresh token.
 *
 * Refresh tokens live in Keychain (iOS) / EncryptedSharedPreferences
 * (Android) — they survive app reinstalls only on Android, but that's
 * fine: a fresh install on iOS just means re-redeeming the magic link.
 *
 * Access tokens NEVER touch secure-store: they're 1h, in-memory only,
 * and refreshed off the persisted refresh token. Storing them on disk
 * is all downside (more attack surface, no UX win).
 *
 * The key string is internal — exported as a const so tests / dev
 * tools can inspect it without re-typing the string.
 */
export const REFRESH_TOKEN_KEY = 'cpa_scribe_refresh_token';

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function setRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

export async function clearRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}
