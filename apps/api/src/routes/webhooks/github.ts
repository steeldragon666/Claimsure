import type { FastifyInstance } from 'fastify';
import { sql, privilegedSql } from '@cpa/db/client';
import { verifyHmacSha256 } from '@cpa/integrations/runtime';

/**
 * GitHub webhook receiver (Task B.6 / P7).
 *
 * Surface:
 *   POST /v1/webhooks/github
 *     GitHub App webhook callback. HMAC-verifies against
 *     `GITHUB_WEBHOOK_SECRET`, resolves the matching `prompt_suggestion_pr`
 *     row by `github_pr_number`, and on `pull_request.merged|closed` flips
 *     the parent suggestion to `pr_merged` or `dismissed`.
 *
 * Security:
 *   - GitHub signs the raw request body with HMAC-SHA256 and sends the
 *     digest in the `X-Hub-Signature-256` header (`sha256=<hex>`).
 *   - We MUST hold the original Buffer to verify the signature, so this
 *     route is registered behind a Fastify content-type parser scoped to
 *     just this plugin (mirrors the DocuSign webhook precedent in
 *     `signing.ts`).
 *   - Comparison is constant-time via `verifyHmacSha256`.
 *   - Mismatch → 401 BEFORE any further processing or DB writes.
 *
 * Tenant context:
 *   - Webhooks are unauthenticated (no session, no cookie). We resolve
 *     the target tenant by looking up `prompt_suggestion_pr` via
 *     `privilegedSql` (RLS-bypass) on `github_pr_number`, then set
 *     `app.current_tenant_id` GUC inside an RLS-scoped `sql.begin` for
 *     the actual writes.
 *   - The HMAC verification IS the trust boundary; once verified, we
 *     trust the payload's `pull_request.number` to pick the row to
 *     update (and only that row's tenant).
 *
 * Idempotency:
 *   - GitHub redelivers webhooks on transient failures. The handler
 *     short-circuits on already-processed events:
 *       * `pull_request.merged` when `merged_at IS NOT NULL` → 200 with
 *         `action: 'already-merged'`. No double-update of parent status
 *         or merge bookkeeping.
 *       * `pull_request.closed` (not merged) when parent suggestion
 *         status is already `dismissed` → 200 with `action: 'already-dismissed'`.
 *       * Row vanished between unlocked lookup and locked re-check (a
 *         genuinely anomalous case since `cpa_app` has REVOKE DELETE on
 *         `prompt_suggestion_pr`) → 200 with `action: 'row-vanished'`.
 *         Distinct action label so operators can spot the anomaly in
 *         logs vs the normal redelivery already-merged case.
 *   - The lookup-then-update is in a single `sql.begin` so the
 *     parent-status flip + child PR update share one transaction.
 *
 * Events handled:
 *   - `pull_request.closed` with `pull_request.merged === true`
 *       → set `prompt_suggestion_pr.merged_at` + `merge_commit_sha`,
 *         flip parent to `pr_merged` + `resolved_at = now()`.
 *   - `pull_request.closed` with `pull_request.merged === false`
 *       → flip parent to `dismissed` + `resolved_at = now()`. No row on
 *         the child gets updated (no `merged_at` to set; the close was
 *         a refusal not a merge).
 *   - All other event types (push, issues, ping, etc.) → 200 with
 *     `action: 'no-op'`. We accept and don't process; GitHub stops
 *     redelivering.
 *   - `pull_request.number` not in our DB → 200 with `action: 'unknown-pr'`.
 *     Could be a PR on another repo whose webhook URL points here, or
 *     a stale environment. We don't 404 because that would tell GitHub
 *     to retry — and the retry would never succeed.
 */

interface PromptSuggestionPrLookupRow {
  id: string;
  tenant_id: string;
  suggestion_id: string;
  merged_at: Date | string | null;
}

/**
 * Narrow type guard for the GitHub `pull_request` payload subset we
 * consume. We don't validate aggressively — GitHub controls the shape
 * and the HMAC is the trust boundary — but we DO check the few fields
 * we read so a malformed body produces a clean 400 instead of a runtime
 * `undefined.merged` crash.
 */
interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    merged: boolean;
    merge_commit_sha: string | null;
    merged_at: string | null;
  };
}

function isPullRequestPayload(parsed: unknown): parsed is PullRequestPayload {
  if (!parsed || typeof parsed !== 'object') return false;
  const p = parsed as { action?: unknown; pull_request?: unknown };
  if (typeof p.action !== 'string') return false;
  if (!p.pull_request || typeof p.pull_request !== 'object') return false;
  const pr = p.pull_request as { number?: unknown; merged?: unknown };
  if (typeof pr.number !== 'number') return false;
  if (typeof pr.merged !== 'boolean') return false;
  return true;
}

/**
 * Extract the hex digest from a `X-Hub-Signature-256` header. GitHub
 * formats this as `sha256=<hex>`; we strip the prefix and hand the
 * remainder to `verifyHmacSha256`. Returns null on malformed input
 * (missing prefix, etc.) so the caller can 401 on a malformed header
 * the same way it would on a wrong signature — both are "invalid
 * signature" from the receiver's perspective.
 */
