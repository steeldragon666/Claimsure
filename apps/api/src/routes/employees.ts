import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { sql, privilegedSql } from '@cpa/db/client';
import {
  PAYROLL_PROVIDERS,
  createEmployeeBody,
  listEmployeesQuery,
  type Employee,
  type PayrollProvider,
} from '@cpa/schemas';
import { sendEmail } from '@cpa/integrations/email';

interface RawEmployeeRow {
  id: string;
  subject_tenant_id: string;
  tenant_id: string;
  email: string;
  name: string;
  job_title: string | null;
  payroll_external_id: string | null;
  payroll_provider: PayrollProvider | null;
  invited_at: Date | string;
  invited_by_user_id: string;
  first_seen_at: Date | string | null;
  last_seen_at: Date | string | null;
  deactivated_at: Date | string | null;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : isoOf(v));

const coercePayrollProvider = (v: string | null): PayrollProvider | null => {
  // Defensive: the DB CHECK already restricts payroll_provider to the
  // PAYROLL_PROVIDERS set, so this only fires if someone bypassed
  // migrations. Surface a 500 at the route boundary rather than silently
  // emitting an off-spec response.
  if (v === null) return null;
  if ((PAYROLL_PROVIDERS as readonly string[]).includes(v)) return v as PayrollProvider;
  throw new Error(`row has invalid payroll_provider: ${v}`);
};

const toApi = (r: RawEmployeeRow): Employee => {
  return {
    id: r.id,
    subject_tenant_id: r.subject_tenant_id,
    tenant_id: r.tenant_id,
    email: r.email,
    name: r.name,
    job_title: r.job_title,
    payroll_external_id: r.payroll_external_id,
    payroll_provider: coercePayrollProvider(r.payroll_provider),
    invited_at: isoOf(r.invited_at),
    invited_by_user_id: r.invited_by_user_id,
    first_seen_at: isoOrNull(r.first_seen_at),
    last_seen_at: isoOrNull(r.last_seen_at),
    deactivated_at: isoOrNull(r.deactivated_at),
  };
};

/**
 * Generate a single-use magic-link token for `employeeId`.
 *
 * - Raw token: 32 bytes of CSPRNG entropy, base64url-encoded → 43 chars.
 * - Token hash: hex SHA-256 of the raw token; only the hash is stored.
 * - Expiry: 15 minutes from now (matches design doc §3.1).
 *
 * Returns the raw token so the caller can stitch it into the email body.
 * The DB row is inserted via `privilegedSql` because invites can race
 * with brand_config / employee creation in the same flow — keeping the
 * insert RLS-bypassing means we don't have to thread a tx in.
 */
async function issueMagicLinkToken(employeeId: string): Promise<{ rawToken: string }> {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await privilegedSql`
    INSERT INTO magic_link_token (id, employee_id, token_hash, expires_at)
    VALUES (${crypto.randomUUID()}, ${employeeId}, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz)
  `;
  return { rawToken };
}

/**
 * Compose + send the invite email. The deep-link URL is rendered with the
 * firm's `brand_config.custom_subdomain` (or `custom_domain` once C5-C9
 * lands) so employees see a branded URL. Hostname comes from the request's
 * `req.resolvedBrand` if set, else the platform default.
 *
 * Console-stub for P3; SES wiring lands in C10-C11.
 */
async function sendInviteEmail(args: {
  to: string;
  employeeName: string;
  rawToken: string;
  brandHost: string | null;
  tenantId: string;
}): Promise<void> {
  const host = args.brandHost ?? 'platform.com.au';
  const link = `https://${host}/m/redeem?token=${encodeURIComponent(args.rawToken)}`;
  const body = [
    `Hello ${args.employeeName},`,
    '',
    'You have been invited to capture R&D evidence on the mobile app.',
    `Open this link on your phone within 15 minutes to activate:`,
    '',
    link,
    '',
    'If the link expires, your firm administrator can resend it.',
  ].join('\n');
  await sendEmail({
    to: args.to,
    subject: 'Activate your mobile capture access',
    body,
    tenantId: args.tenantId,
  });
}

/**
 * Resolve a brand-host string for the invite email. We prefer the request-
 * resolved brand (if the consultant happens to be using their own
 * sub-domain) and fall back to the firm's configured custom_subdomain
 * looked up directly. Either way the URL points at the firm's mobile
 * landing page so the brand is recognisable in the inbox.
 */
