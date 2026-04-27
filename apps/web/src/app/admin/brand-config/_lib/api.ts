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

/**
 * Admin-scoped read (T-C6) — same shape as `getBrandConfig` plus the
 * lifecycle fields (`custom_domain_status`) the wizard renders against.
 * The flat public GET intentionally omits these to keep mobile clients
 * lean; this path is the one the admin form uses on initial load.
 */
export async function getAdminBrandConfig(): Promise<BrandConfig> {
  const res = await apiFetch<BrandConfigEnvelope>('/v1/brand-config/admin');
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

/**
 * Custom domain wizard helpers (T-C6).
 *
 * `setCustomDomain` initiates the lifecycle (`cname_pending`) and
 * returns the CNAME record the firm must publish.
 * `disconnectCustomDomain` resets back to `unconfigured` — used by the
 * "Disconnect" button on the active state. The C7 `checkCustomDomain`
 * helper is added in T-C7 once the state machine lands.
 */
export interface CnameRecord {
  name: string;
  type: 'CNAME';
  value: string;
}
export interface SetCustomDomainResponse {
  status: 'cname_pending';
  cname_record: CnameRecord;
  instructions: string;
}

export async function setCustomDomain(custom_domain: string): Promise<SetCustomDomainResponse> {
  return apiFetch<SetCustomDomainResponse>('/v1/brand-config/custom-domain', {
    method: 'POST',
    body: JSON.stringify({ custom_domain }),
  });
}

export async function disconnectCustomDomain(): Promise<{ status: 'unconfigured' }> {
  return apiFetch<{ status: 'unconfigured' }>('/v1/brand-config/custom-domain', {
    method: 'DELETE',
  });
}

/**
 * Trigger the custom-domain state machine (T-C7). Returns the row's
 * status after one advance step plus whether it transitioned. The
 * wizard refetches brand_config when `transitioned: true` so the UI
 * branch (cname_pending → cert_pending → active) re-renders.
 */
export interface CustomDomainCheckResponse {
  status: string;
  transitioned: boolean;
}

export async function checkCustomDomain(): Promise<CustomDomainCheckResponse> {
  return apiFetch<CustomDomainCheckResponse>('/v1/brand-config/custom-domain/check', {
    method: 'POST',
  });
}

/**
 * Email sender wizard helpers (T-C8).
 *
 * `setEmailSender` flips DKIM status to `pending` and returns 3 TXT
 * records to publish. The C9 `checkEmailSender` helper lands with the
 * verification job.
 */
export interface DkimRecord {
  name: string;
  type: 'TXT';
  value: string;
}
export interface SetEmailSenderResponse {
  status: 'pending';
  dkim_records: DkimRecord[];
  instructions: string;
}

export async function setEmailSender(email_sender_domain: string): Promise<SetEmailSenderResponse> {
  return apiFetch<SetEmailSenderResponse>('/v1/brand-config/email-sender', {
    method: 'POST',
    body: JSON.stringify({ email_sender_domain }),
  });
}

/**
 * Trigger the DKIM verification state machine (T-C9). Same shape as
 * `checkCustomDomain` — `{ status, transitioned }`. The wizard
 * refetches brand_config when transitioned:true so the UI flips from
 * pending to verified without waiting for a manual reload.
 */
export interface EmailSenderCheckResponse {
  status: string;
  transitioned: boolean;
}

export async function checkEmailSender(): Promise<EmailSenderCheckResponse> {
  return apiFetch<EmailSenderCheckResponse>('/v1/brand-config/email-sender/check', {
    method: 'POST',
  });
}
