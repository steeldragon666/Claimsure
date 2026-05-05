#!/usr/bin/env tsx
/**
 * Periodic reconciler for prompt-suggestion PRs (Task B.6 / P7).
 *
 * Webhook deliveries occasionally drop. GitHub retries on transient
 * failure but only for ~24h, and a long platform outage during that
 * window can leave us with PRs that ARE merged on GitHub but still
 * showing `merged_at IS NULL` in our DB (and parent suggestion stuck
 * at `pr_drafted` instead of `pr_merged`).
 *
 * This script reconciles by:
 *   1. Selecting `prompt_suggestion_pr` rows where `merged_at IS NULL`
 *      and `created_at` is older than a grace window (default 5 min — a
 *      PR opened seconds ago shouldn't be reconciled, the consultant
 *      hasn't even reviewed it yet).
 *   2. For each row, fetching the PR state from GitHub via the App
 *      auth helpers.
 *   3. If GitHub reports the PR as merged but our DB row still has
 *      `merged_at IS NULL`, applying the same merge-flip the webhook
 *      handler does: child UPDATE + parent flip to `pr_merged` in a
 *      single transaction.
 *
 * Idempotent: a second run does nothing if all rows are already
 * reconciled. Each row's update uses a `WHERE merged_at IS NULL`
 * predicate so a webhook delivery that lands between the GET and the
 * UPDATE doesn't double-apply.
 *
 * Run via:
 *   pnpm --filter @cpa/tools-scripts exec tsx --env-file=../../.env \
 *     reconcile-prompt-suggestion-prs.ts
 *
 * Or programmatically — `reconcilePromptSuggestionPrs()` returns a
 * structured summary. The CLI wrapper below is the production entry
 * point; intended for cron deployment but NOT scheduled yet (that's a
 * deployment concern).
 *
 * Exit codes (CLI mode):
 *   0 — success (whether any rows were reconciled or not)
 *   1 — env-var validation failure
 *   2 — unexpected error (DB connection, GitHub down, etc.)
 */

import { pathToFileURL } from 'node:url';
import { sql, privilegedSql } from '@cpa/db/client';
import { getGitHubAppHeaders } from '@cpa/integrations/github-app';

/**
 * Grace window (ms) — rows younger than this are skipped. Five minutes
 * lets a freshly-opened PR settle and lets a slow webhook delivery land
 * before we look at it. Tunable per-run (CLI flag and programmatic
 * arg).
 */
const DEFAULT_GRACE_WINDOW_MS = 5 * 60 * 1000;

interface ReconcilerEnv {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_OWNER: string;
  GITHUB_APP_REPO: string;
}

/** Subset of GitHub's `pulls/:number` response we read. */
interface GithubPullPayload {
  number: number;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  state: 'open' | 'closed';
}

interface UnreconciledPrRow {
  id: string;
  tenant_id: string;
  suggestion_id: string;
  github_pr_number: number;
  created_at: Date;
}

export interface ReconcileSummary {
  candidates: number;
  reconciled: number;
  skipped_unmerged_on_github: number;
  errors: Array<{ pr_id: string; github_pr_number: number; message: string }>;
}

export interface ReconcileOptions {
  /** Env bundle. Reads `process.env` if not provided. */
  env?: ReconcilerEnv;
  /** Grace window in ms; rows newer than this are skipped. */
  graceWindowMs?: number;
  /** DI seam for tests — replaces `globalThis.fetch` for the GitHub
   *  read calls. */
  fetch?: typeof globalThis.fetch;
  /** DI seam for tests — replaces `getGitHubAppHeaders`. Tests pass a
   *  stub that returns canned headers without minting a real token. */
  getHeaders?: typeof getGitHubAppHeaders;
  /** Logger seam. Defaults to console-on-CLI; tests pass a no-op. */
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const noopLogger: Required<ReconcileOptions>['logger'] = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function readEnv(env: NodeJS.ProcessEnv): ReconcilerEnv | { missing: string[] } {
  const required = [
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_INSTALLATION_ID',
    'GITHUB_APP_OWNER',
    'GITHUB_APP_REPO',
  ] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length) return { missing };
  return {
    GITHUB_APP_ID: env['GITHUB_APP_ID'] as string,
    GITHUB_APP_PRIVATE_KEY: env['GITHUB_APP_PRIVATE_KEY'] as string,
    GITHUB_APP_INSTALLATION_ID: env['GITHUB_APP_INSTALLATION_ID'] as string,
    GITHUB_APP_OWNER: env['GITHUB_APP_OWNER'] as string,
    GITHUB_APP_REPO: env['GITHUB_APP_REPO'] as string,
  };
}

