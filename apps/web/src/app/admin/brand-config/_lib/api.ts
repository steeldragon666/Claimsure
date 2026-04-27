'use client';
import type { BrandConfig, UpdateBrandConfigBody } from '@cpa/schemas';
import { apiFetch } from '@/lib/api';

/**
 * Brand-config typed fetchers (T-C1).
 *
 * The two endpoints landed in F9:
 *
 *   GET   /v1/brand-config/by-tenant/:id   (UNAUTHED, public subset)
 *   PATCH /v1/brand-config                  (admin-only, scoped via session)
 *
 * Both wrap the row in `{ brand_config: BrandConfig }` — see
 * `apps/api/src/routes/brand-config.ts`. We unwrap here so call-sites
 * deal with the flat shape and the query cache keys on `BrandConfig`.
 */

interface BrandConfigEnvelope {
  brand_config: BrandConfig;
}

export async function getBrandConfig(tenantId: string): Promise<BrandConfig> {
  const res = await apiFetch<BrandConfigEnvelope>(`/v1/brand-config/by-tenant/${tenantId}`);
  return res.brand_config;
}

export async function updateBrandConfig(body: UpdateBrandConfigBody): Promise<BrandConfig> {
  const res = await apiFetch<BrandConfigEnvelope>('/v1/brand-config', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return res.brand_config;
}
