-- DO NOT REGENERATE THIS MIGRATION VIA `pnpm --filter @cpa/db generate`.
-- The CHECK constraint at the bottom is hand-authored — drizzle-kit doesn't
-- emit cross-column CHECK constraints from schema definitions.
--
-- Rationale: P3 mobile flow has subject_tenant_employee rows capturing
-- events. The original schema constrained captured_by_user_id NOT NULL
-- with FK to user.id, forcing mobile inserts to either lie about the
-- capturer (use a firm admin) or violate the FK. This migration makes
-- the column nullable and adds a parallel captured_by_employee_id
-- column FK'd to subject_tenant_employee, with a CHECK constraint
-- requiring exactly one of the two to be set.
--
-- Backward-compat for the hash chain (chain.ts):
--   - Existing events have captured_by_user_id non-null and
--     captured_by_employee_id null.
--   - canonicaliseEvent conditionally INCLUDES captured_by_employee_id
--     only when non-null, and keeps captured_by_user_id always present
--     (with `?? null` for the new mobile case). That way:
--       * old events: canonical contains captured_by_user_id with the
--         original value, no captured_by_employee_id field — identical
--         bytes to pre-migration → identical SHA-256 → verifyChain
--         passes for all pre-existing rows.
--       * new mobile events: canonical contains captured_by_user_id:null
--         AND captured_by_employee_id:<uuid> — a new shape, no hash
--         collision concerns.

ALTER TABLE "event" ALTER COLUMN "captured_by_user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "captured_by_employee_id" uuid;
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_captured_by_employee_id_subject_tenant_employee_id_fk"
  FOREIGN KEY ("captured_by_employee_id") REFERENCES "public"."subject_tenant_employee"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- Hand-authored CHECK: exactly one of (user_id, employee_id) must be set.
-- XOR via NOT NULL counts: cardinality of {user_id, employee_id} non-nulls = 1.
-- (NULL IS NOT NULL is FALSE, NULLIF on the booleans avoids the 3VL trap.)
ALTER TABLE "event" ADD CONSTRAINT "event_capturer_exactly_one"
  CHECK (
    (captured_by_user_id IS NOT NULL)::int
    + (captured_by_employee_id IS NOT NULL)::int
    = 1
  );
