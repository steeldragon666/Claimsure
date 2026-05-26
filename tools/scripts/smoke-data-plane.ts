#!/usr/bin/env tsx
/**
 * Data-plane smoke check — exercise the read endpoints that live behind a
 * session cookie, asserting both HTTP status and response shape.
 *
 *   pnpm exec tsx --env-file-if-exists=../../.env smoke-data-plane.ts
 *
 * Companion to chore/signup-smoke-check (Codex's branch), which covers the
 * unauthenticated auth surface (signup, verify-email, login). This script
 * deliberately does NOT touch any auth endpoint — it assumes a session
 * cookie has already been minted and just walks the data plane.
 *
 * Inputs:
 *   SMOKE_BASE_URL          — API base URL.   Default: http://localhost:3000
 *   SMOKE_SESSION_COOKIE    — value of the cpa_session cookie (the JWT).
 *                             If unset, the script prints instructions for
 *                             running mint-dev-cookie.ts and exits with 2.
 *   SMOKE_COOKIE_NAME       — cookie name.    Default: cpa_session
 *                             (matches SESSION_COOKIE_NAME in apps/api.)
 *
 * Endpoints (one per step, in order):
 *   1. GET /healthz                — { status: 'ok', service: 'api', ... }
 *   2. GET /v1/whoami              — { user: { id, email, ... }, ... }
 *   3. GET /v1/subject-tenants     — { subject_tenants: [...] }
 *   4. GET /v1/claims              — { claims: [...] }
 *   5. GET /v1/projects            — { projects: [...] }
 *   6. GET /v1/employees           — { employees: [...] }
 *
 * Note on step 6: there is no top-level GET /v1/expenditures in the codebase
 * (expenditures list lives under /v1/claims/:id/expenditures, which would
 * require fetching a claim id first and isn't a top-level health signal).
 * /v1/employees is the closest top-level session-scoped list endpoint and
 * exercises the same RLS path expenditures would, so it stands in.
 *
 * Output:
 *   [N/6] GET /endpoint  ->  HTTP 200  schema OK  (elapsed Nms)
 *   ...
 *   5 of 6 endpoints passed | 1 failed (3.2s elapsed)
 *
 * Exit code = number of failed endpoints (0 = all pass).
 *
 * Bails on the first 5xx — those mean the API is down, not a data-shape
 * issue, so further steps would just produce noise.
 */
import { z } from 'zod';

const BASE_URL = process.env['SMOKE_BASE_URL'] ?? 'http://localhost:3000';
const COOKIE_NAME = process.env['SMOKE_COOKIE_NAME'] ?? 'cpa_session';
const COOKIE_VALUE = process.env['SMOKE_SESSION_COOKIE'];

