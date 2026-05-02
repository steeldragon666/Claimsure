-- 0034_mapping_rule_scalar_string_backfill.sql
-- Idempotent backfill: re-encodes mapping_rule.conditions and mapping_rule.action
-- rows that were stored as jsonb scalar STRINGS (a latent bug under the
-- pre-fix drizzle-mutated single-cast pattern from PR #5 era).
--
-- WHY: any mapping_rule rows created by apps/api/src/routes/mapping-rules.ts
-- between PR #5 (B9) and the e83ab08 fix on PR #9 (P5b) stored their
-- conditions and action as jsonb scalar STRINGS rather than jsonb
-- OBJECTS/ARRAYS. The runtime tolerates both shapes (because postgres-js
-- parses scalar strings back into JS strings, and B8's evaluate.ts
-- silently no-ops on string conditions), but B10's apply-rules path
-- and P6's downstream classifier consumers will trip on them. Re-encode
-- here so all rows are uniformly jsonb objects/arrays.
--
-- IDEMPOTENT: rows already in the correct shape (jsonb_typeof IN
-- ('object','array')) are skipped via the WHERE filter.
--
-- NOTE: Migration idx may shift on rebase. The original P6 plan reserved
-- 0032 for this backfill, but parallel branches p6b (Agent A system user)
-- and p6c (Agent B system user) consumed 0032 and 0033. Whichever ordering
-- the swimlane PRs merge in, this migration's idx adjusts accordingly. The
-- behavior is idempotent and order-independent regardless.

UPDATE mapping_rule
   SET conditions = (conditions #>> '{}')::jsonb
 WHERE jsonb_typeof(conditions) = 'string';

UPDATE mapping_rule
   SET action = (action #>> '{}')::jsonb
 WHERE jsonb_typeof(action) = 'string';