/**
 * Apply the merge-flip to one row. Mirrors the webhook handler's
 * logic but is duplicated here intentionally — the script lives in
 * tools/ and shouldn't reach into apps/api internals; if the two
 * paths diverge we want to notice in PR review, not have one silently
 * follow the other's refactor.
 *
 * Returns true if the row was flipped, false if it was already merged
 * (someone else won the race — webhook landed between our GET and
 * UPDATE) so the caller can keep accurate counts.
 */
async function applyMergeFlip(opts: {
  pr: UnreconciledPrRow;
  github: GithubPullPayload;
}): Promise<boolean> {
  const { pr, github } = opts;
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${pr.tenant_id}, true)`;

    const updated = await tx<{ id: string }[]>`
      UPDATE prompt_suggestion_pr
         SET merged_at = COALESCE(${github.merged_at}::timestamptz, NOW()),
             merge_commit_sha = ${github.merge_commit_sha}
       WHERE id = ${pr.id}
         AND tenant_id = ${pr.tenant_id}
         AND merged_at IS NULL
      RETURNING id
    `;
    if (updated.length === 0) {
      // Webhook landed between our GET and UPDATE — already merged.
      return false;
    }

    await tx`
      UPDATE prompt_suggestion
         SET status = 'pr_merged',
             resolved_at = NOW()
       WHERE id = ${pr.suggestion_id}
         AND tenant_id = ${pr.tenant_id}
         AND status IN ('pr_drafted', 'triaged')
    `;
    return true;
  });
}

export async function reconcilePromptSuggestionPrs(
  opts: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  let resolvedEnv: ReconcilerEnv;
  if (opts.env) {
    // The caller passed a (possibly partial) env bag. Validate it
    // through the same readEnv path so we get a consistent error
    // message and the same key-set check tests + CLI both rely on.
    const candidate = readEnv(opts.env as unknown as NodeJS.ProcessEnv);
    if ('missing' in candidate) {
      throw new Error(`reconciler: missing required env vars: ${candidate.missing.join(', ')}`);
    }
    resolvedEnv = candidate;
  } else {
    const fromProcess = readEnv(process.env);
    if ('missing' in fromProcess) {
      throw new Error(`reconciler: missing required env vars: ${fromProcess.missing.join(', ')}`);
    }
    resolvedEnv = fromProcess;
  }
  const graceWindowMs = opts.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const getHeaders = opts.getHeaders ?? getGitHubAppHeaders;
  const logger = opts.logger ?? noopLogger;

  // 1. Pick up unreconciled rows older than the grace window. We use
  //    privilegedSql for the read because the reconciler doesn't have a
  //    tenant context to set yet — it walks across tenants. Each row's
  //    update later sets the GUC inside its own transaction.
  const cutoffMs = Date.now() - graceWindowMs;
  const rows = await privilegedSql<UnreconciledPrRow[]>`
    SELECT id, tenant_id, suggestion_id, github_pr_number, created_at
      FROM prompt_suggestion_pr
     WHERE merged_at IS NULL
       AND created_at < to_timestamp(${cutoffMs / 1000})
     ORDER BY created_at ASC
  `;

  const summary: ReconcileSummary = {
    candidates: rows.length,
    reconciled: 0,
    skipped_unmerged_on_github: 0,
    errors: [],
  };

  if (rows.length === 0) {
    logger.info('reconciler: no candidates', { graceWindowMs });
    return summary;
  }

  // Mint a single set of headers for the whole batch — the installation
  // token cache (in installation-token.ts) handles refresh, so this is
  // cheap on subsequent calls.
  const headers = await getHeaders({
    appId: resolvedEnv.GITHUB_APP_ID,
    privateKey: resolvedEnv.GITHUB_APP_PRIVATE_KEY,
    installationId: resolvedEnv.GITHUB_APP_INSTALLATION_ID,
    fetch: fetchImpl,
  });

  for (const pr of rows) {
    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(resolvedEnv.GITHUB_APP_OWNER)}/${encodeURIComponent(resolvedEnv.GITHUB_APP_REPO)}/pulls/${pr.github_pr_number}`;
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          ...headers,
          'User-Agent': 'cpa-platform-prompt-suggestion-reconciler',
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        summary.errors.push({
          pr_id: pr.id,
          github_pr_number: pr.github_pr_number,
          message: `GitHub returned ${res.status}: ${text.slice(0, 500)}`,
        });
        continue;
      }
      const github = (await res.json()) as GithubPullPayload;
      if (!github.merged) {
        summary.skipped_unmerged_on_github += 1;
        continue;
      }
      const flipped = await applyMergeFlip({ pr, github });
      if (flipped) {
        summary.reconciled += 1;
        logger.info('reconciler: flipped to pr_merged', {
          pr_id: pr.id,
          github_pr_number: pr.github_pr_number,
        });
      } else {
        // Already merged in our DB by a webhook delivery that beat us
        // here. Count it as a no-op (not an error, not "reconciled by
        // us").
        logger.info('reconciler: row already merged by concurrent writer', {
          pr_id: pr.id,
          github_pr_number: pr.github_pr_number,
        });
      }
    } catch (err) {
      summary.errors.push({
        pr_id: pr.id,
        github_pr_number: pr.github_pr_number,
        message: (err as Error).message,
      });
      logger.error('reconciler: row failed', { pr_id: pr.id, err: (err as Error).message });
    }
  }

  return summary;
}

