import { create } from 'zustand';
import type { Employee, BrandConfig } from '../api-client/types.js';
import { setRefreshToken, clearRefreshToken } from './secure-store.js';

export type Session = {
  access_token: string;
  refresh_token: string;
  /** ms epoch — when the access_token expires (server gives 1h windows). */
  access_token_expires_at: number;
  employee: Employee;
  brand_config: BrandConfig;
};

type SessionState = {
  session: Session | null;
  setSession: (s: Session | null) => void;
  clearSession: () => void;
};

/**
 * In-memory session store + side-effecting persistence to expo-secure-
 * store for the refresh token only. Access tokens are 1h and live in
 * memory; we re-mint them off the persisted refresh on next launch.
 *
 * `setSession` and `clearSession` fire-and-forget the secure-store
 * write — the UI doesn't need to wait for Keychain. Errors are
 * swallowed because there's nothing useful the UI can do about a
 * keychain failure mid-session; the next refresh will surface it.
 */
export const useSessionStore = create<SessionState>((set) => ({
  session: null,
  setSession: (s) => {
    set({ session: s });
    if (s) {
      void setRefreshToken(s.refresh_token).catch(() => {
        // intentional swallow — see header comment
      });
    } else {
      void clearRefreshToken().catch(() => {});
    }
  },
  clearSession: () => {
    set({ session: null });
    void clearRefreshToken().catch(() => {});
  },
}));
