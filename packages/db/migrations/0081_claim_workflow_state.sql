-- Migration 0081: workflow_state jsonb on claim for wizard state.
--
-- Nullable: NULL = legacy claim (renders existing tabbed UI). Non-null = new
-- wizard claim. Shape validated at application layer by Zod (no jsonb_check).
--
-- Entry shape:
--   {
--     "initialized_at": "ISO-8601",
--     "steps": {
--       "1": null | { "agreed_at": "ISO", "agreed_by": "<user_uuid>" },
--       "2": null | { ... },
--       "3": null | { ... },
--       "4": null | { ... },
--       "5": null | { ... }
--     }
--   }
ALTER TABLE claim
  ADD COLUMN workflow_state jsonb;
