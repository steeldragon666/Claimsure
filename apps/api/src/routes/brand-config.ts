import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import {
  checkSubdomainAvailabilityBody,
  updateBrandConfigBody,
  type BrandConfig,
} from '@cpa/schemas';

/**
 * Whitelist of mime types accepted by the logo uploader. Mirrors the
 * client-side `<input accept=…>` and the public mobile + claimant
 * surfaces' image renderer (PNG/JPEG/WEBP/SVG). 2 MB cap is the same
 * size limit consultants will see in the UI — keep both ends in sync.
 */
const LOGO_CONTENT_TYPE = /^image\/(png|jpeg|jpg|webp|svg\+xml)$/;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const logoUploadUrlBody = z.object({
  content_type: z.string().regex(LOGO_CONTENT_TYPE),
  size_bytes: z.number().int().positive().max(LOGO_MAX_BYTES),
});

/**
 * Reserved subdomains (T-C5).
 *
 * Names we own at the platform level — DNS records for `www.platform.com.au`,
 * `api.platform.com.au`, etc. all point at platform infra, so a firm
 * grabbing those would shadow real services. Enforced both in the
 * check-availability endpoint and the PATCH validator (defence in
 * depth — the wizard is the only consumer today, but we never trust
 * the client to filter).
 */
const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'www',
  'api',
  'app',
  'admin',
  'platform',
  'mail',
  'dashboard',
  'support',
  'help',
  'docs',
]);

interface BrandRow {
  tenant_id: string;
  display_name: string;
  primary_color: string;
  accent_color: string;
  logo_s3_key: string | null;
  support_email: string | null;
  terms_of_service_url: string | null;
  custom_subdomain: string | null;
  custom_domain: string | null;
  landing_page_config: unknown;
}

const toApi = (r: BrandRow): BrandConfig => ({
  tenant_id: r.tenant_id,
  display_name: r.display_name,
  primary_color: r.primary_color,
  accent_color: r.accent_color,
  logo_s3_key: r.logo_s3_key,
  support_email: r.support_email,
  terms_of_service_url: r.terms_of_service_url,
  custom_subdomain: r.custom_subdomain,
  custom_domain: r.custom_domain,
  landing_page_config: r.landing_page_config ?? null,
});

/**
 * Register brand-config endpoints (T-F9).
 *
 * Two routes:
 *
 *   GET /v1/brand-config/by-tenant/:id  (UNAUTHED)
 *     Mobile-launch lookup. The mobile app pulls this on first paint
 *     (before redeem) so the splash / sign-in screen is themed. Returns
 *     the public subset only — operational fields stay out.
 *
 *   PATCH /v1/brand-config  (admin-only, scoped to active tenant)
 *     Updates the calling firm's brand_config. Custom-domain editing
 *     goes through the C5-C9 wizard, not here — this endpoint refuses
 *     anything but the editable display fields (Zod .strict() + the
 *     UPDATE statement only touches whitelisted columns).
 */
