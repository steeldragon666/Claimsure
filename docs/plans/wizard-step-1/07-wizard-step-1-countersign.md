# 07 — Wizard Step 1 Countersign UI

**Depends on:** 02 (API endpoints)

## Goal

Add Step 1 ("Engagement") to the consultant wizard, with:
- Status badge showing current `engagement_status` (pending_send / sent / signed / countersigned / declined / expired).
- "Send engagement letter" button (calls `POST /v1/claims/:id/engagement/send`).
- "Countersign" button (visible only when `engagement_status = 'signed'` and not already countersigned).
- Read-only view of the rendered letter + signed PDF download link.

## Files to add/modify

- `apps/web/src/app/consultant/_components/wizard-view.tsx` — add a Step 1 panel above the existing steps. Do NOT modify the STEPS const if W1 has shipped (which adds dynamic step indicator); instead extend the catalog.
- `apps/web/src/app/consultant/_components/engagement-panel.tsx` — new component for the Step 1 panel
- `apps/web/src/lib/hooks/use-claim-engagement.ts` — hook fetching `GET /v1/claims/:id/engagement` (or list-by-claim variant — check task 02's endpoint shape)
- `apps/web/src/lib/hooks/use-send-engagement.ts` — mutation for send
- `apps/web/src/lib/hooks/use-countersign-engagement.ts` — mutation for countersign

## Panel layout

```
┌─────────────────────────────────────────────────────────┐
│ STEP 01 · ENGAGEMENT             [STATUS_PILL: signed] │
├─────────────────────────────────────────────────────────┤
│ Vantage Industries — Engagement Letter                  │
│ Sent: 14 May 2026, 09:42  │  Signed: 18 May 2026, 11:30│
│ Signer: Jane Doe (Director)                             │
│                                                         │
│ [View letter] [Download signed PDF]                     │
│                                                         │
│ ┌─ Awaiting countersign ────────────────────────────┐  │
│ │ [Countersign as Anna Pemberton]                   │  │
│ └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

State variants:
- `pending_send` → "Send engagement letter" CTA button (only).
- `sent` → Sent timestamp + "Resend" link + "Awaiting claimant signature" status.
- `signed` → Signed info + Countersign CTA.
- `countersigned` → Signed info + countersign timestamp + PDF download (final state for happy path).
- `declined` → Declined timestamp + reason + "Send a new engagement letter" CTA.
- `expired` → Expired timestamp + "Send a new engagement letter" CTA.

## Architecture rules

- Use design tokens (no Tailwind).
- Match StatusPill conventions from `atoms.tsx`.
- Block downstream wizard steps when `engagement_status NOT IN ('signed', 'countersigned')`. Render the next steps grayed out with a "Engagement required" overlay.

## Acceptance

- [ ] All 6 state variants render correctly.
- [ ] Send button enqueues the engagement letter (verify via API response).
- [ ] Countersign button flips state to `countersigned` and refetches.
- [ ] PDF download link works once `pdf_evidence_id` is populated.
- [ ] Downstream wizard steps are blocked until signed/countersigned.

## Deliverable

PR titled `feat(web): wizard step 1 — engagement letter management + countersign`.
