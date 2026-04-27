import type { FastifyInstance, FastifyRequest } from 'fastify';
import { privilegedSql } from '@cpa/db/client';

/**
 * Hostname → tenant resolver (T-F4).
 *
 * Mobile / public-marketing requests arrive at firm-branded hostnames
 * (e.g. `acme.platform.com.au` or a fully-custom `accounts.acme.com.au`).
 * The middleware looks the host up in `brand_config` and attaches a
 * `resolvedBrand` to `req` so downstream handlers (brand-config GET,
 * landing-page rendering, magic-link redeem) can theme themselves
 * without re-doing the lookup.
 *
 * Subdomain match (`<slug>.platform.com.au`) takes precedence over
 * `custom_domain` exact-match — a firm with both configured uses the
 * subdomain lookup as the canonical route, the custom domain is just a
 * vanity alias that still resolves the same tenant.
 *
 * Why `privilegedSql` rather than the `cpa_app` pool: this hook runs
 * BEFORE any session / GUC is set, so RLS on `brand_config` would hide
 * every row. The fields we read (`display_name`, colors, `logo_s3_key`)
 * are public-by-design — they are rendered on the unauthenticated
 * landing page — so RLS-bypass via the privileged client is acceptable.
 * Operational fields (DKIM status, ACM ARN) are NEVER returned through
 * `req.resolvedBrand` so they cannot leak.
 */
const SUBDOMAIN_RE = /^([a-z0-9-]+)\.platform\.com\.au$/i;

export interface ResolvedBrand {
  tenant_id: string;
  display_name: string;
  primary_color: string;
  accent_color: string;
  logo_s3_key: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    resolvedBrand?: ResolvedBrand;
  }
}

interface BrandLookupRow {
  tenant_id: string;
  display_name: string;
  primary_color: string;
  accent_color: string;
  logo_s3_key: string | null;
}

/**
 * Strip the optional `:port` suffix (e.g. `acme.platform.com.au:3000` in
 * dev) before matching. Cloudflare / App Runner strip the port in
 * production, so the no-port case dominates — but tests inject hostnames
 * via `Host` directly and the dev server runs on :3000.
 */
const stripPort = (host: string): string => host.split(':', 1)[0] ?? '';

export function registerHostnameTenantResolver(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const rawHost = (req.headers.host ?? '').toLowerCase();
    if (!rawHost) return;
    const host = stripPort(rawHost);
    // Bare `platform.com.au` is the platform default — no firm scope. We
    // also short-circuit empty / whitespace-only hosts that survived the
    // header parse.
    if (!host || host === 'platform.com.au') return;

    const subdomainMatch = host.match(SUBDOMAIN_RE);
    if (subdomainMatch) {
      // capture group 1 in SUBDOMAIN_RE is `([a-z0-9-]+)` — guaranteed
      // present when match succeeds. The `?? ''` keeps TS happy under
      // `noUncheckedIndexedAccess` without inflating the runtime path.
      const slug = subdomainMatch[1] ?? '';
      const rows = await privilegedSql<BrandLookupRow[]>`
        SELECT tenant_id, display_name, primary_color, accent_color, logo_s3_key
          FROM brand_config
         WHERE custom_subdomain = ${slug}
      `;
      const row = rows[0];
      if (row) {
        req.resolvedBrand = {
          tenant_id: row.tenant_id,
          display_name: row.display_name,
          primary_color: row.primary_color,
          accent_color: row.accent_color,
          logo_s3_key: row.logo_s3_key,
        };
      }
      // If a `*.platform.com.au` subdomain doesn't match, we deliberately
      // do NOT fall through to `custom_domain` lookup — the wildcard
      // belongs to us, an unknown subdomain is just unconfigured.
      return;
    }

    // Custom-domain match (e.g. `accounts.acme.com.au`). Exact match only;
    // the firm's onboarding wizard (C5-C9) writes the canonical lowercase
    // string on activation.
    const rows = await privilegedSql<BrandLookupRow[]>`
      SELECT tenant_id, display_name, primary_color, accent_color, logo_s3_key
        FROM brand_config
       WHERE custom_domain = ${host}
    `;
    const row = rows[0];
    if (row) {
      req.resolvedBrand = {
        tenant_id: row.tenant_id,
        display_name: row.display_name,
        primary_color: row.primary_color,
        accent_color: row.accent_color,
        logo_s3_key: row.logo_s3_key,
      };
    }
  });
}
