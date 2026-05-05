import type { FastifyInstance } from 'fastify';
import { privilegedSql } from '@cpa/db/client';

/**
 * Onboarding routes (T1.8).
 *
 * Two endpoints for the first-customer white-glove onboarding flow:
 *
 *   GET  /v1/onboarding/status   — Returns a checklist of onboarding steps
 *                                   computed from live database state.
 *   POST /v1/onboarding/complete — Marks onboarding as complete for the
 *                                   current tenant.
 *
 * Auth: both routes require an authenticated session with admin role.
 * The tenant is resolved from `req.user.tenantId` (set by the session
 * plugin via the cpa_session cookie).
 *
 * Data model note: onboarding state is derived from existing tables
 * (tenant, tenant_user, subject_tenant, event, brand_config) — no
 * separate onboarding_checklist table is needed. The only field added
 * to support this flow is `onboarding_completed_at` on the `tenant`
 * table (nullable timestamp, set by POST /complete).
 */

interface OnboardingStepData {
  key: string;
  label: string;
  completed: boolean;
  completedAt: string | null;
}

export interface OnboardingStatusResponse {
  tenantId: string;
  completed: boolean;
  completedAt: string | null;
  steps: OnboardingStepData[];
}

export interface OnboardingCompleteResponse {
  tenantId: string;
  completedAt: string;
}

const errEnvelope = (
  code: string,
  message: string,
  requestId: string,
): { error: string; message: string; requestId: string } => ({
  error: code,
  message,
  requestId,
});

export function registerOnboarding(app: FastifyInstance): void {
  /**
   * GET /v1/onboarding/status
   *
   * Returns the onboarding checklist with completion state for each step.
   * All steps are computed from live database state so the checklist is
   * always current — no stale cache to invalidate.
   */
  app.get('/v1/onboarding/status', async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) {
      return reply
        .code(401)
        .send(errEnvelope('UNAUTHENTICATED', 'Authentication required', req.id));
    }

    if (user.role !== 'admin') {
      return reply
        .code(403)
        .send(errEnvelope('FORBIDDEN', 'Only firm admins can view onboarding status', req.id));
    }

    const tenantId = user.tenantId;

    // Run all checklist queries in parallel for speed.
    const [tenantRows, teamCountRows, claimantRows, eventCountRows, brandRows] = await Promise.all([
      // Step 1: Tenant exists (always true if we got here)
      privilegedSql<{ created_at: Date; onboarding_completed_at: Date | null }[]>`
          SELECT created_at, onboarding_completed_at
            FROM tenant
           WHERE id = ${tenantId}
        `,
      // Step 2: At least one team member besides the admin
      privilegedSql<{ count: number }[]>`
          SELECT count(*)::int AS count
            FROM tenant_user
           WHERE tenant_id = ${tenantId}
             AND deleted_at IS NULL
             AND role != 'admin'
        `,
      // Step 3: At least one claimant subject_tenant
      privilegedSql<{ id: string; created_at: Date }[]>`
          SELECT id, created_at
            FROM subject_tenant
           WHERE tenant_id = ${tenantId}
             AND kind = 'claimant'
             AND deleted_at IS NULL
           LIMIT 1
        `,
      // Step 4: At least one event captured
      privilegedSql<{ count: number; first_at: Date | null }[]>`
          SELECT count(*)::int AS count, min(captured_at) AS first_at
            FROM event
           WHERE tenant_id = ${tenantId}
        `,
      // Step 5: Brand configured (non-default values)
      privilegedSql<{ tenant_id: string; updated_at: Date | null }[]>`
          SELECT tenant_id, updated_at
            FROM brand_config
           WHERE tenant_id = ${tenantId}
           LIMIT 1
        `,
    ]);

    const tenant = tenantRows[0];
    if (!tenant) {
      return reply.code(404).send(errEnvelope('NOT_FOUND', 'Tenant not found', req.id));
    }

    const steps: OnboardingStepData[] = [
      {
        key: 'account_created',
        label: 'Account created',
        completed: true, // always true if session is valid
        completedAt: tenant.created_at.toISOString(),
      },
      {
        key: 'email_verified',
        label: 'Email verified',
        completed: true, // implicit via SSO login
        completedAt: tenant.created_at.toISOString(),
      },
      {
        key: 'team_member_invited',
        label: 'First team member invited',
        completed: (teamCountRows[0]?.count ?? 0) > 0,
        completedAt: null, // We don't track individual invite timestamps here
      },
      {
        key: 'first_claimant_added',
        label: 'First claimant added',
        completed: (claimantRows?.length ?? 0) > 0,
        completedAt: claimantRows[0]?.created_at?.toISOString() ?? null,
      },
      {
        key: 'brand_configured',
        label: 'Brand configured',
        completed: (brandRows?.length ?? 0) > 0,
        completedAt: brandRows[0]?.updated_at?.toISOString() ?? null,
      },
      {
        key: 'first_activity_captured',
        label: 'First activity captured',
        completed: (eventCountRows[0]?.count ?? 0) > 0,
        completedAt: eventCountRows[0]?.first_at?.toISOString() ?? null,
      },
    ];

    const allCompleted = steps.every((s) => s.completed);

    const response: OnboardingStatusResponse = {
      tenantId,
      completed: tenant.onboarding_completed_at !== null || allCompleted,
      completedAt: tenant.onboarding_completed_at?.toISOString() ?? null,
      steps,
    };

    return reply.code(200).send(response);
  });

  /**
   * POST /v1/onboarding/complete
   *
   * Marks the current tenant's onboarding as complete. Idempotent:
   * calling it when already complete returns the existing timestamp.
   *
   * This is a manual "I'm done" signal from the admin. The checklist
   * may still show incomplete steps — that's OK for white-glove
   * onboarding where some steps are handled offline.
   */
  app.post('/v1/onboarding/complete', async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) {
      return reply
        .code(401)
        .send(errEnvelope('UNAUTHENTICATED', 'Authentication required', req.id));
    }

    if (user.role !== 'admin') {
      return reply
        .code(403)
        .send(errEnvelope('FORBIDDEN', 'Only firm admins can complete onboarding', req.id));
    }

    const tenantId = user.tenantId;

    // Idempotent: only set if not already set (COALESCE keeps existing value).
    const rows = await privilegedSql<{ onboarding_completed_at: Date }[]>`
      UPDATE tenant
         SET onboarding_completed_at = COALESCE(onboarding_completed_at, now())
       WHERE id = ${tenantId}
      RETURNING onboarding_completed_at
    `;

    const row = rows[0];
    if (!row) {
      return reply.code(404).send(errEnvelope('NOT_FOUND', 'Tenant not found', req.id));
    }

    const response: OnboardingCompleteResponse = {
      tenantId,
      completedAt: row.onboarding_completed_at.toISOString(),
    };

    return reply.code(200).send(response);
  });
}
