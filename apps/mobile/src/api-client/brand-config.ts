import { getApiBaseUrl } from '../auth/redeem.js';
import type { BrandConfig } from './types.js';

/**
 * Fetch the full brand_config for a tenant (T-C14).
 *
 * Calls the unauthed GET /v1/brand-config/by-tenant/:id endpoint —
 * the same one the mobile app would hit on cold-start for an
 * un-redeemed tenant via custom subdomain. Returns the full
 * BrandConfig (not the trimmed MagicLinkRedeemBrand the redeem
 * response carries).
 *
 * Used by the theme provider to refresh the in-memory brand on
 * session change so colour / logo edits made in the consultant
 * portal flow through to the mobile app on next launch (or on
 * next session refresh — whichever comes first).
 *
 * Throws on non-2xx so callers can decide whether to fall back to
 * the trimmed brand from redeem or to DEFAULT_THEME.
 */
export async function fetchBrandConfigByTenant(tenantId: string): Promise<BrandConfig> {
  const url = `${getApiBaseUrl()}/v1/brand-config/by-tenant/${tenantId}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`brand-config fetch failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { brand_config: BrandConfig };
  return json.brand_config;
}