export function registerBrandConfig(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    '/v1/brand-config/by-tenant/:id',
    async (req, reply) => {
      const { id } = req.params;
      // privilegedSql: this is unauthed, no GUC. The fields we return
      // are public-by-design — same rationale as F4's resolver.
      const rows = await privilegedSql<BrandRow[]>`
        SELECT tenant_id, display_name, primary_color, accent_color,
               logo_s3_key, support_email, terms_of_service_url,
               custom_subdomain, custom_domain, landing_page_config
          FROM brand_config
         WHERE tenant_id = ${id}
      `;
      const row = rows[0];
      if (!row) {
        return reply.status(404).send({
          error: 'brand_config_not_found',
          message: 'No brand_config for that tenant',
          requestId: req.id,
        });
      }
      return { brand_config: toApi(row) };
    },
  );

  app.patch('/v1/brand-config', { preHandler: requireSession }, async (req, reply) => {
    if (req.user!.role !== 'admin') {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Admin role required',
        requestId: req.id,
      });
    }

    const parsed = updateBrandConfigBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message:
          'Body must be a subset of { display_name, primary_color, accent_color, logo_s3_key, support_email, terms_of_service_url, custom_subdomain, landing_page_config }',
        requestId: req.id,
      });
    }
    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({
        error: 'empty_patch',
        message: 'At least one field must be provided',
        requestId: req.id,
      });
    }

    const tenantId = req.user!.tenantId!;

    // Subdomain edits go through the same PATCH path as the display
    // fields, but they need pre-flight uniqueness + reserved-word
    // checks (the DB has a UNIQUE on custom_subdomain so a duplicate
    // would 500 otherwise; surfacing 409 keeps the wizard's error path
    // explicit). Reserved names are enforced server-side because the
    // wizard's check-availability endpoint is the only blocker on the
    // client and it's trivially bypassable.
    if (patch.custom_subdomain !== undefined) {
      if (RESERVED_SUBDOMAINS.has(patch.custom_subdomain)) {
        return reply.status(409).send({
          error: 'subdomain_reserved',
          message: 'That subdomain is reserved for the platform',
          requestId: req.id,
        });
      }
      const existing = await privilegedSql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM brand_config WHERE custom_subdomain = ${patch.custom_subdomain}
      `;
      const conflict = existing[0];
      if (conflict && conflict.tenant_id !== tenantId) {
        return reply.status(409).send({
          error: 'subdomain_taken',
          message: 'That subdomain is already in use by another firm',
          requestId: req.id,
        });
      }
    }

    // Run the PATCH inside an RLS-scoped transaction. The brand_config
    // row's RLS policy already filters by tenant_id, so an admin in
    // firm A literally cannot UPDATE firm B's row through this query
    // (RLS denies the row, RETURNING comes back empty, we 404).
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      // The UPDATE uses COALESCE-on-undefined-bind to keep one
      // statement for any subset of fields. Each ${patch.foo ?? null}
      // pairs with a CASE expression that keeps the existing column
      // value when the patch field was omitted; we send `null`
      // sentinels for the omitted fields and check `${field}_present`
      // to decide.
      //
      // For landing_page_config (jsonb), we pass JSON.stringify when
      // the field is present and null otherwise, matching the existing
      // event.payload pattern.
      const dn = patch.display_name;
      const pc = patch.primary_color;
      const ac = patch.accent_color;
      const lk = patch.logo_s3_key;
      const se = patch.support_email;
      const tu = patch.terms_of_service_url;
      const cs = patch.custom_subdomain;
      const lpcPresent = 'landing_page_config' in patch;
      const lpc = lpcPresent ? JSON.stringify(patch.landing_page_config ?? null) : null;

      const rows = await tx<BrandRow[]>`
        UPDATE brand_config
           SET display_name = COALESCE(${dn ?? null}, display_name),
               primary_color = COALESCE(${pc ?? null}, primary_color),
               accent_color = COALESCE(${ac ?? null}, accent_color),
               logo_s3_key = CASE WHEN ${lk ?? null}::text IS NULL THEN logo_s3_key ELSE ${lk ?? null} END,
               support_email = CASE WHEN ${se ?? null}::text IS NULL THEN support_email ELSE ${se ?? null} END,
               terms_of_service_url = CASE WHEN ${tu ?? null}::text IS NULL THEN terms_of_service_url ELSE ${tu ?? null} END,
               custom_subdomain = CASE WHEN ${cs ?? null}::text IS NULL THEN custom_subdomain ELSE ${cs ?? null} END,
               landing_page_config = CASE WHEN ${lpcPresent} THEN ${lpc}::jsonb ELSE landing_page_config END,
               updated_at = NOW()
         WHERE tenant_id = ${tenantId}
        RETURNING tenant_id, display_name, primary_color, accent_color,
                  logo_s3_key, support_email, terms_of_service_url,
                  custom_subdomain, custom_domain, landing_page_config
      `;
      const row = rows[0];
      if (!row) {
        return reply.status(404).send({
          error: 'brand_config_not_found',
          message: 'No brand_config for the active tenant',
          requestId: req.id,
        });
      }
      return { brand_config: toApi(row) };
    });
  });

  /**
   * POST /v1/brand-config/logo-upload-url  (admin-only)
   *
   * Returns a pre-signed S3 PUT URL the browser uses to upload the
   * logo blob directly. After the PUT succeeds, the client PATCHes
   * /v1/brand-config with `logo_s3_key` to "publish" the new logo.
   *
   * STUB: this task only wires the contract — the real S3 client lands
   * with the storage-infra task. We return a placeholder URL so the
   * client component can flow end-to-end against a known shape, and
   * the s3_key it ships back through PATCH is already the production
   * format (`brand-config/{tenantId}/logo-{uuid}.{ext}`) so DB rows
   * written today don't need re-keying when real S3 lights up.
   */
  app.post(
    '/v1/brand-config/logo-upload-url',
    { preHandler: requireSession },
    async (req, reply) => {
      if (req.user!.role !== 'admin') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin role required',
          requestId: req.id,
        });
      }
      const parsed = logoUploadUrlBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_body',
          message:
            'Body must be { content_type: image/(png|jpeg|jpg|webp|svg+xml), size_bytes: 1..2_097_152 }',
          requestId: req.id,
        });
      }
      const tenantId = req.user!.tenantId!;
      // content_type is image/... — split('/')[1] is always defined.
      const ext = parsed.data.content_type.split('/')[1]!.replace('+xml', '');
      const s3Key = `brand-config/${tenantId}/logo-${crypto.randomUUID()}.${ext}`;
      const upload_url = `https://placeholder.s3.amazonaws.com/${s3Key}?X-Amz-Signature=stub`;
      return { upload_url, s3_key: s3Key };
    },
  );

  /**
   * POST /v1/brand-config/custom-subdomain/check-availability  (admin-only)
   *
   * Wizard pings on every keystroke (debounced 300ms) — `{ subdomain }`
   * in, `{ available }` out. "Available" = format-valid AND not in the
   * reserved set AND not already taken by another firm. The firm's own
   * current subdomain returns `available: true` so re-saving an unchanged
   * value is a no-op rather than a confusing "already taken" error.
   */
  app.post(
    '/v1/brand-config/custom-subdomain/check-availability',
    { preHandler: requireSession },
    async (req, reply) => {
      if (req.user!.role !== 'admin') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin role required',
          requestId: req.id,
        });
      }
      const parsed = checkSubdomainAvailabilityBody.safeParse(req.body);
      if (!parsed.success) {
        // Format failure → not available (with a hint). Wizard surfaces
        // this as the "✗ invalid format" indicator, not a 4xx-flavoured
        // error — the user is mid-typing.
        return { available: false, reason: 'invalid_format' };
      }
      const { subdomain } = parsed.data;
      if (RESERVED_SUBDOMAINS.has(subdomain)) {
        return { available: false, reason: 'reserved' };
      }
      const tenantId = req.user!.tenantId!;
      const rows = await privilegedSql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM brand_config WHERE custom_subdomain = ${subdomain}
      `;
      const owner = rows[0];
      if (!owner) return { available: true };
      // The firm's own slug → still available (no-op save).
      if (owner.tenant_id === tenantId) return { available: true };
      return { available: false, reason: 'taken' };
    },
  );

  // POST /v1/brand-config/custom-domain        → registered in T-C6
  // DELETE /v1/brand-config/custom-domain       → registered in T-C6
  // POST /v1/brand-config/custom-domain/check  → registered in T-C7
  // POST /v1/brand-config/email-sender          → registered in T-C8
  // POST /v1/brand-config/email-sender/check   → registered in T-C9
}