if (!COOKIE_VALUE) {
  process.stderr.write(
    [
      '',
      'SMOKE_SESSION_COOKIE is not set.',
      '',
      'This smoke check exercises endpoints behind a session cookie. Mint',
      'one first with the dev-cookie tool, then export it:',
      '',
      '  pnpm exec tsx --env-file=../../.env tools/scripts/mint-dev-cookie.ts',
      '',
      '  # Copy the JWT it prints (the "Raw JWT" line) and:',
      '  export SMOKE_SESSION_COOKIE="<paste-jwt-here>"',
      `  export SMOKE_BASE_URL="${BASE_URL}"  # optional; defaults to localhost:3000`,
      '  pnpm exec tsx --env-file-if-exists=../../.env tools/scripts/smoke-data-plane.ts',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

// ── Response schemas ────────────────────────────────────────────────────
//
// Inline so this script has no @cpa/schemas dependency — keeps the smoke
// check stable across schema-package refactors. Each schema asserts the
// minimum shape the dashboard actually consumes; unknown extra keys are
// allowed (zod default).

const HealthzShape = z.object({
  status: z.literal('ok'),
  service: z.literal('api'),
  processUptimeSeconds: z.number().nonnegative(),
});

const WhoamiShape = z.object({
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    tenantId: z.string().nullable(),
    role: z.string().nullable(),
  }),
  availableTenants: z.array(z.unknown()),
});

const SubjectTenantsShape = z.object({
  subject_tenants: z.array(
    z.object({
      id: z.string().uuid(),
      tenant_id: z.string().uuid(),
      name: z.string(),
      kind: z.enum(['claimant', 'financier']),
      created_at: z.string(),
      updated_at: z.string(),
    }),
  ),
});

const ClaimsShape = z.object({
  claims: z.array(
    z.object({
      id: z.string().uuid(),
      tenant_id: z.string().uuid(),
      subject_tenant_id: z.string().uuid(),
      fiscal_year: z.number().int(),
      stage: z.string(),
    }),
  ),
});

const ProjectsShape = z.object({
  projects: z.array(
    z.object({
      id: z.string().uuid(),
      tenant_id: z.string().uuid(),
      subject_tenant_id: z.string().uuid(),
      name: z.string(),
    }),
  ),
});

const EmployeesShape = z.object({
  employees: z.array(
    z.object({
      id: z.string().uuid(),
      subject_tenant_id: z.string().uuid(),
      tenant_id: z.string().uuid(),
      email: z.string(),
    }),
  ),
});

interface Step {
  path: string;
  schema: z.ZodTypeAny;
}

const STEPS: Step[] = [
  { path: '/healthz', schema: HealthzShape },
  { path: '/v1/whoami', schema: WhoamiShape },
  { path: '/v1/subject-tenants', schema: SubjectTenantsShape },
  { path: '/v1/claims', schema: ClaimsShape },
  { path: '/v1/projects', schema: ProjectsShape },
  { path: '/v1/employees', schema: EmployeesShape },
];

const TOTAL = STEPS.length;
const cookieHeader = `${COOKIE_NAME}=${COOKIE_VALUE}`;

interface StepResult {
  ok: boolean;
  status: number;
  reason?: string;
  elapsedMs: number;
}

async function runStep(step: Step): Promise<StepResult> {
  const start = Date.now();
  const url = `${BASE_URL}${step.path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        cookie: cookieHeader,
        accept: 'application/json',
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: `network error: ${err instanceof Error ? err.message : String(err)}`,
      elapsedMs: Date.now() - start,
    };
  }

  const elapsedMs = Date.now() - start;

  if (res.status >= 500) {
    return {
      ok: false,
      status: res.status,
      reason: `5xx — bailing (platform-down, not a data-shape issue)`,
      elapsedMs,
    };
  }
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore — body is best-effort
    }
    const snippet = body.length > 160 ? `${body.slice(0, 160)}...` : body;
    return {
      ok: false,
      status: res.status,
      reason: `HTTP ${res.status}${snippet ? ` — ${snippet}` : ''}`,
      elapsedMs,
    };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      reason: `response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      elapsedMs,
    };
  }

  const parsed = step.schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : '(root)';
    return {
      ok: false,
      status: res.status,
      reason: `schema mismatch at ${where}: ${issue?.message ?? 'unknown'}`,
      elapsedMs,
    };
  }

  return { ok: true, status: res.status, elapsedMs };
}

// ── Driver ──────────────────────────────────────────────────────────────

const overallStart = Date.now();
let passed = 0;
let failed = 0;
let bailed = false;

for (let i = 0; i < STEPS.length; i += 1) {
  const step = STEPS[i]!;
  const stepNum = `[${i + 1}/${TOTAL}]`;
  const result = await runStep(step);

  if (result.ok) {
    process.stdout.write(
      `${stepNum} GET ${step.path}  ->  HTTP ${result.status}  schema OK  (${result.elapsedMs}ms)\n`,
    );
    passed += 1;
  } else {
    process.stdout.write(
      `${stepNum} GET ${step.path}  ->  HTTP ${result.status}  FAIL: ${result.reason ?? 'unknown'}  (${result.elapsedMs}ms)\n`,
    );
    failed += 1;
    if (result.status >= 500) {
      // Don't run the remaining steps — count them as un-run, not failed.
      bailed = true;
      const remaining = TOTAL - (i + 1);
      if (remaining > 0) {
        process.stdout.write(
          `... skipping ${remaining} remaining step${remaining === 1 ? '' : 's'} (bailed on 5xx)\n`,
        );
      }
      break;
    }
  }
}

const overallSec = ((Date.now() - overallStart) / 1000).toFixed(1);
const summary = bailed
  ? `${passed} of ${TOTAL} endpoints passed | ${failed} failed | bailed on 5xx (${overallSec}s elapsed)`
  : `${passed} of ${TOTAL} endpoints passed | ${failed} failed (${overallSec}s elapsed)`;
process.stdout.write(`\n${summary}\n`);

// Exit code = number of failed endpoints. 0 = all pass.
process.exit(failed);
