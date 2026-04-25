-- Runs ONLY on first boot, when the cpa-pgdata volume is empty.
-- To re-run after edits: pnpm db:down -v && pnpm db:up
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector: vector(N) type for embeddings
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid() for default PK values
