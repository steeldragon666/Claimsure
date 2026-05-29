'use client';

/**
 * Typed fetchers for the consultant onboarding flow.
 *
 * Every call routes through `apiFetch` (apps/web/src/lib/api.ts), which
 * sends the cpa_session cookie (`credentials: 'include'`), parses the
 * Fastify error envelope into typed errors, and proxies `/v1/*` to the
 * API via the Next rewrite (next.config.ts afterFiles).
 *
 * The endpoints wired here all already exist in apps/api — this module
 * is the web-side contract mirror only; no backend was added.
 *
 *   Agency branding  → GET /v1/brand-config/admin, PATCH /v1/brand-config,
 *                       POST /v1/brand-config/logo-upload-url
 *   Clients          → GET /v1/subject-tenants, POST /v1/subject-tenants
 *   Evidence         → GET /v1/evidence, POST /v1/events (create)
 *   Integrations     → GET /v1/integrations, POST /v1/integrations/:p/connect
 */

import type { BrandConfig, SubjectTenant, IntegrationConnection } from '@cpa/schemas';
import { apiFetch } from '@/lib/api';

/* ───────────────────────────── Agency branding ─────────────────────── */

interface BrandConfigEnvelope {
  brand_config: BrandConfig;
}

export async function getAdminBrandConfig(): Promise<BrandConfig> {
  const res = await apiFetch<BrandConfigEnvelope>('/v1/brand-config/admin');
  return res.brand_config;
}

/**
 * PATCH the calling firm's brand_config. Only the whitelisted display
 * fields are accepted server-side — we send display_name (the agency
 * name) and optionally logo_s3_key after a logo upload.
 */
export async function updateBrandConfig(body: {
  display_name?: string;
  logo_s3_key?: string;
  landing_page_config?: unknown;
}): Promise<BrandConfig> {
  const res = await apiFetch<BrandConfigEnvelope>('/v1/brand-config', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return res.brand_config;
}

export interface LogoUploadUrlResponse {
  upload_url: string;
  s3_key: string;
}

/**
 * Step 1 of the two-step logo upload: ask the API for a pre-signed PUT
 * URL keyed to the tenant + mime. The server currently returns a
 * placeholder S3 URL (real storage lands with the storage-infra task),
 * but the returned `s3_key` is the production key format, so PATCHing it
 * back persists a real value. We attempt the PUT and tolerate failure
 * (placeholder host won't accept it) — the s3_key still publishes.
 */
export async function requestLogoUploadUrl(body: {
  content_type: string;
  size_bytes: number;
}): Promise<LogoUploadUrlResponse> {
  return apiFetch<LogoUploadUrlResponse>('/v1/brand-config/logo-upload-url', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/* ───────────────────────────── Clients ─────────────────────────────── */

interface SubjectTenantsEnvelope {
  subject_tenants: SubjectTenant[];
}
interface SubjectTenantEnvelope {
  subject_tenant: SubjectTenant;
}

export async function listClients(): Promise<SubjectTenant[]> {
  const res = await apiFetch<SubjectTenantsEnvelope>('/v1/subject-tenants?kind=claimant');
  return res.subject_tenants;
}

/**
 * Create a client company (a `claimant` subject_tenant). The API only
 * accepts `{ name, kind }` — ABN and primary-contact have no column on
 * subject_tenant, so when supplied we fold them into the first evidence
 * note for the client (see createClientEvidence) rather than dropping
 * them. Returns the persisted row.
 */
export async function createClient(name: string): Promise<SubjectTenant> {
  const res = await apiFetch<SubjectTenantEnvelope>('/v1/subject-tenants', {
    method: 'POST',
    body: JSON.stringify({ name, kind: 'claimant' }),
  });
  return res.subject_tenant;
}

/* ───────────────────────────── Evidence ────────────────────────────── */

export interface EvidenceItem {
  id: string;
  kind: string;
  captured_at: string;
  payload_excerpt: string;
  claimant: { id: string; name: string };
  classification: { kind: string; confidence: number } | null;
  claim_id: string | null;
}
interface EvidenceFeedEnvelope {
  items: EvidenceItem[];
  next_cursor: string | null;
}

export async function listEvidence(claimantId?: string): Promise<EvidenceItem[]> {
  const qs = claimantId ? `?claimant_ids=${encodeURIComponent(claimantId)}&limit=50` : '?limit=50';
  const res = await apiFetch<EvidenceFeedEnvelope>(`/v1/evidence${qs}`);
  return res.items;
}

/**
 * Create an evidence event for a client. The evidence feed (GET
 * /v1/evidence) is a read projection over the `event` table; the write
 * path is POST /v1/events with `{ subject_tenant_id, raw_text }`. The
 * server classifies the text and extends the per-claimant hash chain.
 */
export async function createEvidence(subjectTenantId: string, rawText: string): Promise<void> {
  await apiFetch<unknown>('/v1/events', {
    method: 'POST',
    body: JSON.stringify({ subject_tenant_id: subjectTenantId, raw_text: rawText }),
  });
}

/* ───────────────────────────── Integrations ────────────────────────── */

interface IntegrationsEnvelope {
  integrations: IntegrationConnection[];
}

export async function listIntegrations(subjectTenantId?: string): Promise<IntegrationConnection[]> {
  // When a client id is given, scope to that client's connections (accounting
  // is per-client). Otherwise return all the firm's connections.
  const qs = subjectTenantId ? `?subject_tenant_id=${encodeURIComponent(subjectTenantId)}` : '';
  const res = await apiFetch<IntegrationsEnvelope>(`/v1/integrations${qs}`);
  return res.integrations;
}

/**
 * Initiate an OAuth connect for an accounting provider. Returns the
 * provider authorize URL the browser should redirect to.
 *
 * NOTE on providers: the integration_connection provider enum is
 * ['docusign','employment_hero','keypay','deputy','xero_payroll']. There
 * is no bare 'xero' or 'myob'. Xero accounting maps to 'xero_payroll'
 * (the only Xero-family provider). MYOB has no enum value yet — calling
 * it returns 400 invalid_provider, which the caller surfaces as "not yet
 * configured". Even for valid providers, OAuth client IDs aren't set in
 * prod, so connect returns 412 provider_not_configured — handled
 * gracefully by the UI.
 */
export async function connectIntegration(
  provider: string,
  subjectTenantId?: string,
): Promise<{ redirect_url: string }> {
  // Accounting/payroll providers bind to a client; pass subject_tenant_id so
  // the server stores the token against that client.
  return apiFetch<{ redirect_url: string }>(
    `/v1/integrations/${encodeURIComponent(provider)}/connect`,
    {
      method: 'POST',
      ...(subjectTenantId ? { body: JSON.stringify({ subject_tenant_id: subjectTenantId }) } : {}),
    },
  );
}