function parseSignatureHeader(header: string | undefined): string | null {
  if (!header) return null;
  if (!header.startsWith('sha256=')) return null;
  const hex = header.slice('sha256='.length);
  if (!hex) return null;
  return hex;
}

/**
 * Apply the merge-flip to both the child PR row and the parent
 * suggestion. Idempotent: if `merged_at IS NOT NULL` already, returns
 * `'already-merged'` without touching anything. The check is done via
 * a row lock pattern (SELECT … FOR UPDATE) inside the same transaction
 * as the writes, so two concurrent webhook deliveries can't double-flip.
 *
 * Returns the action label that should appear in the response body.
 */
async function applyMergeFlip(opts: {
  prRow: PromptSuggestionPrLookupRow;
  payload: PullRequestPayload;
}): Promise<'merged' | 'already-merged' | 'row-vanished'> {
  const { prRow, payload } = opts;
  const tenantId = prRow.tenant_id;
  const mergeCommitSha = payload.pull_request.merge_commit_sha;
  const mergedAtIso = payload.pull_request.merged_at;

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

    // Re-check inside the tx with FOR UPDATE so two concurrent webhook
    // deliveries serialize on this row. The outer `privilegedSql` lookup
    // is unlocked (it was just for tenant resolution); the locking read
    // happens here under RLS.
    const locked = await tx<Pick<PromptSuggestionPrLookupRow, 'id' | 'merged_at'>[]>`
      SELECT id, merged_at
        FROM prompt_suggestion_pr
       WHERE id = ${prRow.id} AND tenant_id = ${tenantId}
       FOR UPDATE
    `;
    const lockedRow = locked[0];
    if (!lockedRow) {
      // Vanishingly rare — the row was deleted between our privileged
      // lookup and the locking SELECT. cpa_app has REVOKE DELETE on this
      // table (migration 0038) so this should be unreachable in practice;
      // any occurrence is genuinely anomalous (privileged DELETE, manual
      // ops intervention, etc.) and operators should be able to spot it
      // distinctly from the normal redelivery 'already-merged' case.
      return 'row-vanished' as const;
    }
    if (lockedRow.merged_at !== null) {
      return 'already-merged' as const;
    }

    await tx`
      UPDATE prompt_suggestion_pr
         SET merged_at = COALESCE(${mergedAtIso}::timestamptz, NOW()),
             merge_commit_sha = ${mergeCommitSha}
       WHERE id = ${prRow.id} AND tenant_id = ${tenantId}
    `;

    // Parent flip — only if not already terminal. The state-machine
    // guard at the API layer (Task B.3) prevents `pr_drafted` from
    // being moved to `dismissed`, but here we trust the webhook to
    // overwrite `pr_drafted` → `pr_merged` (the natural progression).
    // We do NOT overwrite an existing `dismissed` (the consultant
    // closed-without-merge previously, then someone manually merged
    // anyway — that's an edge case the operator handles by hand).
    await tx`
      UPDATE prompt_suggestion
         SET status = 'pr_merged',
             resolved_at = NOW()
       WHERE id = ${prRow.suggestion_id}
         AND tenant_id = ${tenantId}
         AND status IN ('pr_drafted', 'triaged')
    `;
    return 'merged' as const;
  });
}

/**
 * Apply the "closed but not merged" flip — the consultant declined the
 * suggestion via PR-close. We don't touch `prompt_suggestion_pr`
 * (`merged_at` stays NULL — there was no merge); we only flip the
 * parent suggestion's status. Idempotent on parent status: if already
 * `dismissed` we no-op.
 */
async function applyDismissFlip(opts: {
  prRow: PromptSuggestionPrLookupRow;
}): Promise<'dismissed' | 'already-dismissed'> {
  const { prRow } = opts;
  const tenantId = prRow.tenant_id;

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

    const flipped = await tx<{ id: string }[]>`
      UPDATE prompt_suggestion
         SET status = 'dismissed',
             resolved_at = NOW()
       WHERE id = ${prRow.suggestion_id}
         AND tenant_id = ${tenantId}
         AND status IN ('pr_drafted', 'triaged')
      RETURNING id
    `;
    return flipped.length > 0 ? ('dismissed' as const) : ('already-dismissed' as const);
  });
}

/**
 * Webhook plugin (T-B6).
 *
 * Registered as a Fastify-encapsulated plugin so the
 * `application/json` content-type parser override (parseAs:'buffer')
 * is scoped to just this route. Other routes still get normal JSON
 * parsing. Mirrors the DocuSign precedent in `signing.ts`.
 */
