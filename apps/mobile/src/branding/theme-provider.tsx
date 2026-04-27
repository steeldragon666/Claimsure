import { createContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSessionStore } from '../auth/session-store.js';

/**
 * Mobile theme — narrow subset of the BrandConfig shape that screens
 * actually need at render time (colors + logo URI). The full
 * BrandConfig is held by the session store; this provider derives a
 * thin view so consumers don't pull the whole object on every render.
 */
export type Theme = {
  primary_color: string;
  accent_color: string;
  logo_uri: string | null;
};

/**
 * Hardcoded fallback used until brand_config arrives.
 *
 * - `#0066cc` matches the AdaptiveIcon background in app.json
 * - `#00a86b` is a generic R&D-tax-y green; firms override it via
 *   /v1/brand-config in the C7 admin route.
 */
export const DEFAULT_THEME: Theme = {
  primary_color: '#0066cc',
  accent_color: '#00a86b',
  logo_uri: null,
};

export const ThemeContext = createContext<Theme>(DEFAULT_THEME);

/**
 * Provider wrapped around the entire authed/unauthed tree in
 * app/_layout.tsx.
 *
 * Source of truth (in priority order):
 *   1. Session brand_config (set at magic-link redemption — F13).
 *   2. Defaults (this file).
 *
 * Future extension: when the user is unauthed AND the app is opened
 * via a custom subdomain (`acme.scribe.com.au`), the theme provider
 * should fetch the public brand-config endpoint by hostname before
 * showing the login screen. That requires an unauthed brand fetch
 * helper which lands with Swimlane A; until then unauthed UI uses
 * defaults.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const session = useSessionStore((s) => s.session);
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    if (!session) {
      setTheme(DEFAULT_THEME);
      return;
    }
    const brand = session.brand_config;
    setTheme({
      primary_color: brand.primary_color,
      accent_color: brand.accent_color,
      // Until F-? wires a CDN URL for logo_s3_key, we surface null.
      // Screens use the display_name as a text fallback.
      logo_uri: null,
    });
  }, [session]);

  const value = useMemo(() => theme, [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
