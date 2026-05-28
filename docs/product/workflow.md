# ArchiveOne — Product Workflow (source of truth)

**Status:** LOCKED 2026-05-27. This is the canonical workflow spec. UI, IA, and
agent work build to this. If code or another doc conflicts with this file,
this file wins (raise a PR to change it deliberately, don't drift).

---

## The one-sentence model

**The claimant captures evidence in the moment and triggers "Prepare claim";
the AI prepares the entire claim; the consultant renders judgement by
approving it step-by-step.** The consultant's job is *approval*, not authoring.

This is the whole product. Every screen serves this loop.

---

## Actors

- **Claimant** — the R&D company. Works mostly on the **mobile app**. Captures
  evidence (voice notes, photos, documents, calculations) in the moment, and
  can trigger **"Prepare claim"** when a period's work is ready.
- **Consultant** — the R&DTI advisory firm. Works in the **web workspace**.
  Their core action is **judgement**: reviewing and approving the AI-prepared
  claim. The dashboard line "*N claims need your judgement today*" is literally
  the work queue.
- **AI pipeline** — on "Prepare claim", does the authoring: classifies evidence,
  drafts activities against Division 355, runs IP/prior-art search per
  hypothesis, apportions the accounting ledger onto activities, drafts the
  cited technical narrative.

---

## Hierarchy

```
AGENCY                      (the consulting firm — one, set up once)
└─ CLIENT                   (a claimant company — many per agency)
   └─ CLAIM                 (MANY per client — one per period)
```

- **Agency** is configured once: name, ABN, logo → the white-label brand on
  every client-facing document.
- A **Client** is a claimant company. Added manually or selected from a
  preloaded list.
- A **Claim** is a single R&DTI claim **for a period**. A client has **many**
  claims per year — typically quarterly — because they **finance the refund**:
  rather than waiting for the annual tax return, they file periodic claims and
  finance each refund as it lands. 1, 2, 3 or 4 claims/year are all normal.
  The period is implicit — a claim is created by hitting **"Prepare claim"**,
  not by picking a date range up front.

---

## Per-client setup (gates everything below it)

1. **Engagement letter** — consultant sends it; the **claimant signs first**;
   the **consultant countersigns**. Until signed + countersigned, every
   downstream surface for that client is **gated** (the "ENGAGEMENT REQUIRED"
   overlay). This is Wizard Step 1's backing feature, already built.
2. **Connect data** — Xero / MYOB accounting connection at the client level.
   The ledger feeds every claim's apportionment. Evidence, by contrast, is
   captured **per claim** (see below).

---

## The claim lifecycle

```
1. PREPARE CLAIM            triggered by claimant (mobile) OR consultant (web)
        │                   → consultant is notified: "claim needs judgement"
        ▼
2. AI PREPARES              classify evidence → Core/Supporting activities (Div 355)
                            → IP search per hypothesis
                            → apportion ledger → activities
                            → draft cited technical narrative
        │
        ▼
3. CONSULTANT APPROVES      6-step wizard, reviewed + approved PER STEP:
   (per-step, in order)       1. Hypotheses (+ IP search results)
                              2. Activities (Core vs Supporting, Div 355)
                              3. Apportionment (ledger → activities)
                              4. Evidence (artifacts bound to activities)
                              5. Narrative (AI draft, cited)
                              6. Review (final check)
                            Each step must be explicitly approved before the
                            next unlocks. No "approve all" shortcut — judgement
                            is per-step by design.
        │
        ▼
4. SEAL                     approved claim sealed as a cryptographic block on
                            the evidence chain (immutable, audit-ready)
        │
        ▼
5. FINANCE THE REFUND       sealed claim submitted to the financing rail so the
                            client finances this period's R&D refund
```

- **Evidence is per-claim.** Each claim owns the evidence window for its period.
  Continuous mobile/Xero capture lands against the client, but is scoped into
  the specific claim when "Prepare claim" fires.
- **Approval is per-step, in order.** The consultant reviews the AI's output for
  each of the 6 steps and approves it; the next step unlocks only after the
  prior is approved. The claim can only seal once all 6 are approved.

---

## Navigation / IA the UI must implement

```
Dashboard            queue of claims needing judgement + KPIs across the firm
Clients              list → add client → per-client: engagement, data connect
  └─ Client          that client's CLAIMS list (Q1 FY26, Q2 FY26, …) + "Prepare claim"
       └─ Claim      the 6-step approve-wizard for one period's claim →
                     seal → finance
Evidence vault       per-claim evidence (capture lands here, binds to activities)
Chain                the sealed-block ledger
Watch                regulatory signals ranked by the firm's exposure
Financing            refunds being financed, per sealed claim
```

The existing `/consultant` workspace renders this shell (dark/amber System A).
Wiring it to the real APIs — and adding the **Prepare-claim trigger** + the
**per-step approval** gating — is the build that makes it functional.

---

## What's built vs what's pending (as of 2026-05-27)

- **Built + live:** dark/amber theme (System A, locked); consultant workspace
  shell; engagement-letter gate (Step 1); IP-search per hypothesis (Step 2,
  API + wizard UI); functional onboarding "Setup" view (agency → client →
  evidence/accounting, wired to real APIs — but evidence/accounting need to
  move to claim level per this spec).
- **Pending:** Prepare-claim trigger (mobile + web); the AI-prepare pipeline
  surfaced as a claim status; per-step approval gating across the 6 wizard
  steps; claims-list-per-client IA; seal-to-chain action; financing handoff.

---

## Non-negotiables (inherited from CLAUDE.md architecture rules)

- Every claim-bearing row carries forensic metadata (`first_recorded_at`,
  `hypothesis_formed_at` immutable post-insert). Hypothesis must precede
  experiment — the chain proves contemporaneity.
- Sealing writes an append-only chain block; sealed claims are immutable.
- Narrative uses citation-only multi-cycle summaries (no free-text re-paraphrase
  of prior-year content).