export function registerGithubWebhookPlugin(app: FastifyInstance): void {
  app.register((instance, _opts, done) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, doneCb) => {
        // Body arrives as Buffer (parseAs:'buffer'). Pass through
        // unchanged so the route handler can verify the HMAC against the
        // exact bytes GitHub signed.
        doneCb(null, body);
      },
    );

    instance.post('/v1/webhooks/github', async (req, reply) => {
      const secret = process.env['GITHUB_WEBHOOK_SECRET'];
      if (!secret) {
        req.log.error('GITHUB_WEBHOOK_SECRET not set — refusing webhook');
        return reply.status(500).send({
          error: 'github_webhook_misconfigured',
          message: 'Server is missing GITHUB_WEBHOOK_SECRET',
          requestId: req.id,
        });
      }

      // Headers come in lowercased via Fastify. GitHub also sends
      // X-GitHub-Event indicating the event type (e.g. 'pull_request',
      // 'push', 'ping'); we read it after signature verification so
      // an unsigned probe can't enumerate which event types we accept.
      const sigHeaderRaw = req.headers['x-hub-signature-256'];
      const sigHeader = Array.isArray(sigHeaderRaw) ? sigHeaderRaw[0] : sigHeaderRaw;
      const hexSig = parseSignatureHeader(sigHeader);
      if (!hexSig) {
        return reply.status(401).send({
          error: 'missing_signature',
          message: 'X-Hub-Signature-256 header required (sha256=<hex>)',
          requestId: req.id,
        });
      }

      const rawBody = req.body;
      if (!Buffer.isBuffer(rawBody)) {
        // Defensive: with parseAs:'buffer' wired we should always get a
        // Buffer, but defend against an empty/null body shape so we
        // never call verify on a non-Buffer.
        return reply.status(400).send({
          error: 'invalid_body',
          message: 'Webhook body missing',
          requestId: req.id,
        });
      }

      // 1. HMAC-SHA256 timing-safe verification.
      const ok = verifyHmacSha256({
        payload: rawBody,
        signature_header: hexSig,
        secret,
      });
      if (!ok) {
        return reply.status(401).send({
          error: 'invalid_signature',
          message: 'Webhook signature mismatch',
          requestId: req.id,
        });
      }

      // 2. Read event type. Anything other than `pull_request` we
      //    accept-and-ignore (GitHub will mark the delivery as 200
      //    and stop retrying). The signature is already verified above.
      const eventHeaderRaw = req.headers['x-github-event'];
      const eventType = Array.isArray(eventHeaderRaw) ? eventHeaderRaw[0] : eventHeaderRaw;
      if (eventType !== 'pull_request') {
        return reply.status(200).send({ received: true, action: 'no-op' });
      }

      // 3. Parse JSON. Malformed body after a valid HMAC is anomalous
      //    (we just signed-checked the same bytes); 400 so the operator
      //    sees something is up, but the signature mismatch path is
      //    where bad-faith requests go.
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return reply.status(400).send({
          error: 'invalid_json',
          message: 'Webhook body is not valid JSON',
          requestId: req.id,
        });
      }
      if (!isPullRequestPayload(parsed)) {
        return reply.status(400).send({
          error: 'invalid_payload',
          message: 'pull_request event missing required fields',
          requestId: req.id,
        });
      }

      // We only act on `closed`. GitHub also emits opened, reopened,
      // synchronize, edited, etc. — all 200 no-op.
      if (parsed.action !== 'closed') {
        return reply.status(200).send({ received: true, action: 'no-op' });
      }

      // 4. Tenant resolution: look up the prompt_suggestion_pr row by
      //    PR number via privilegedSql (no tenant context yet). The
      //    row's tenant_id seeds the GUC for the subsequent transaction.
      const prNumber = parsed.pull_request.number;
      const lookup = await privilegedSql<PromptSuggestionPrLookupRow[]>`
        SELECT id, tenant_id, suggestion_id, merged_at
          FROM prompt_suggestion_pr
         WHERE github_pr_number = ${prNumber}
         ORDER BY created_at DESC
         LIMIT 1
      `;
      const prRow = lookup[0];
      if (!prRow) {
        // Some other repo's PR or a stale environment. 200 + log so
        // GitHub stops retrying.
        req.log.warn(
          { github_pr_number: prNumber, action: parsed.action, merged: parsed.pull_request.merged },
          'github webhook for unknown PR — ignoring',
        );
        return reply.status(200).send({ received: true, action: 'unknown-pr' });
      }

      // 5. Branch on merged vs. closed-without-merge.
      if (parsed.pull_request.merged) {
        // Cheap fast-path idempotency: if our cached lookup already
        // shows `merged_at` set, skip the tx entirely. The locking
        // re-check inside `applyMergeFlip` is the authoritative guard
        // against a race; this is just a low-cost short-circuit.
        if (prRow.merged_at !== null) {
          return reply.status(200).send({ received: true, action: 'already-merged' });
        }
        const action = await applyMergeFlip({ prRow, payload: parsed });
        return reply.status(200).send({ received: true, action });
      }

      const action = await applyDismissFlip({ prRow });
      return reply.status(200).send({ received: true, action });
    });

    done();
  });
}

// Internal helpers exported for unit tests (HMAC verification path is
// already covered by `verifyHmacSha256` in @cpa/integrations/runtime;
// these are the route-local parsers).
export const _internals = {
  parseSignatureHeader,
  isPullRequestPayload,
  applyMergeFlip,
  applyDismissFlip,
};
