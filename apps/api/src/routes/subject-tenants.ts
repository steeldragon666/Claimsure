import type { FastifyInstance } from 'fastify';
import { requireSession } from '@cpa/auth';
import { verifyChain } from '@cpa/db';
import { sql } from '@cpa/db/client';
import { createSubjectTenantBody, listSubjectTenantsQuery, type SubjectTenant } from '@cpa/schemas';

interface RawSubjectTenantRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: 'claimant' | 'financier';
  created_at: Date | string;
  updated_at: Date | string;
}

const isoOf = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());

const toApi = (r: RawSubjectTenantRow): SubjectTenant => ({
  id: r.id,
  tenant_id: r.tenant_id,
  name: r.name,
  kind: r.kind,
  created_at: isoOf(r.created_at),
  updated_at: isoOf(r.updated_at),
});

/**
 * Register the subject-tenant routes (list / create / detail / chain-status).
 *
 * Auth: requireSession (any tenant_user with an active firm). Admin/consultant
 * gating happens per-route where mutations are involved (create).
 *
 * RLS: every query runs inside `sql.begin` with `set_config('app.current_tenant_id',
 * tenantId, true)` so the SELECTs are tenant-scoped. We don't rely on the
 * session middleware's `set_config` because postgres-js connection pooling
 * makes session-scoped GUCs unreliable across pool checkouts.
 */
export function registerSubjectTenants(app: FastifyInstance): void {
  app.get('/v1/subject-tenants', { preHandler: requireSession }, async (req, reply) => {
    const parsed = listSubjectTenantsQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: 'Query must match { kind?: "claimant" | "financier" }',
        requestId: req.id,
      });
    }
    const { kind } = parsed.data;
    const tenantId = req.user!.tenantId!;

    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      const rows = kind
        ? await tx<RawSubjectTenantRow[]>`
            SELECT id, tenant_id, name, kind, created_at, updated_at
              FROM subject_tenant
             WHERE kind = ${kind}
               AND deleted_at IS NULL
             ORDER BY created_at ASC
          `
        : await tx<RawSubjectTenantRow[]>`
            SELECT id, tenant_id, name, kind, created_at, updated_at
              FROM subject_tenant
             WHERE deleted_at IS NULL
             ORDER BY created_at ASC
          `;

      return { subject_tenants: rows.map(toApi) };
    });
  });

  app.post('/v1/subject-tenants', { preHandler: requireSession }, async (req, reply) => {
    // role gating: read-only viewers can't create claimants. Admin and
    // consultant both can — admins get implicit access to all claimants
    // anyway (see subject_tenant_user.ts default-access semantics), and
    // consultants need to be able to onboard a new claimant they're
    // assigned to.
    const role = req.user!.role;
    if (role !== 'admin' && role !== 'consultant') {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Admin or consultant role required',
        requestId: req.id,
      });
    }

    const parsed = createSubjectTenantBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        message: 'Body must be { name: string (1..200), kind?: "claimant"|"financier" }',
        requestId: req.id,
      });
    }

    const { name, kind } = parsed.data;
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      // Duplicate-name check within firm (the schema doesn't enforce a
      // (tenant_id, name) unique index — see subject_tenant.ts — so we
      // enforce in app code under transaction). RLS already restricts the
      // SELECT to the active firm, so the check is implicitly per-firm.
      const dupes = await tx<{ id: string }[]>`
        SELECT id FROM subject_tenant
         WHERE name = ${name} AND deleted_at IS NULL
      `;
      if (dupes[0]) {
        return reply.status(409).send({
          error: 'duplicate_name',
          message: `A subject_tenant with name "${name}" already exists in this firm`,
          requestId: req.id,
        });
      }

      const newId = crypto.randomUUID();
      const inserted = await tx<
        {
          id: string;
          tenant_id: string;
          name: string;
          kind: 'claimant' | 'financier';
          created_at: Date | string;
          updated_at: Date | string;
        }[]
      >`
        INSERT INTO subject_tenant (id, tenant_id, name, kind)
        VALUES (${newId}, ${tenantId}, ${name}, ${kind})
        RETURNING id, tenant_id, name, kind, created_at, updated_at
      `;
      if (!inserted[0]) {
        throw new Error('POST /v1/subject-tenants: INSERT returned no row');
      }

      // ACL row: the creator gets 'lead' role on this claimant. The
      // subject_tenant_user.role enum is ('lead' | 'observer') — the plan-
      // spec mentions 'owner' but the schema (T7, db/schema/subject_tenant_user.ts)
      // doesn't include that value, so 'lead' is the schema-correct
      // equivalent (primary consultant on the claimant, full access).
      await tx`
        INSERT INTO subject_tenant_user (id, subject_tenant_id, user_id, role)
        VALUES (${crypto.randomUUID()}, ${newId}, ${userId}, 'lead')
      `;

      return reply.status(201).send({ subject_tenant: toApi(inserted[0]) });
    });
  });

  app.get<{ Params: { id: string } }>(
    '/v1/subject-tenants/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

        const rows = await tx<RawSubjectTenantRow[]>`
          SELECT id, tenant_id, name, kind, created_at, updated_at
            FROM subject_tenant
           WHERE id = ${id} AND deleted_at IS NULL
        `;
        if (!rows[0]) {
          return reply.status(404).send({
            error: 'subject_tenant_not_found',
            message: 'No subject_tenant with that id in this firm',
            requestId: req.id,
          });
        }

        // Aggregates: total events on this chain + the chain head hash
        // (latest event ordered by captured_at, received_at, id — same key
        // the chain helper uses). RLS confines both to the active firm.
        const counts = await tx<{ event_count: string }[]>`
          SELECT COUNT(*)::text AS event_count
            FROM event
           WHERE subject_tenant_id = ${id}
        `;
        const heads = await tx<{ hash: string }[]>`
          SELECT hash FROM event
           WHERE subject_tenant_id = ${id}
           ORDER BY captured_at DESC, received_at DESC, id DESC
           LIMIT 1
        `;

        return {
          subject_tenant: toApi(rows[0]),
          event_count: Number(counts[0]?.event_count ?? '0'),
          head_hash: heads[0]?.hash ?? null,
        };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/subject-tenants/:id/chain-status',
    { preHandler: requireSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenantId = req.user!.tenantId!;

      // First confirm the subject is visible under RLS (returns 404 for
      // unknown OR cross-firm). This guards against verifyChain quietly
      // returning verified=true/event_count=0 if the GUC weren't set on
      // its connection — we'd rather surface a 404 than a misleading
      // "clean chain" response.
      const visible = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM subject_tenant
           WHERE id = ${id} AND deleted_at IS NULL
        `;
        return rows[0] != null;
      });
      if (!visible) {
        return reply.status(404).send({
          error: 'subject_tenant_not_found',
          message: 'No subject_tenant with that id in this firm',
          requestId: req.id,
        });
      }

      // verifyChain runs via privilegedSql (RLS-bypass) — auth boundary is
      // the 404 visibility check above, not the GUC. No further set_config
      // needed.
      const status = await verifyChain(id);
      return status;
    },
  );
}