async function resolveBrandHostForTenant(tenantId: string): Promise<string | null> {
  const rows = await privilegedSql<
    { custom_subdomain: string | null; custom_domain: string | null }[]
  >`
    SELECT custom_subdomain, custom_domain FROM brand_config WHERE tenant_id = ${tenantId}
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.custom_domain) return row.custom_domain;
  if (row.custom_subdomain) return `${row.custom_subdomain}.platform.com.au`;
  return null;
}

/**
 * Register the employee-management routes (T-F6).
 *
 * Auth: requireSession + admin-or-consultant gating on mutations.
 *   - Viewers can list/detail (their UI shows the team) but cannot
 *     invite/resend.
 *
 * RLS: every query inside `sql.begin` sets `app.current_tenant_id` so
 * subject_tenant_employee rows are tenant-scoped. The magic-link insert
 * uses privilegedSql (no tenant context needed there since the row is
 * looked up by hash, not by tenant).
 */
export function registerEmployees(app: FastifyInstance): void {
  app.post('/v1/employees', { preHandler: requireSession }, async (req, reply) => {
    const role = req.user!.role;
    if (role !== 'admin' && role !== 'consultant') {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Admin or consultant role required',
        requestId: req.id,
      });
    }

    const parsed = createEmployeeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message:
          'Body must be { subject_tenant_id, email, name, job_title?, payroll_external_id?, payroll_provider? }',
        requestId: req.id,
      });
    }
    const { subject_tenant_id, email, name, job_title, payroll_external_id, payroll_provider } =
      parsed.data;
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    // Confirm the subject_tenant is visible under RLS — guards against
    // cross-firm subject_tenant_id (404) AND being asked to invite under
    // a deleted claimant (also 404).
    const subjectVisible = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM subject_tenant
         WHERE id = ${subject_tenant_id} AND deleted_at IS NULL
      `;
      return rows[0] != null;
    });
    if (!subjectVisible) {
      return reply.status(404).send({
        error: 'subject_tenant_not_found',
        message: 'No subject_tenant with that id in this firm',
        requestId: req.id,
      });
    }

    // Insert the employee. Unique constraint
    // `subject_tenant_employee_active_email_unique` enforces uniqueness
    // on (subject_tenant_id, email) WHERE deactivated_at IS NULL — we
    // catch the constraint violation and surface 409.
    let inserted: RawEmployeeRow | null = null;
    try {
      inserted = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawEmployeeRow[]>`
          INSERT INTO subject_tenant_employee (
            id, subject_tenant_id, tenant_id, email, name, job_title,
            payroll_external_id, payroll_provider, invited_by_user_id
          )
          VALUES (
            ${crypto.randomUUID()}, ${subject_tenant_id}, ${tenantId}, ${email}, ${name},
            ${job_title ?? null}, ${payroll_external_id ?? null},
            ${payroll_provider ?? null}, ${userId}
          )
          RETURNING id, subject_tenant_id, tenant_id, email, name, job_title,
                    payroll_external_id, payroll_provider, invited_at,
                    invited_by_user_id, first_seen_at, last_seen_at, deactivated_at
        `;
        return rows[0] ?? null;
      });
    } catch (err) {
      // Postgres unique-violation. The active-email partial unique index
      // is the only unique we can collide with on this insert.
      if ((err as { code?: string }).code === '23505') {
        return reply.status(409).send({
          error: 'employee_email_taken',
          message: 'An active employee with that email already exists for this claimant',
          requestId: req.id,
        });
      }
      throw err;
    }
    if (!inserted) {
      throw new Error('POST /v1/employees: INSERT returned no row');
    }

    // Issue the magic-link token + send invite email. Both are best-
    // effort from the route's POV: a console-stub email never throws, so
    // any failure here is a real DB issue and surfaces as 500.
    const { rawToken } = await issueMagicLinkToken(inserted.id);
    const brandHost = await resolveBrandHostForTenant(tenantId);
    await sendInviteEmail({
      to: email,
      employeeName: name,
      rawToken,
      brandHost,
      tenantId,
    });

    return reply.status(201).send({ employee: toApi(inserted) });
  });

  app.get('/v1/employees', { preHandler: requireSession }, async (req, reply) => {
    const parsed = listEmployeesQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: 'Query must match { subject_tenant_id?: uuid }',
        requestId: req.id,
      });
    }
    const { subject_tenant_id } = parsed.data;
    const tenantId = req.user!.tenantId!;

    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const rows = subject_tenant_id
        ? await tx<RawEmployeeRow[]>`
            SELECT id, subject_tenant_id, tenant_id, email, name, job_title,
                   payroll_external_id, payroll_provider, invited_at,
                   invited_by_user_id, first_seen_at, last_seen_at, deactivated_at
              FROM subject_tenant_employee
             WHERE subject_tenant_id = ${subject_tenant_id}
               AND deactivated_at IS NULL
             ORDER BY invited_at ASC
          `
        : await tx<RawEmployeeRow[]>`
            SELECT id, subject_tenant_id, tenant_id, email, name, job_title,
                   payroll_external_id, payroll_provider, invited_at,
                   invited_by_user_id, first_seen_at, last_seen_at, deactivated_at
              FROM subject_tenant_employee
             WHERE deactivated_at IS NULL
             ORDER BY invited_at ASC
          `;
      return { employees: rows.map(toApi) };
    });
  });

  app.get<{ Params: { id: string } }>(
    '/v1/employees/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;
      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<RawEmployeeRow[]>`
          SELECT id, subject_tenant_id, tenant_id, email, name, job_title,
                 payroll_external_id, payroll_provider, invited_at,
                 invited_by_user_id, first_seen_at, last_seen_at, deactivated_at
            FROM subject_tenant_employee
           WHERE id = ${id}
        `;
        const row = rows[0];
        if (!row) {
          return reply.status(404).send({
            error: 'employee_not_found',
            message: 'No employee with that id in this firm',
            requestId: req.id,
          });
        }
        return { employee: toApi(row) };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/employees/:id/invite',
    { preHandler: requireSession },
    async (req, reply) => {
      const role = req.user!.role;
      if (role !== 'admin' && role !== 'consultant') {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Admin or consultant role required',
          requestId: req.id,
        });
      }
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      // Re-load the employee under RLS — 404 on missing OR cross-firm.
      // Active-only: deactivated employees shouldn't get re-invited
      // through this endpoint.
      const row = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string; email: string; name: string }[]>`
          SELECT id, email, name FROM subject_tenant_employee
           WHERE id = ${id} AND deactivated_at IS NULL
        `;
        return rows[0] ?? null;
      });
      if (!row) {
        return reply.status(404).send({
          error: 'employee_not_found',
          message: 'No active employee with that id in this firm',
          requestId: req.id,
        });
      }

      const { rawToken } = await issueMagicLinkToken(row.id);
      const brandHost = await resolveBrandHostForTenant(tenantId);
      await sendInviteEmail({
        to: row.email,
        employeeName: row.name,
        rawToken,
        brandHost,
        tenantId,
      });
      return reply.status(202).send({ ok: true });
    },
  );
}
