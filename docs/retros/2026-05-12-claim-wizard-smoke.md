# Claim Wizard — Happy-Path Manual Smoke Test

**Date:** 2026-05-12
**Scope:** End-to-end flow from claim creation through document generation.

---

## Flow

1. **Create claim** — Subject-tenant detail page > "New claim" button > enter fiscal year > submit.
   - `createClaim` POST succeeds, `initializeWorkflow` POST fires (best-effort), redirects to `/claims/<id>?step=1`.
   - Claim now has `workflow_state` (non-null) so `is_wizard_claim = true` and the wizard view renders.

2. **Step 1: Upload Evidence** — Upload 2+ source documents via `UploadEvidenceButton`.
   - Files are uploaded to media storage and evidence events are emitted.
   - `EventFeed` shows the new events.
   - `canAdvance['1']` flips to `{ ok: true }` once at least one evidence event exists.
   - Click "Next: Review Activities".

3. **Step 2: Review Activities** — AI-proposed activities appear via `PendingNarrativePanel`.
   - On step-1 agree, the `claim-activity-proposal` pg-boss job fires the synthesize-register Sonnet agent.
   - The agent drafts `ACTIVITY_REGISTER_DRAFTED` events (proposed activities).
   - Consultant reviews, edits, and approves the narrative.
   - Approving the narrative auto-creates `activity` rows.
   - `canAdvance['2']` requires at least one activity to exist.
   - Click "Next: Attribute Evidence".

4. **Step 3: Attribute Evidence** — Activity cards with "Link evidence" buttons.
   - On step-2 agree, the `claim-evidence-binding` pg-boss job fires the auto-allocator Haiku agent.
   - The allocator links unbound evidence events to activities (confidence >= 0.65).
   - Consultant reviews auto-suggested bindings and adjusts manually via `BindToActivityButton`.
   - `canAdvance['3']` requires all activities to have at least one linked artefact.
   - Click "Next: Narrative & Timeline".

5. **Step 4: Narrative & Timeline** — Split-pane: R&D narrative (left) + fiscal-year timeline (right).
   - `NarrativeStream` renders the synthesised narrative from analysis events.
   - `FiscalYearTimeline` shows the claim's fiscal year context.
   - Consultant reviews and agrees sections.
   - Click "Next: Generate Documents".

6. **Step 5: Generate Documents** — Trigger document generation.
   - Currently simulated: endpoints not yet connected.
   - Clicking "Generate all documents" shows generating state, then "Not yet available" after 2s.
   - Real generation will produce: Application Form, R&D Activities Schedule, Technical Report (PDF).

---

## Known Rough Edges

### Critical (blocks real usage)

- **Step 5 generation is a stub.** The document generation endpoints do not exist yet. The component simulates the flow with a 2-second timeout. No actual documents are produced.

### Important (functional but imperfect)

- **`BindToActivityButton` receives empty `eventId`.** In `wizard-step-3-attribute.tsx:98`, the `eventId` prop is hardcoded to `""`. The component needs the specific evidence event ID to link. This should be wired to a file picker or evidence list.

- **Step 2 relies on `PendingNarrativePanel`.** This component was designed for the subject-tenant detail page context, not the wizard. If the panel's query keys or scoping don't align with the claim-specific workflow, the narrative may not appear.

- **No "Back" button.** Steps only have "Next". The user can click stepper circles to navigate back, but there's no explicit "Back" button in the step footer.

- **Stale banner uses `en-AU` locale.** The `StaleStepBanner` formats `agreed_at` with `toLocaleDateString('en-AU')`. This is appropriate for Australian R&DTI consultants but may need i18n if the platform serves other locales.

### Minor (polish)

- **Step 5 has no "Next" button or completion action.** After "generating" completes (currently simulated), there's no CTA to finalize or download. The real implementation should provide download links.

- **`_canAdvance` is unused in Step 5.** The prop is prefixed with `_` to suppress lint, but Step 5 should eventually use it to gate the "Generate" button (only enable when all prior steps are agreed).

- **`_claimId` unused in Step 2.** The claim ID is destructured but unused — the `PendingNarrativePanel` only takes `subjectTenantId`. If Step 2 needs claim-scoped queries, this will need wiring.

- **No polling or SSE for agent job status.** Steps 2 and 3 fire pg-boss jobs on agree, but the wizard doesn't show real-time progress. The user must manually refresh to see results after the agent completes.

---

## Observations

- The `initializeWorkflow` call in `create-claim-button.tsx` is best-effort (swallowed catch). If it fails, the user sees the legacy tabbed view. This is intentional graceful degradation, but should be monitored in production logs.

- The stepper visual state correctly reflects agreed steps (green checkmark) vs. current (outlined) vs. future (grey). Navigation via stepper circles works.

- The stale-step banner condition (`stepEntry !== null && !canAdvance.ok`) correctly identifies steps that were previously valid but have become stale due to data changes.

---

## Verdict

The wizard skeleton is complete and navigable. Steps 1-4 render real components with real data queries. The two agent jobs (activity proposal on step-1 agree, evidence binding on step-2 agree) are wired and functional. Step 5 is a UI stub awaiting backend generation endpoints. Primary blocker for production use is document generation (Step 5).
