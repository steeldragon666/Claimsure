import { createContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSessionStore } from '../auth/session-store.js';
import { fetchBrandConfigByTenant } from '../api-client/brand-config.js';

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
 * Convert a brand_config's logo_s3_key into a renderable URI.
 *
 * v1: stitches a placeholder S3 hostname onto the key so the
 * <Image> tag has something to load (or skip, if logo_s3_key is
 * null). Once the CDN hostname lands as part of the F-? media
 * pipeline, this becomes a single-line config swap rather than a
 * caller change.
 */
function logoUriFromKey(key: string | null): string | null {
  if (!key) return null;
  return `https://placeholder.s3.amazonaws.com/${key}`;
}

/**
 * Provider wrapped around the entire authed/unauthed tree in
 * app/_layout.tsx.
 *
 * Source of truth (in priority order):
 *   1. Network fetch of /v1/brand-config/by-tenant/:id once a session
 *      lands — picks up consultant-portal edits without waiting for
 *      the next redeem.
 *   2. Trimmed brand_config from the redeem response (already in
 *      session — the colour subset works as a synchronous bootstrap
 *      so the first paint isn't grey).
 *   3. DEFAULT_THEME (this file).
 *
 * The fetch is fire-and-forget; failures fall through to the trimmed
 * brand. The provider never blocks first paint on the network round-
 * trip — that would defeat the per-tenant theming benefit (a slow
 * network would feel worse than no theming).
 *
 * Future extension: when the user is unauthed AND the app is opened
 * via a custom subdomain (`acme.scribe.com.au`), the theme provider
 * should fetch the public brand-config endpoint by hostname before
 * showing the login screen. That requires hostname → tenant_id
 * resolution which lands with Swimlane A; until then unauthed UI uses
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
    // 1. Synchronous bootstrap from the trimmed brand on session.
    const trimmed = session.brand_config;
    setTheme({
      primary_color: trimmed.primary_color,
      accent_color: trimmed.accent_color,
      logo_uri: logoUriFromKey(trimmed.logo_s3_key),
    });

    // 2. Async refresh from the full brand-config endpoint. Cancellation
    // guards against late responses overwriting a more-recent session
    // change (sign-out → fresh sign-in).
    let cancelled = false;
    void (async () => {
      try {
        const full = await fetchBrandConfigByTenant(session.employee.tenant_id);
        if (cancelled) return;
        setTheme({
          primary_color: full.primary_color,
          accent_color: full.accent_color,
          logo_uri: logoUriFromKey(full.logo_s3_key),
        });
      } catch {
        // Swallow — the trimmed brand from step 1 is already applied
        // and DEFAULT_THEME is the worst-case fallback.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  const value = useMemo(() => theme, [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
