# 01 — Engagement Letter Migration

**Depends on:** none

## Goal

Add the `engagement_letter` table + the `engagement_status` enum column on `claim` + the `tenant.engagement_letter_template_md` column. RLS policies. Idempotent.

## Files to add

- `packages/db/migrations/00XX_engagement_letter.sql` (use next sequential number — `ls packages/db/migrations/` to find it)
- `packages/db/migrations/meta/_journal.json` — append the new migration entry
- `packages/db/src/schema/engagement-letter.ts` — Drizzle schema definition mirroring the SQL
- Index file update (`packages/db/src/schema/index.ts` or equivalent) to export the new schema

## SQL to write

```sql
-- Per-firm engagement letter template (markdown with {{variable}} placeholders).
ALTER TABLE tenant
  ADD COLUMN IF NOT EXISTS engagement_letter_template_md text;

-- Per-claim engagement letter instance (rendered + signed).
CREATE TABLE IF NOT EXISTS engagement_letter (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid        NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  claim_id                 uuid        NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  rendered_markdown        text        NOT NULL,
  template_version         text        NOT NULL,
  send_token               text        UNIQUE,         -- public token for web-fallback /engagement/[token]/sign
  send_token_expires_at    timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  sent_to_claimant_at      timestamptz,
  signed_by_claimant_at    timestamptz,
  signed_by_claimant_name  text,
  signed_by_claimant_ip    inet,
  signed_by_claimant_ua    text,
  countersigned_by_user_id uuid        REFERENCES "user"(id),
  countersigned_at         timestamptz,
  pdf_evidence_id          uuid        REFERENCES evidence(id),
  declined_at              timestamptz,
  declined_reason          text,
  expired_at               timestamptz,
  CONSTRAINT one_letter_per_claim UNIQUE (claim_id)
);

-- New column on claim driving wizard step-1 gate.
ALTER TABLE claim
  ADD COLUMN IF NOT EXISTS engagement_status text NOT NULL DEFAULT 'pending_send'
  CHECK (engagement_status IN ('pending_send', 'sent', 'signed', 'declined', 'expired'));

-- RLS
ALTER TABLE engagement_letter ENABLE ROW LEVEL SECURITY;

CREATE POLICY engagement_letter_tenant_isolation ON engagement_letter
  FOR ALL TO cpa_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON engagement_letter TO cpa_app;
```

## Acceptance

- [ ] Migration runs cleanly via `pnpm --filter @cpa/db migrate`.
- [ ] Drizzle schema mirrors the SQL exactly.
- [ ] RLS policy verified: a session with tenant A cannot read tenant B's `engagement_letter` rows (write a positive-control test mirroring `audit-log.test.ts`).
- [ ] Re-running the migration is idempotent (uses `IF NOT EXISTS`).
- [ ] No down migration needed — append-only schema is the convention here.

## Deliverable

Single PR titled `feat(db): engagement letter schema + claim.engagement_status + tenant template column`.
