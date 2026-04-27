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

/**
 * Logo upload (T-C2).
 *
 * Two-step: ask the API for a pre-signed S3 URL keyed to the tenant +
 * mime, then PUT the blob directly. After the PUT succeeds the caller
 * patches /v1/brand-config with the returned `s3_key`. The current
 * server returns a placeholder URL — see api/routes/brand-config.ts —
 * so the PUT is intentionally skipped client-side until real S3 wires
 * up. Both ends speak the same shape today so the cutover is data-only.
 */
export interface LogoUploadUrlBody {
  content_type: string;
  size_bytes: number;
}

export interface LogoUploadUrlResponse {
  upload_url: string;
  s3_key: string;
}

export async function requestLogoUploadUrl(
  body: LogoUploadUrlBody,
): Promise<LogoUploadUrlResponse> {
  return apiFetch<LogoUploadUrlResponse>('/v1/brand-config/logo-upload-url', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Custom subdomain wizard helpers (T-C5).
 *
 * `checkSubdomainAvailability` is the debounced live indicator's source;
 * the server returns `{ available, reason? }` where `reason` is one of
 * `invalid_format` / `reserved` / `taken` for client-side messaging.
 *
 * Saving uses the regular `updateBrandConfig` PATCH — `custom_subdomain`
 * is whitelisted in `updateBrandConfigBody` and the server runs the
 * uniqueness check inline (returns 409 on conflict).
 */
export type SubdomainAvailabilityReason = 'invalid_format' | 'reserved' | 'taken';
export interface SubdomainAvailabilityResponse {
  available: boolean;
  reason?: SubdomainAvailabilityReason;
}

export async function checkSubdomainAvailability(
  subdomain: string,
): Promise<SubdomainAvailabilityResponse> {
  return apiFetch<SubdomainAvailabilityResponse>(
    '/v1/brand-config/custom-subdomain/check-availability',
    {
      method: 'POST',
      body: JSON.stringify({ subdomain }),
    },
  );
}