// CLI entry point.

const HELP_TEXT = `Usage (from tools/scripts/):
  pnpm exec tsx --env-file=../../.env reconcile-prompt-suggestion-prs.ts

Required env vars:
  GITHUB_APP_ID
  GITHUB_APP_PRIVATE_KEY
  GITHUB_APP_INSTALLATION_ID
  GITHUB_APP_OWNER
  GITHUB_APP_REPO

Walks prompt_suggestion_pr rows where merged_at IS NULL and
created_at < now() - 5 minutes; for each, queries GitHub for the PR
state and applies the merge-flip if GitHub reports it as merged.
Idempotent — a second run is a no-op.
`;

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const env = readEnv(process.env);
  if ('missing' in env) {
    process.stderr.write(`Missing required env vars: ${env.missing.join(', ')}\n`);
    process.stderr.write(HELP_TEXT);
    process.exit(1);
  }

  const cliLogger: Required<ReconcileOptions>['logger'] = {
    info: (msg, meta) => {
      process.stdout.write(`[info]  ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
    },
    warn: (msg, meta) => {
      process.stdout.write(`[warn]  ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
    },
    error: (msg, meta) => {
      process.stderr.write(`[error] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
    },
  };

  try {
    const summary = await reconcilePromptSuggestionPrs({ env, logger: cliLogger });
    process.stdout.write(
      [
        'Reconciler summary:',
        `  candidates:                  ${summary.candidates}`,
        `  reconciled:                  ${summary.reconciled}`,
        `  skipped (unmerged on GH):    ${summary.skipped_unmerged_on_github}`,
        `  errors:                      ${summary.errors.length}`,
        '',
      ].join('\n'),
    );
    if (summary.errors.length > 0) {
      for (const e of summary.errors) {
        process.stderr.write(`error pr_id=${e.pr_id} pr#=${e.github_pr_number}: ${e.message}\n`);
      }
    }
    await sql.end();
    await privilegedSql.end();
  } catch (err) {
    process.stderr.write(`Unexpected error: ${(err as Error).message}\n`);
    try {
      await sql.end();
      await privilegedSql.end();
    } catch {
      // ignore — we're already failing.
    }
    process.exit(2);
  }
}

// Direct-invoke gate. Tests import this module — they MUST NOT trigger main().
const argv1 = process.argv[1];
const isDirectInvoke = typeof argv1 === 'string' && import.meta.url === pathToFileURL(argv1).href;
if (isDirectInvoke) {
  main().catch((err: unknown) => {
    process.stderr.write('Unexpected error: ' + String(err) + '\n');
    process.exit(2);
  });
}
