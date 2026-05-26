# 01 — IP Search Migration

**Depends on:** none

## Goal

Three new tables: `ip_search_run`, `ip_search_hit`, `ip_search_verdict`. All RLS-scoped. Cache index on `(hypothesis_hash, database_name, query)`.

## Files to add

- `packages/db/migrations/00XX_ip_search.sql` (next sequential number)
- `packages/db/migrations/meta/_journal.json` — append entry
- `packages/db/src/schema/ip-search.ts` — Drizzle schemas
- Schema index export

## SQL to write

```sql
CREATE TABLE IF NOT EXISTS ip_search_run (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  claim_id        uuid        NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  activity_id     uuid        NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  hypothesis_text text        NOT NULL,
  hypothesis_hash text        NOT NULL,    -- sha256(hypothesis_text) hex
  database_name   text        NOT NULL     CHECK (database_name IN ('ip_australia', 'semantic_scholar', 'pubmed', 'arxiv')),
  query           text        NOT NULL,
  query_source    text        NOT NULL     CHECK (query_source IN ('llm', 'analyst_edit')),
  raw_response    jsonb,
  result_count    int         NOT NULL DEFAULT 0,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  ran_by_user_id  uuid        REFERENCES "user"(id)
);

CREATE INDEX IF NOT EXISTS ip_search_run_cache_idx
  ON ip_search_run (hypothesis_hash, database_name, query, ran_at DESC);

CREATE TABLE IF NOT EXISTS ip_search_hit (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  search_run_id   uuid        NOT NULL REFERENCES ip_search_run(id) ON DELETE CASCADE,
  external_id     text        NOT NULL,
  title           text        NOT NULL,
  abstract        text,
  published_at    date,
  relevance_score numeric,
  url             text
);

CREATE INDEX IF NOT EXISTS ip_search_hit_run_idx ON ip_search_hit (search_run_id);

CREATE TABLE IF NOT EXISTS ip_search_verdict (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  claim_id            uuid        NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  activity_id         uuid        NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  hypothesis_text     text        NOT NULL,
  verdict             text        NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
  draft_verdict       text                  CHECK (draft_verdict IN ('pass', 'fail', 'inconclusive')),
  analysis_markdown   text        NOT NULL,
  approved_by_user_id uuid        REFERENCES "user"(id),
  approved_at         timestamptz,
  pdf_evidence_id     uuid        REFERENCES evidence(id),
  CONSTRAINT one_verdict_per_hypothesis UNIQUE (activity_id, hypothesis_text)
);

-- RLS
ALTER TABLE ip_search_run     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_search_hit     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_search_verdict ENABLE ROW LEVEL SECURITY;

CREATE POLICY ip_search_run_tenant_isolation ON ip_search_run
  FOR ALL TO cpa_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ip_search_hit inherits tenant scope via search_run_id JOIN; explicit policy:
CREATE POLICY ip_search_hit_tenant_isolation ON ip_search_hit
  FOR ALL TO cpa_app
  USING (EXISTS (
    SELECT 1 FROM ip_search_run r
    WHERE r.id = ip_search_hit.search_run_id
      AND r.tenant_id = current_setting('app.current_tenant_id', true)::uuid
  ));

CREATE POLICY ip_search_verdict_tenant_isolation ON ip_search_verdict
  FOR ALL TO cpa_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ip_search_run, ip_search_hit, ip_search_verdict TO cpa_app;
```

## Acceptance

- [ ] Migration runs cleanly. Idempotent.
- [ ] Drizzle schemas mirror SQL.
- [ ] RLS verified by positive-control tests (mirror `audit-log.test.ts` pattern).
- [ ] Cache index `ip_search_run_cache_idx` exists (verify with `\d ip_search_run`).

## Deliverable

PR titled `feat(db): ip_search_run + ip_search_hit + ip_search_verdict schema`.
