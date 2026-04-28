import { privilegedSql } from './client.js';
import { type ActivityKind } from './schema/activity.js';

const PREFIX: Record<ActivityKind, 'CA' | 'SA'> = {
  core: 'CA',
  supporting: 'SA',
};

/**
 * Returns the next available activity code for a claim, given the kind.
 *
 * - Core activities use prefix `CA-`; supporting uses `SA-`.
 * - Gap-filling: if `CA-01` and `CA-03` exist, returns `CA-02`.
 * - Per-claim per-kind sequence — CA-XX and SA-XX are independent.
 * - Idempotent on retries: same input returns same output until a row
 *   is INSERT'd (race-prone — caller should hold a transaction or
 *   handle UNIQUE constraint violations to retry).
 *
 * Uses `privilegedSql` (cpa role, bypasses RLS) so the SELECT picks up
 * any same-claim activity codes regardless of tenant context. Callers
 * are expected to pass a `claim_id` they have authorized access to.
 *
 * Padding: `padStart(2, '0')` produces `CA-01` through `CA-99`. For
 * codes 100-999 (which the F2 CHECK regex `^(CA|SA)-[0-9]{2,3}$` allows),
 * the padding is a no-op since the number already has 3 digits, so the
 * helper correctly produces `CA-100` etc. when the sequence reaches that
 * range.
 *
 * Throws if the prefix space (1-999) is exhausted — extremely unlikely
 * for any realistic R&DTI claim.
 */
export async function nextActivityCode(args: {
  claim_id: string;
  kind: ActivityKind;
}): Promise<string> {
  const prefix = PREFIX[args.kind];
  const rows = await privilegedSql<{ code: string }[]>`
    SELECT code FROM activity
     WHERE claim_id = ${args.claim_id}
       AND code LIKE ${prefix + '-%'}
     ORDER BY code
  `;
  const used = new Set(rows.map((r) => parseInt(r.code.slice(prefix.length + 1), 10)));
  for (let n = 1; n <= 999; n++) {
    if (!used.has(n)) return `${prefix}-${String(n).padStart(2, '0')}`;
  }
  throw new Error(`activity code exhausted for claim ${args.claim_id} kind ${args.kind}`);
}
