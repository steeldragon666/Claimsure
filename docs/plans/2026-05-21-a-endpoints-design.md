# A-endpoints — expenditure mapping + apportionment

**Status:** design approved 2026-05-21
**Owner:** Aaron
**Estimated effort:** 1 full day

## 1. Problem

`apps/web/src/app/claims/[claim_id]/_lib/api.ts` has three `TODO(A?-…)` markers
representing the unshipped backend for expenditure mapping. The web side
already has the UI (mapping picker, apportionment dialog, validation
helpers, optimistic state, client-side projection in `expenditure-projection.ts`).
The chain has the event kinds (`EXPENDITURE_MAPPED`, `EXPENDITURE_APPORTIONED`).
Only the four routes that glue them together are missing.

This PR adds those routes plus a server-side projection helper that
derives `current_mapping` from the event chain. It also introduces a
new `EXPENDITURE_UNMAPPED` event kind for the "consultant cleared the
mapping" intent.

## 2. Goal

Ship four routes that activate the existing mapping/apportionment UI
end-to-end, with the event chain as single source of truth and an
on-read projection deriving `current_mapping` per expenditure row.

## 3. API surface

All routes RLS-scoped via `cpa_app` role + `app.current_tenant_id` GUC
(set by `requireSession` preHandler).

### `GET /v1/claims/:id/expenditures?filter=all|unmapped|mapped`

```
200 {
  expenditures: [{
    id, vendor_name, reference, expenditure_date, total_amount, currency,
    source, voided_at,
    current_mapping:
      | null
      | { kind: 'single', activity_id, activity_code, activity_title }
      | { kind: 'apportioned',
          allocations: [{ activity_id, activity_code, activity_title, percentage }] },
  }]
}
```

### `POST /v1/expenditures/:id/map`

```
body: { activity_id: Uuid }
→ 200 { event: Event }
```

Validates `activity_id` belongs to the same `claim_id` as the
expenditure. Emits `EXPENDITURE_MAPPED` per existing payload contract
(see `api.ts:107-117` for the TODO docstring).

### `POST /v1/expenditures/:id/apportion`

```
body: { allocations: [{ activity_id: Uuid, percentage: number }, …] }
→ 200 { event: Event }
```

Validates: sum ≈ 100 (±0.001), every pct > 0, length ∈ [1, 5], no
duplicate `activity_id`, every activity in the same claim as the
expenditure. Emits `EXPENDITURE_APPORTIONED`.

### `POST /v1/expenditures/:id/unmap`

```
body: { reason?: string }
→ 200 { event: Event }
```

Emits new `EXPENDITURE_UNMAPPED` event. 400 if expenditure has no
current mapping.

## 4. New event kind — `EXPENDITURE_UNMAPPED`

**Payload:** `{ expenditure_id, prior_activity_id?, unmapped_by_user_id, reason? }`

**Three coordinated changes:**

1. `packages/db/src/schema/event.ts` — add `'EXPENDITURE_UNMAPPED'` to
   `EVIDENCE_KINDS` after `EXPENDITURE_APPORTIONED`.
2. `packages/schemas/src/event.ts` — mirror in `evidenceKind` enum.
3. New migration `packages/db/migrations/00NN_expenditure_unmapped_kind.sql` —
   rebuilds `event_kind_valid` CHECK to admit the value. Template from
   `0025_expenditure_apportioned_kind.sql`. Journal entry in `_journal.json`.

The parity test in `chain.test.ts:171` enforces the three sources stay
in sync.

## 5. Projection (on-read)

The chain is the system of record; `current_mapping` is derived per
read. **No materialised column on `expenditure`.**

For each expenditure in scope, walk events in `captured_at DESC`,
take the latest event in `{EXPENDITURE_MAPPED, EXPENDITURE_APPORTIONED,
EXPENDITURE_UNMAPPED}`:

| Latest kind | `current_mapping` |
|---|---|
| `EXPENDITURE_MAPPED` | `{kind: 'single', activity_id, activity_code, activity_title}` |
| `EXPENDITURE_APPORTIONED` | `{kind: 'apportioned', allocations: [...]}` |
| `EXPENDITURE_UNMAPPED` | `null` |
| (no events) | `null` |

**SQL shape** (sketch — final query in `apps/api/src/lib/expenditure-projection.ts`):

```sql
WITH latest_mapping AS (
  SELECT DISTINCT ON ((ev.payload->>'expenditure_id'))
    (ev.payload->>'expenditure_id')::uuid AS expenditure_id,
    ev.kind,
    ev.payload
  FROM event ev
  WHERE ev.kind IN ('EXPENDITURE_MAPPED','EXPENDITURE_APPORTIONED','EXPENDITURE_UNMAPPED')
    AND ev.subject_tenant_id = $1
  ORDER BY (ev.payload->>'expenditure_id'), ev.captured_at DESC, ev.id DESC
)
SELECT exp.*, lm.kind AS mapping_kind, lm.payload AS mapping_payload
FROM expenditure exp
LEFT JOIN latest_mapping lm ON lm.expenditure_id = exp.id
WHERE exp.claim_id = $2;
```

### Scope cuts

- `EXPENDITURE_LINE_MAPPED` is **excluded** from this PR's projection.
  Line-level mapping needs its own UI + per-line projection logic.
  Tracked as a follow-up.

