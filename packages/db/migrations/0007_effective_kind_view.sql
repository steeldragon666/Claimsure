-- Adds the event_with_effective_kind view used by GET /v1/events and
-- POST /v1/events/:id/override (P2 T18-T20). The view layers two derived
-- columns over the raw event table:
--
--   effective_kind: the most-recent OVERRIDE.override_new_kind for this
--     event, falling back to the event's own kind. Ordered by
--     (captured_at DESC, received_at DESC, id DESC) so the latest override
--     wins if multiple exist (per design doc — see also the DB CHECK in
--     migration 0006 that prevents OVERRIDE-of-OVERRIDE).
--
--   is_overridden: boolean — true iff at least one OVERRIDE event exists
--     in the same tenant pointing at this row's id. Same-tenant filter
--     means cross-tenant overrides (impossible under RLS, but defensive)
--     don't accidentally flip this flag.
--
-- The tenant_id filter on each correlated subquery is redundant under RLS
-- (the policy on `event` would filter automatically) but makes the view
-- safe to use in privileged contexts (admin tooling, migrations) where
-- RLS is bypassed.
--
-- GRANT SELECT to cpa_app so the API role can read; cpa_app reads the
-- underlying event table via its own RLS policy.

CREATE OR REPLACE VIEW event_with_effective_kind AS
SELECT e.*,
  COALESCE(
    (SELECT o.override_new_kind FROM event o
      WHERE o.kind = 'OVERRIDE'
        AND o.override_of_event_id = e.id
        AND o.tenant_id = e.tenant_id
      ORDER BY o.captured_at DESC, o.received_at DESC, o.id DESC
      LIMIT 1),
    e.kind
  ) AS effective_kind,
  EXISTS (
    SELECT 1 FROM event o
    WHERE o.kind = 'OVERRIDE'
      AND o.override_of_event_id = e.id
      AND o.tenant_id = e.tenant_id
  ) AS is_overridden
FROM event e;

GRANT SELECT ON event_with_effective_kind TO cpa_app;
