import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
// Side-effect import — @fastify/cookie augments FastifyRequest with `cookies`.
// We don't register it here (the host app does), but TypeScript needs the
// declaration merge at compile time.
import '@fastify/cookie';
import { sql } from '@cpa/db/client';
import { verifySession, type VerifiedSession } from './jwt.js';

export interface SessionPluginOptions {
  secret: string;
  cookieName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
      tenantId: string | null;
      role: 'admin' | 'consultant' | 'viewer' | null;
    };
  }
}

const clearSessionCookie = (reply: FastifyReply, name: string): void => {
  void reply.header('set-cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
};

const sessionImpl = (app: FastifyInstance, opts: SessionPluginOptions): Promise<void> => {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const cookieValue = req.cookies[opts.cookieName];
    if (!cookieValue) {
      // Anonymous request — req.user stays undefined; routes that need
      // auth check req.user themselves and 401 if missing.
      return;
    }

    let claims: VerifiedSession;
    try {
      claims = await verifySession(cookieValue, opts.secret);
    } catch {
      clearSessionCookie(reply, opts.cookieName);
      void reply
        .status(401)
        .send({ error: 'invalid_session', message: 'Session invalid or expired' });
      return reply;
    }

    req.user = {
      id: claims.sub,
      email: claims.email,
      tenantId: claims.activeTenantId,
      role: claims.activeRole,
    };

    // Set the connection's app.current_tenant_id GUC so subsequent SQL
    // queries from this request are RLS-scoped. Session-scoped (is_local
    // = false) — the onResponse hook below resets it before the
    // connection returns to the pool. Migration 0003 wraps current_setting
    // in NULLIF so empty-string ('') correctly resolves to NULL → policy
    // excludes rows (correct fail-safe).
    //
    // P5 Task 2.1: also set `app.current_firm_id` in parallel. The
    // audit_log table is firm-scoped (its RLS policy keys on
    // current_setting('app.current_firm_id')) — see
    // packages/db/migrations/0022_audit_log_table.sql. In this codebase,
    // "firm" = `tenant` (the consultant firm / white-label root), so the
    // firm GUC carries the same uuid as the tenant GUC. Two GUCs (not one)
    // so future phases can introduce a "platform admin acting as firm X"
    // stance where the two diverge without retrofitting every audit-log
    // query. The fail-safe pattern (unset → NULLIF → policy denies all)
    // mirrors `app.current_tenant_id`.
    if (claims.activeTenantId !== null) {
      await sql`SELECT set_config('app.current_tenant_id', ${claims.activeTenantId}, false)`;
      await sql`SELECT set_config('app.current_firm_id', ${claims.activeTenantId}, false)`;
    }
  });

  app.addHook('onResponse', async () => {
    // Connection-state hygiene: clear both GUCs so a subsequent request
    // that doesn't set them sees the fail-safe NULL/'' behavior. Both
    // are reset (not just tenant) to avoid one connection's stale firm
    // GUC leaking into a later request that runs an audit_log query
    // without re-setting it — the very leak risk register §3 calls out.
    await sql`SELECT set_config('app.current_tenant_id', '', false)`;
    await sql`SELECT set_config('app.current_firm_id', '', false)`;
  });

  return Promise.resolve();
};

export const sessionPlugin = fp(sessionImpl, {
  name: 'cpa-session',
  fastify: '5.x',
});