### Parallel implementations + parity test

`apps/web/src/app/claims/[claim_id]/_lib/expenditure-projection.ts`
(client) and `apps/api/src/lib/expenditure-projection.ts` (server, new)
will both exist. A parity test feeds the same synthetic chain to both
and asserts identical output — drift becomes a CI failure on whoever
broke it.

## 6. File map

```
apps/api/src/routes/expenditures.ts                NEW — all 4 routes
apps/api/src/routes/expenditures.test.ts           NEW — integration tests
apps/api/src/lib/expenditure-projection.ts         NEW — projection helper
apps/api/src/lib/expenditure-projection.test.ts    NEW — unit tests
apps/api/src/lib/expenditure-projection-parity.test.ts  NEW — parity vs client
apps/api/src/app.ts                                 EDIT — register

packages/db/src/schema/event.ts                     EDIT — add EXPENDITURE_UNMAPPED
packages/db/migrations/00NN_expenditure_unmapped_kind.sql  NEW — CHECK rebuild
packages/db/migrations/meta/_journal.json           EDIT — journal entry

packages/schemas/src/event.ts                       EDIT — mirror enum
packages/schemas/src/expenditure.ts                 EDIT — CurrentMapping type
```

## 7. Error handling

| Case | Status | `error` code |
|---|---|---|
| No session cookie | 401 | (preHandler) |
| Expenditure not visible (RLS / cross-tenant / doesn't exist) | 404 | `expenditure_not_found` |
| `activity_id` not in same claim | 404 | `activity_not_in_claim` |
| Apportion: sum ≠ 100 (±0.001) | 400 | `invalid_allocation_sum` |
| Apportion: any pct ≤ 0 | 400 | `invalid_allocation_percentage` |
| Apportion: length outside [1, 5] | 400 | `invalid_allocation_count` |
| Apportion: duplicate `activity_id` | 400 | `duplicate_activity_in_allocation` |
| Unmap: no current mapping | 400 | `nothing_to_unmap` |
| Mutation on voided expenditure | 409 | `expenditure_voided` |
| Re-map to same activity | 200 | (idempotent — returns existing event) |

**Idempotency**: detected via payload-hash, not client-supplied
idempotency key. Same pattern as `events.ts:insertEventWithChain`.
Bounds chain growth to actual user intent count.

**409 on voided expenditures** rather than 400: the request is
well-formed, the *state* is wrong. Matches the pattern in
`submit-claim.ts` and similar state-machine endpoints.

## 8. Test coverage

### API integration tests (`apps/api/src/routes/expenditures.test.ts`)

Seed: 1 tenant, 1 user, 1 subject_tenant, 1 claim, 2 activities
(CA-001 core, SA-001 supporting), 3 expenditures (E1 unmapped,
E2 mapped to CA-001, E3 apportioned across both).

1. GET list: 401 without session
2. GET list: returns all 3 with correct `current_mapping` per
3. GET list `filter=unmapped`: returns only E1
4. GET list `filter=mapped`: returns E2 and E3
5. GET list: RLS isolation — other tenant invisible
6. POST :id/map: 200, emits EXPENDITURE_MAPPED, projection reflects
7. POST :id/map: 404 when activity in different claim
8. POST :id/map: idempotent — re-map to same activity, no duplicate event
9. POST :id/apportion: 200, emits EXPENDITURE_APPORTIONED, projection reflects
10. POST :id/apportion: 400 on sum ≠ 100, any pct ≤ 0, length outside [1,5], duplicate activity
11. POST :id/unmap: 200, emits EXPENDITURE_UNMAPPED, projection null
12. POST :id/unmap: 400 when not mapped
13. POST any mutation: 409 when expenditure voided

### Projection unit tests (`expenditure-projection.test.ts`)

- Empty event list → null
- Single MAPPED → single
- MAPPED → APPORTIONED → apportioned
- APPORTIONED → MAPPED → single
- MAPPED → UNMAPPED → null
- Three MAPPED with different activities in shuffled order → latest by (captured_at, id) wins

### Parity test (`expenditure-projection-parity.test.ts`)

Feeds the same synthetic chain to both the server projection (new) and
the client projection (existing). Three chains: only-mapped,
only-apportioned, mixed-with-unmap. Asserts identical output.

### Deferred (playwright)

UI integration, optimistic updates, error-toast surfacing. Follow-up PR.

## 9. Non-goals (explicit)

- `EXPENDITURE_LINE_MAPPED` projection (line-level granularity).
- New mapping UI; the existing UI already covers all four operations
  via the C5 expenditure tab.
- Mapping-rule engine integration (F5's apply-rules path already emits
  the same event kinds via a different route; the projection naturally
  reflects rule-based mappings without extra work).
- Bulk operations (map-all-by-vendor); single-expenditure only in this PR.

## 10. Acceptance

- All 13 API tests pass
- All 6 projection unit tests pass
- Parity test passes on all 3 synthetic chains
- EVIDENCE_KINDS parity test continues to pass (with `EXPENDITURE_UNMAPPED` added to both files)
- `pnpm typecheck` + `pnpm lint` green
- Manual smoke: from `/claims/<id>/expenditures` page, can map/apportion/unmap an expenditure and see the projection update in subsequent reads
