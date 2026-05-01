-- packages/db/migrations/0031_chain_jsonb_doublecast.sql
-- Hand-authored placeholder migration. The actual fix lives in
-- packages/db/src/chain.ts (single-cast -> double-cast on jsonb binds).
-- This file exists only to reserve idx 31 in the journal so subsequent
-- P6 migrations have a stable numbering anchor.
SELECT 1;  -- intentional no-op
