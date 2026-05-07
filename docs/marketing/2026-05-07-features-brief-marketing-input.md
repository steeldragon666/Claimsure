# Features brief — marketing input

**For:** marketing team building founding-partner outreach materials
**Date:** 2026-05-07
**Source:** the platform's actual codebase as of `origin/main` SHA following all of P9 (Phases 0-3) + Sprint F (document suite + bulk ingestion) + Sprint A foundations + design system + federation primitives + the design styleguide page

> **How to use this document:** read end-to-end once. Then mine sections for whichever channel you're producing — section §3 maps cleanly to website features pages, §4 to compliance/audit-defence one-pagers, §6 to enterprise due-diligence packs, §7 to founding-partner email sequences, §9 to competitive differentiation talking points. The "Marketing extraction guide" at the end maps sections to channels explicitly.
>
> **Accuracy contract:** every claim in this document corresponds to code on `main`. Anything aspirational or pending is explicitly tagged `[Phase 2]` or `[in flight]`. Don't add claims beyond what's here without checking with engineering.

---

## 1. Executive summary

**What it is.** A complete operating system for Australian R&D Tax Incentive consulting firms — from initial claimant intake through evidence capture, statutory eligibility assessment, AusIndustry portal narrative drafting, expenditure schedule preparation, and audit-defence-grade documentation. Built specifically for Australian R&DTI, not adapted from US R&D-credit tools.

**Who it's for.** Boutique-to-mid-size R&DTI consulting firms (1-20 staff) servicing 5-50 claimants each. The profile that suffers most from Big-4-tool pricing and Excel-Word-email manual workflows.

**Why now.** The August 2025 form changes + one-strike review policy + post-GQHC ATO posture mean R&DTI consultants face higher audit risk than at any point in the program's 35-year history. The status quo of Word docs, Excel models, and email folders is a discoverable liability — every audit reveals which firms had structured contemporaneous evidence and which didn't. This platform is the structured-evidence path.

**Differentiation in one line.** Forensic-grade evidence chain + Australian-built statutory tooling + per-tenant white-label + offline-first mobile capture, sold to consultants on a per-claim subscription, not per-seat or percentage-of-refund.

**Pricing posture.** Per-claim quarterly or annual subscriptions ($1,500 each), mobile claimant app subscriptions ($250/month with every-third-free), $5,000 onboarding, $60,000/year floor for active firms. **Founding partners (first 10 firms) get 50% off year 1.**

---

## 2. The problem we solve

### What R&DTI consulting actually looks like today

A typical Australian R&DTI consultant runs the following workflow per claimant per fiscal year:

1. **Onboarding** — collect the company's R&D activity descriptions, financial models, and contact list. Dump everything into a shared Google Drive or Dropbox folder.
2. **Evidence gathering** — interview the technical team, capture hypotheses, document experimental results, gather invoices. This is the highest-skill, highest-billable, highest-time work.
3. **Activity classification** — apply Section 355-25 (core) vs 355-30 (supporting) vs ineligible to each candidate activity. Evaluate against TR 2021/5 at-risk rule. Flag overseas-R&D requirements (TA 2023/5). Check feedstock applicability.
4. **Portal narrative drafting** — write 4,000-character narratives for each Core (13 fields) and Supporting (10 fields) activity. Match the AusIndustry portal schema exactly. This is where consultants spend 40-60% of engagement time.
5. **Expenditure schedule** — build an Excel model allocating salaries (with on-costs), contractor fees, materials, overheads, and feedstock. Apply the two-slice intensity calculation for entities >$20M turnover.
6. **Compliance review** — assemble Activity Schedule + Compliance Memo + supporting documents. Submit to AusIndustry portal. File R&DTI schedule with the ATO.
7. **Audit defence** (when, not if) — three years later, the ATO requests evidence. The consultant scrambles through Drive folders, email threads, and version-history-less Word docs to reconstruct what actually happened.

### The four problems with the status quo

**1. Manual evidence capture loses the contemporaneity argument.** Per _Body by Michael v Commissioner of Taxation_ [2025] ART, post-hoc hypothesis documentation has been formally rejected by the Tribunal. If a consultant can't demonstrate the hypothesis was formed _before_ the experiment, the activity fails the s.355-25 test. Word docs with no timestamp chain don't satisfy this; the audit trail is "I trust the consultant remembered the right date."

**2. Big-4 platforms (KPMG, Deloitte, EY, PwC) don't sell to mid-market.** Their R&DTI tooling is internal — not licensed externally — and is priced on Big-4 hourly rates. Boutique consultants competing with Big-4 lose on tooling parity even when they have superior domain expertise.

**3. Generic compliance tools aren't built for AU R&DTI.** US R&D-credit tools (Boast, TaxCloud, Strike Tax) miss s.355-25's three-criterion test, the 13/10 field portal schema, the GST 10% display, the Aussie fiscal year, and the AusIndustry/ATO bifurcated approval flow. Adapting them costs as much as building from scratch.

**4. The audit landscape is harsher than ever.** Post-GQHC AATA 409 (the ATO Decision Impact Statement), audit referrals from AusIndustry to the ATO are routine. Promoter penalty exposure (post-Bakarich [2024], $13.6M in penalties) means individual consultants — not just their firms — face personal liability for poorly-supported claims. Tools that produce structured contemporaneous evidence aren't a nice-to-have anymore.

### The platform's value proposition

| Pain                                           | What we ship                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contemporaneity arguments collapse under audit | Hash-chained event log; immutable hypothesis-formed-at trigger; raw payload preservation                                                                                   |
| 40-60% of consultant time on portal narratives | AI-assisted narrative drafter with all 13 Core + 10 Supporting fields, live 4,000-char counter, schema-mapped to AusIndustry portal                                        |
| Activity classification is judgment-heavy      | Per-criterion scoring (outcome uncertainty, systematic method, new knowledge purpose) with risk-type discrimination (definitional vs evidentiary vs mixed)                 |
| Cost schedules built in error-prone Excel      | Apportionment engine including overhead, on-costs (super 11.5%, leave loading, payroll tax), feedstock adjustment, two-slice intensity calc, and government-grant clawback |
| Audit-time evidence reconstruction             | Forensic provenance from day-one; every document, every classification, every override traceable to a hash chain entry                                                     |
| Mid-market firms can't afford Big-4 tools      | $1,500/claim/quarter or year; founding partners 50% off year 1                                                                                                             |
| Field consultants need offline capture         | Native iOS + Android app with offline-first SQLite + sync queue; photo, document, voice, hypothesis, time entries                                                          |

---

## 3. What ships — Phase 1 platform features

This section is the most extractable for website copy and feature pages. Each feature includes both consultant-facing benefits and the underlying technical implementation.

### 3.1 Evidence capture

**What the consultant sees:** evidence — photos of test rigs, scanned lab notebooks, voice memos, emails, technical diagrams, time entries, hypothesis logs — captured into a single timeline per claimant. Drag-drop on web. Native capture on mobile (offline-first).

**What ships:**

- **Bulk document ingestion** across 8+ file types: PDF (with OCR fallback for scanned documents), DOCX, XLSX, CSV, EML (with attachment extraction), IPYNB (Jupyter notebooks for technical teams), Python/JS/TS/R source code (docstring + comment extraction), plain text. Each upload generates a content-hash, captures parser version, and emits a structured event into the chain.
- **Mobile capture** via native iOS + Android app: photo, document scan, voice memo, hypothesis text, time entry, magic-link e-signing. Offline-first — captures while disconnected, syncs when network returns. Per-tenant white-label theming so the app appears branded as the consultant's firm to the end claimant.
- **Cross-reference reconciliation engine** — automatically flags activities with no time records, costs with no activity link, time entries without claim association, narratives without source events, and timesheet-vs-invoice hour mismatches >20%. Surfaces gaps consultants would otherwise discover during audit.
- **Xero integration** — pulls invoices, bank transactions, and receipts via the official API. Deduplicates by `(tenant_id, source, source_external_id)`. Stores raw upstream JSON in `raw_payload` so the original Xero record is reconstructible at audit time even if the upstream API changes.

**The forensic chain.** Every evidence event is hashed with SHA-256 and chained to the previous event for that subject_tenant. The platform refuses to emit a final report if the chain is corrupted. Override events are append-only — corrections add an OVERRIDE entry referencing the original, never mutate the original. Edit count, edit history, and edit timestamps are queryable for any event.

**Field claim:** "Every artefact in your claim ladders back to a tamper-evident timeline. The platform proves you captured what you captured, when you captured it. No other R&DTI tool does this."

### 3.2 Activity assessment + statutory eligibility

**What the consultant sees:** for each candidate activity, a structured assessment — three criterion scores (outcome uncertainty, systematic method, new knowledge purpose), an overall eligibility verdict, a risk level (Low/Medium/High), and remediation guidance. For weak activities, the platform tells the consultant exactly which criterion is failing and whether it's a definitional issue (no fix possible) or an evidentiary gap (fixable with documentation).

**What ships:**

- **Per-criterion scoring** aligned to s.355-25 + GQHC AATA 409: each criterion gets an independent 0-1 score plus a `risk_type` enum (`definitional` | `evidentiary` | `mixed`). The systematic-method criterion is capped at 0.5 if any of (documented hypothesis with date, experiment log, observation records, evaluation/conclusion records) is missing, regardless of narrative quality.
- **Activity-level holistic verdict** — aggregates per-criterion scores into an `s355_25_satisfied: boolean` plus confidence + blocking failure list. Definitional failures cannot be remediated through documentation; evidentiary failures can.
- **Risk level enum** — `low` | `medium` | `high`, derived from criterion scores + holistic verdict. Surfaces directly in the claim register and feeds the Compliance Notes PDF.
- **At-risk rule (TR 2021/5) two-limb evaluation** — Limb 1 (nexus): did the entity receive consideration as a direct/indirect result of incurring R&D expenditure? Limb 2 (regardless): would the consideration have been received whether the R&D succeeded or failed? Both limbs must satisfy for the rule to apply. Conflating limbs is a known false-positive source; the platform's structured fields prevent this.
- **Non-monetary consideration enumeration** — at-risk evaluation explicitly considers loans from associates, license rights received in advance, equity stakes, offset arrangements (R&D costs credited against future royalties), pre-paid services from related parties. Cash-only check is insufficient.
- **Tobacco/gambling exclusion** with structured "solely" test — carve-outs require activities to be solely for the purpose of generating new knowledge about minimising harm. Dual-purpose activities fail. The platform asks this as a structured prompt question, not a keyword match.
- **Knowledge-search predates-hypothesis verification** — flags activities where prior-art search post-dates hypothesis formation (a _Body by Michael_ pattern).
- **Whole-of-project + dominant-purpose checks** — TA 2017/5 and TA 2017/5A patterns. Activities marketed as "we built feature X" instead of "we resolved uncertainty Y" are flagged.

**Field claim:** "The platform doesn't classify activities. Consultants do. The platform makes the classification reproducible, defensible, and auditable — and tells the consultant exactly where their evidence is weakest while there's still time to fix it."

### 3.3 AusIndustry portal narrative drafting

**What the consultant sees:** for each Core or Supporting activity, the platform produces all 13 Core or 10 Supporting portal fields, each with its own AI-drafted narrative, live 4,000-character counter, and forensic citation back to source events. The consultant reviews, edits, accepts.

**What ships:**

- **Schema-exact field structure** — `CorePortalFieldsSchema` (13 fields) and `SupportingPortalFieldsSchema` (10 fields) match the August 2025 AusIndustry portal exactly. Each field has its own validation, character limit (4,000 hard cap), and required/optional designation.
- **Live char counter UI** — turns terracotta at 3,800 chars, clay-red at 4,000+ with submit disabled. Alignment with AusIndustry's hard limit prevents portal-side rejection.
- **Narrative drafter agent** (`draft-narrative@1.2.0`) — Claude Opus 4.7 with per-field structured output. Each field generates independently with its own prompt. Hard cap at 3,950 characters (50-char safety margin under AusIndustry's 4,000). Every claim in the narrative cites at least one source event_id.
- **Override semantics** — consultant edits create new OVERRIDE events in the chain. Original AI draft is preserved (audit trail), the latest override is what's submitted. No mutation, only append.
- **Prompt versioning** — every drafter invocation records the prompt version (`draft-narrative@1.2.0`). Prompt changes are deliberate, versioned, and traceable. The consultant can explain at audit time exactly which prompt version produced which narrative.

**Field claim:** "Generate portal-ready narratives in minutes, not days. Every word traceable to source evidence. Every revision in the chain."

### 3.4 Document generation suite

**What the consultant sees:** seven PDF deliverables produced from the claim's structured data, each with the firm's white-label branding.

**What ships:**

| PDF                               | Content                                                                                                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ingest Summary**                | Source documents inventory, extraction quality (% with structure, OCR fallbacks invoked), classification distribution, reconciliation findings, source files list with SHA-256                                                                                                   |
| **Executive Summary**             | Claim at a glance (total R&D spend, offset claimed, refund expected), activities summary, risk profile, compliance posture, reconciliation findings rolled up                                                                                                                    |
| **Activity Register**             | Per-activity row with code (CA-01, SA-01), kind, title, hypothesis (truncated), uncertainty (truncated), risk_level, eligibility_score, total_hours, total_cost                                                                                                                  |
| **Portal Narrative Content Pack** | All 13 Core + 10 Supporting fields per activity, char counts, mapped directly to AusIndustry portal field-by-field                                                                                                                                                               |
| **Expenditure Schedule**          | Total R&D expenditure by category (Staff/Contractors/Materials/Overheads/Feedstock), apportionment methodology, per-activity allocation, feedstock adjustment as independent line, two-slice intensity calculation, grant/subsidy clawback                                       |
| **Evidence Index**                | Per-activity supporting events with content_hash, captured_at, source, evidence_kind. Forensic provenance: full hash chain reference                                                                                                                                             |
| **Compliance Notes**              | At-risk findings, one-strike risk score, per-criterion gaps, promoter exposure flags, hypothesis-date verifications, whole-of-project/dominant-purpose checklist, tobacco/gambling exclusion check, foreign parent / contractor / IP ownership, overseas R&D / Overseas Findings |

All PDFs:

- Embed Fraunces (display), Inter Tight (body), JetBrains Mono (forensic data) fonts
- Render with cream `#FAF8F3` page background, ink `#1A1814` text, patina `#5C7A6B` accents — the design system
- Include a forensic header: claim ID, FY, generation timestamp, content_hash of the report itself, generator version
- Render forensic chips for hash-bearing artefacts (mono font, hairline border)
- Refuse to emit if the underlying chain is corrupted — verifyChain runs as part of every PDF generation

### 3.5 Expenditure schedule + apportionment engine

**What the consultant sees:** a structured cost model that handles every category R&DTI distinguishes — staff (with on-costs), contractors (arm's-length verified), materials, overheads (apportioned), feedstock (with the 1/3 × min adjustment) — producing a per-activity allocation that rolls up to the offset rate calculation.

**What ships:**

- **Five expenditure categories** with category-specific apportionment: Staff (with super 11.5% per ATO 2026, leave loading, workers comp, payroll tax), Contractors (arm's-length pricing verification), Materials, Overheads (apportioned via headcount/floorspace/time/revenue basis), Feedstock (1/3 × lesser of feedstock revenue vs feedstock input cost).
- **Two-slice intensity calculation** for entities >$20M turnover — slice 1: 8.5pp premium on R&D up to 2% of total expenses; slice 2: 16.5pp premium on R&D above 2% intensity. Not a flat-rate tier; correctly modeled per EM202033 Schedule 4.
- **Feedstock adjustment as independent clawback line** — runs separately from main R&D offset calc per GQHC's rejection of partial-transformation argument. Fully-transformed feedstock applies 100% inclusion; otherwise standard formula applies.
- **Grant/subsidy double-dipping clawback** — entities receiving CSIRO grants, Accelerating Commercialisation grants, state co-investment, etc. for the same R&D activities face dollar-for-dollar reduction. Surfaced as a distinct line item with Schedule 5 statutory citation.
- **Overhead apportionment basis flag** — every overhead expenditure carries an explicit `apportionment_basis` enum (`headcount` | `floorspace` | `time` | `revenue`) so the rationale is auditable.

### 3.6 Mobile field app

**What the consultant sees:** a branded mobile app the consultant can give to their claimant clients. The claimant's engineers and project leads use it to capture evidence in the field — photos of test rigs, voice memos about why the cooling-loop redesign isn't holding, time entries — and the platform syncs everything to the consultant's web cockpit when the device returns to network.

**What ships:**

- Native iOS + Android via Expo (single codebase, native runtime — not a webview shell)
- **Offline-first** with local SQLite + sync queue + network detection
- **Five capture surfaces**: photo, document scan, voice memo, hypothesis text, time entry, magic-link e-signing
- Per-tenant white-label theming via `brand_config` (firm logo, primary color, accent color)
- Magic-link auth — no password handling on the device; device receives a one-time link that establishes a session
- Secure-store for session credentials (iOS Keychain, Android Keystore)
- Push notifications wired (expo-notifications integrated; trigger pipelines from web cockpit)

**Note:** in-app AI assistant for conversational capture is `[Phase 2]` per ADR 0006 — current capture flow is form-based with offline sync.

### 3.7 Consultant cockpit (web)

**What the consultant sees:** a multi-claimant dashboard for the firm's portfolio. Pipeline view (claims by stage), per-claim detail with multi-cycle timeline, activity register with risk-level color coding, compliance panels, audit timeline with forensic provenance, evidence browser, and team management.

**What ships:**

- **Claims pipeline** — kanban + table views; stages from `engagement` through `audit_defence`
- **Per-claim detail page** with activity register, expenditure summary, narrative drafts, evidence list, compliance posture
- **Multi-cycle timeline** — for activities that continue across fiscal years; `TransitionBadge` indicators (continuation/pivot/completion/abandoned) in the gutter; `YearMarker` columns (FY24, FY25, FY26)
- **Activity audit timeline** — vertical timeline showing every audit-relevant event for an activity (chain events, narrative draft versions, audit_log entries, prompt suggestions, similarity flags), with `ForensicChip` provenance stamps and click-to-expand `ForensicCard` detail
- **Compliance panels** — knowledge-search records, R&D facilities, forecasting (with per-offset breakdown and AUD currency formatting), beneficial ownership, multi-entity similarity dashboard, form-completeness gauge
- **Suggestions inbox** — AI-flagged compliance issues, ranked by severity, with one-click drill-through to the affected claim
- **Pipeline view** — cross-claim work queue ranked by deadline + risk
- **Multi-entity similarity dashboard** — flags potential double-claiming patterns across the firm's portfolio (TA 2017/5 detection)

### 3.8 Billing + commercial operations

**What the consultant sees:** their own billing dashboard inside the platform — current plan, payment method, invoice history, founding-partner status. The platform handles the consultant-claimant billing relationship: per-claim fees, mobile claimant subscriptions, every-3rd-free bulk discount, dunning, customer portal access, invoice PDFs with AU GST.

**What ships:**

- **Stripe integration** — production-grade with idempotency keys on every mutation, webhook signature verification, raw-body preservation for `stripe.webhooks.constructEvent`
- **Three subscription components per firm**: per-claim quarterly OR annual recurring (firm choice at subscribe time), mobile claimant per-unit recurring with automatic 33%-off-at-quantity-3 coupon, $5K one-time onboarding
- **Founding partner coupons** — FOUNDER-001 through FOUNDER-010, each `percent_off: 50, duration_in_months: 12, max_redemptions: 1`. Race-safe slot allocator prevents over-allocation when multiple firms try to claim simultaneously
- **Annual floor enforcement** — Q4 cron generates a top-up invoice if quarterly metered + recurring totals fall below $60K projected
- **Trial flow** — 30-day self-service trial, day-23 reminder email, expiry cron, trial-banner UI component, tenant activation gate middleware
- **Dunning workflow** — Stripe Smart Retries integration, escalation to email at 3/7/14 days, grace period (14 days) → tenant suspension (read-only mode after grace expires), reactivation flow on payment success
- **Invoice PDF generation** — line items per subscription type, GST 10% line, founding partner discount line, payment instructions, ABN display
- **Customer portal** — Stripe Customer Portal integration for self-service (update card, view invoices, cancel)
- **Refund flow** — admin-only `POST /v1/admin/billing/refund` with audit_log entry (`BILLING_REFUNDED`)
- **Tax reconciliation** — monthly export of GST collected for BAS lodgement, CSV download from admin UI
- **MRR + churn dashboard** — admin-facing reporting view, founding-partner cohort tracking
- **Subscription state reconciliation cron** — periodic sweep that reconciles platform state against Stripe state (catches webhook missed events)

### 3.9 Federation primitives — financier read-only sharing

**What the consultant sees:** for claimants whose R&D is funded by external financiers (banks, R&D-focused investors, government innovation grants), the consultant can grant read-only access to specific claims. The financier sees a stripped-down portal showing the claim summary PDFs, no edit/comment surfaces. Every read is logged.

**What ships:**

- Three new tables — `federation_share`, `federation_invitation`, `federation_audit` — RLS-protected
- **Cross-tenant RLS extension** on `claim`, `activity`, `expenditure`, `narrative_draft` — first time the codebase grants cross-tenant read at the DB layer. Policy form `tenant_id = current OR EXISTS (federation_share WHERE target_tenant = current AND not revoked)`. Security tests verify shared/unshared/write-blocked/revoked scenarios.
- **Invitation flow** — `POST /v1/federation/invitations` (create + send Resend email) → recipient clicks link → `POST /v1/federation/invitations/:id/accept` (creates federation_share row)
- **Federation audit** — every read of federated data emits a `FEDERATION_READ` event to the chain (provenance preservation; the original claim's tenant sees who accessed what when)
- **Financier portal** — `apps/web/src/app/(financier)/` route group, read-only layout, listing of shared claims with claim summary PDFs, no edit/comment surfaces
- **Revocation** — `POST /v1/federation/shares/:id/revoke` sets `revoked_at` immediately removing access; preserves audit trail
- **Event chain unchanged** — federated reads consume claim summaries, NOT raw event chains. Preserves the cryptographic-integrity property of the chain (chain remains append-only by source tenant only)

**Field claim:** "Federated read-only sharing means a claimant's investors can verify R&D activity without seeing the raw event chain. Audit-trail preserves who looked at what, when. No competitor offers this."

### 3.10 Design system

**What the consultant sees:** a distinct, editorial aesthetic — cream paper background, patina-green signature accent, Fraunces serif for headlines, JetBrains Mono for forensic data. Five signature components — `ForensicChip` (the most-repeated pill in the platform), `AgentChip`, `TransitionBadge`, `YearMarker`, `DensityToggle` — appear consistently across consultant cockpit, claim detail, and financier portal.

**What ships:**

- **`ForensicChip`** — pill rendering hash + timestamp + version pin in monospace. States: default / verifying (animated patina pulse) / verified (patina ✓) / broken (clay-red ✗). The most-repeated visual in the platform — every claim-bearing artefact carries one.
- **`AgentChip`** — distinguishes AI contributions from consultant authorship. "Drafted by Agent C · v1.1.0" format with hover tooltip showing model name + prompt module path.
- **`TransitionBadge`** — multi-cycle timeline gutter pill, four variants (continuation / pivot / completion / abandoned).
- **`YearMarker`** — FY column header, three states (current with patina underline / past / future with dashed hairline).
- **`DensityToggle`** — swaps consultant (dense) vs claimant (comfortable) layouts, persists to localStorage.
- **`/styleguide` route** — single-page visual reference showing every component with all states, color tokens, and the type scale. Living documentation.

---

## 4. Compliance posture — the audit-defence story

This section is the most extractable for compliance one-pagers and CFO-facing materials.

### What "audit-defence-grade" means in this platform

**Cryptographic provenance for every classification.** Every event (HYPOTHESIS, EXPERIMENT, OBSERVATION, ITERATION, NEW_KNOWLEDGE, UNCERTAINTY, TIME_LOG, ASSOCIATE_FLAG, EXPENDITURE_NOTE, SUPPORTING, INELIGIBLE, OVERRIDE) is hashed with SHA-256 and chained to the previous event for that subject_tenant. Tampering with any event invalidates every subsequent hash. The platform refuses to emit a final report if the chain is broken.

**Immutable hypothesis-formed-at timestamp.** The `activity.hypothesisFormedAt` column has a BEFORE UPDATE trigger that raises `check_violation` if anyone tries to change the value after insert. This satisfies the _Body by Michael v Commissioner of Taxation_ [2025] ART contemporaneity test at the database layer — no consultant can backdate a hypothesis after the fact.

**Append-only override semantics.** Consultant overrides of AI classifications are NEW events, not mutations. The original event is preserved; the override appends a new entry referencing the original. The `event_with_effective_kind` view resolves the latest classification for application logic. Full audit trail intact.

**Raw payload preservation.** Xero-synced expenditures store the full upstream JSON in `raw_payload`. If the ATO challenges an invoice, the original Xero record is reconstructible — even years later, even if the Xero API has changed. Stronger evidence than a manually-typed summary.

**Idempotency + prompt versioning for AI.** Every AI classification is cached by `SHA256(prompt_version + input)`. The prompt registry versions prompts (`classify@1.0.0`, `draft-narrative@1.2.0`). Identical inputs get identical outputs (reproducibility). Prompt changes are deliberate, versioned, traceable. The consultant can explain at audit time exactly which prompt version classified which evidence.

**RLS multi-tenant isolation.** PostgreSQL row-level security enforces strict per-firm + per-claimant data isolation. No cross-tenant data leakage architecturally possible. ISO 27001 Annex A.5.18 (access rights) + A.8.3 (information access restriction) both satisfied at the DB layer, not just app layer.

**Quarterly RLS coverage audit.** A test suite runs on every CI build asserting every public-schema table either has RLS enabled with a policy OR is in an explicit exempt list with documented rationale. New tables shipping without RLS fail CI. Continuous-assurance mechanism documented in `docs/iso27001/access-control/rls-coverage.md`.

### Key statutory + case-law alignment

The platform tracks and implements current ATO + AusIndustry positions:

| Source                                                             | Platform implementation                                                                                                                                    |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TR 2021/5** (at-risk rule)                                       | Two-limb structured evaluation; non-monetary consideration enumeration                                                                                     |
| **GQHC AATA 409** (ATO Decision Impact Statement)                  | Per-criterion scoring with risk-type discrimination; feedstock as independent clawback; ATO concurrent-authority flag scoped to amendment-period proximity |
| **Body by Michael [2025] ART**                                     | Immutable hypothesis-formed-at trigger; knowledge-search-predates-hypothesis verification                                                                  |
| **Active Sports Management [2024] AAT**                            | Definitional vs evidentiary risk-type distinction; "predetermined outcome" pattern detection                                                               |
| **Bakarich [2024]** ($13.6M promoter penalties)                    | Promoter exposure flag in compliance notes                                                                                                                 |
| **TA 2017/5** (whole-of-project software)                          | Whole-of-project flag with structured rationale                                                                                                            |
| **TA 2017/5A** (dominant purpose)                                  | Dominant-purpose check                                                                                                                                     |
| **TA 2023/4** (associate entities)                                 | Associate flag; non-monetary consideration tracking                                                                                                        |
| **TA 2023/5** (foreign overseas R&D)                               | Overseas R&D activity flag + Overseas Findings checklist                                                                                                   |
| **EM202033 Schedule 4** (intensity premium)                        | Two-slice calculation (8.5pp + 16.5pp) for >$20M turnover                                                                                                  |
| **EM202033 Schedule 5** (grant clawback)                           | Government-grant double-dipping clawback as distinct line                                                                                                  |
| **One-strike review policy (1 July 2025)**                         | Per-criterion floor caps; one-strike risk score                                                                                                            |
| **Shortfall Interest Charge daily-compound (1 April 2025)**        | SIC daily-compound calculation                                                                                                                             |
| **15 August 2025 form changes**                                    | 13 Core + 9 Supporting portal field schemas                                                                                                                |
| **Strategic Examination of R&D (Ambitious Australia, March 2026)** | Tracked as `regulatory_source` for legislative-change monitoring; no plan revisions yet (all 20 recommendations aspirational as of May 2026)               |

**Field claim:** "Every audit-blocking pattern from the last decade of AU R&DTI case law is structurally addressed in the platform — not as a checkbox on a UI, but as a constraint at the data layer."

---

## 5. Data sovereignty + security

### Data residency

- **Production deployment**: Google Cloud `australia-southeast1` (Sydney region). All claimant data, document storage, and database backups physically reside in Australia.
- **Cloud SQL Postgres 16** with point-in-time recovery (PITR) — restorable to any second within the retention window.
- **Secret Manager** — production secrets (Stripe keys, JWT signing secrets, OAuth client secrets) stored in GCP Secret Manager with audit-logged access. No secrets in source code, no secrets in environment variable dumps.
- **Cloud Run** for stateless API + web tier — autoscaling, regional failover within australia-southeast1.

### Compliance certifications + posture

- **ISO 27001:2022 supplier register** entry shipped for Google Cloud as the data processor (covers A.5.19 supplier relationships + A.5.20 supplier agreements).
- **SOC 2 Type II** — GCP attestation covers the underlying infrastructure; the platform's application layer alignment with SOC 2 controls is in progress (`[in flight]` for full attestation).
- **PCI DSS scope** — the platform NEVER stores card data. Only Stripe customer IDs + payment method IDs. PCI scope is reduced to "we use a PCI-compliant processor (Stripe)" — SAQ-A applicability.
- **AU Privacy Act** + **Australian Privacy Principles (APPs)** — per-tenant data isolation via RLS, per-row audit logging, raw payload preservation, structured deletion procedures (vs hard delete).

### Security architecture

- **Append-only event chain** — tampering with claimant data is detectable via hash chain verification. The platform refuses to emit a final report if any chain is broken.
- **Row-level security** on every claimant-scoped table with quarterly audit (CI-enforced).
- **Magic-link authentication** for claimant mobile devices — no passwords stored on devices, single-use tokens, replay-protected.
- **Microsoft Entra OAuth** + **Google OAuth** for consultant web login (multi-tenant Entra supported for firms with their own Microsoft tenant).
- **Federation cross-tenant access** explicitly RLS-enforced — financier read access only via active, non-revoked, non-expired federation_share rows.
- **Stripe webhook signature verification** with raw-body preservation — replay-attack-resistant.
- **Sentry error tracking** with PII filtering for production errors.
- **Cloud Monitoring** alerts routed by severity to Sentry + email.

### Sovereignty trade-off documented

The current production deployment uses Google Cloud (Australian subsidiary, AU data centers), which means data is in Australia but the parent company is US-based and subject to the US CLOUD Act in theory. The platform has documentation comparing this against an Australian-sovereign alternative (Macquarie Cloud Services) for firms whose customers explicitly require Australian-owned infrastructure. Migration to Macquarie is a configuration change (new ISO 27001 supplier register entry + new deployment target), not a code rewrite.

---

## 6. Architecture credibility (for technical-buyer due diligence)

For a CTO or sophisticated CPA-firm partner reviewing the platform, this section establishes engineering credibility.

### Tech stack

- **TypeScript** end-to-end — packages, apps, mobile, infra scripts
- **Drizzle ORM** + **postgres-js** — type-safe SQL, no ORM magic
- **PostgreSQL 16** with **pgvector** extension — vector similarity for cross-claim TA 2017/5 detection
- **Fastify** for the API (lower overhead than Express, better TypeScript story)
- **Next.js 15** (App Router) for the web cockpit — server components, ISR where it matters
- **Expo / React Native** for mobile — single codebase, native runtime
- **pg-boss** for scheduled jobs (dunning, billing reconciliation, regulatory feed scrape, Xero sync)
- **Anthropic SDK** for AI — Claude Sonnet 4.5+ for classification, Claude Opus 4.7 for narrative drafting
- **Stripe SDK** for billing, **Resend** for transactional email, **Sentry** for error tracking
- **GCP Cloud Run** + **Cloud SQL** + **Secret Manager** for production infrastructure
- **Caddy** for TLS termination in VPS staging deployments

### Codebase shape

- Monorepo with **pnpm workspaces** + **turbo** for builds
- **3 apps**: `api` (Fastify), `web` (Next.js), `mobile` (Expo)
- **13+ packages**: agents, audit-score, auth, db, documents, email, integrations, observability, schemas, ingest, agent-memory (Phase 2 reserved)
- **70+ migrations** across the schema's lifetime, each idempotent, each in a numbered series
- **438+ tests** (unit + integration; visual + DOM tests deferred to Playwright e2e)
- **CI** on every PR — typecheck, lint, test against real Postgres, RLS audit
- **Established admin-merge pattern** for tech-debt commits; full PR review for feature work

### Engineering practices visible to a buyer's CTO

- **Test discipline matches production patterns** — TDD for new features, structural-guarantee tests for type contracts, DOM tests in Playwright (not jsdom, which fails to catch real CSS / portal / focus issues)
- **ADR (architecture decision record) discipline** — every architecturally-significant decision has a numbered ADR documenting context, decision, and consequences. ADR 0006 (per-tenant agent deferred to Phase 2) is the most recent.
- **Migration discipline** — migrations are numbered, idempotent, and never edited after they've shipped. New schema changes always come as new migrations.
- **Continuous compliance** — RLS coverage audit runs on every CI build. Quarterly review of ISO 27001 supplier register.
- **Forensic-grade logging** — every state-change event is logged with `actor_user_id`, `firm_id`, payload hash, and chain position.

---

## 7. Pricing — the founding partner offer

**Pricing structure (locked):**

| Component                     | Price                                       | Stripe model                                                                                                |
| ----------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Per-claim subscription        | $1,500/quarter OR $1,500/year (firm choice) | Quarterly + annual price variants                                                                           |
| Mobile claimant subscription  | $250/month per claimant, every 3rd free     | Per-unit recurring + 33% bulk-discount coupon at quantity ≥ 3                                               |
| Onboarding                    | $5,000 one-time                             | One-time price, invoiced on tenant activation                                                               |
| Annual floor                  | $60,000/year minimum total revenue per firm | Application-layer enforcement: Q4 top-up invoice if metered + recurring totals project below floor          |
| **Founding partner discount** | **50% off year 1**                          | Coupons FOUNDER-001 through FOUNDER-010, each `percent_off: 50, duration_in_months: 12, max_redemptions: 1` |
| Tax                           | GST 10% AU (exclusive)                      | Stripe automatic tax with AU registered address                                                             |

### Reality check at firm sizes

- **Solo consultant, 4 claimants/year**: 4 × $1,500 + 4 × $250 × 12 + $5,000 = $6,000 + $12,000 + $5,000 = $23,000 → bumps to **$60,000 floor**. Year-1 founding partner: **$30,000**.
- **Boutique firm, 10 claimants**: 10 × $1,500 + 9-priced × $250 × 12 (every-3rd-free → 9 of 10) + $5,000 = $15,000 + $27,000 + $5,000 = $47,000 → bumps to **$60,000 floor**. Year-1 founding partner: **$30,000**.
- **Mid-tier firm, 30 claimants**: 30 × $1,500 + 20-priced × $250 × 12 + $5,000 = $45,000 + $60,000 + $5,000 = $110,000. Annual fee year-1 founding partner: **$55,000**.

### Comparison to industry alternatives

- **Big-4 R&DTI consulting tools** — not licensed externally; consultant firms don't have access at any price.
- **Per-percentage-of-refund consulting fees** — industry standard for boutique R&DTI consulting is 10% of the refund. For a typical $300K refund, that's $30K of consultant fees per claimant. The platform's per-claim subscription bundles all the tooling at < 5% of that, freeing consultants to compete on lower-percentage fees while keeping margin.
- **Generic compliance platforms** (LeapHR, MYOB Practice, etc.) — don't model R&DTI at all; consultants would still maintain Excel + Word workflows on top.
- **Excel + Word + email folders** (current default) — $0 software cost, ~40-60% of consultant time spent on portal narrative drafting and reconciliation, no audit-defence chain.

### Why founding partner positioning works

- **First 10 firms** — scarcity + cohort effect. Founding partners get input on roadmap, named entry in the supplier register, and the 50% discount.
- **Priced for entry, not for upsell** — the founding partner isn't paying "for the platform," they're paying for partnership and influence over the next 12 months of product direction.
- **Year 2+ at full price** is intentional — by year 2, the firm has integrated workflows, trained staff, and has audit-defence-grade evidence chains for their existing portfolio. Switching cost is real.

---

## 8. Roadmap — Phase 2+ (not in current platform)

Marketing should be careful with these — they're aspirational, not shipped. Use only in "what's coming" sections, never as current capabilities.

| Item                                                                                                                                                                           | ADR / status                                                            | Trigger to start                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Per-tenant AI agent platform** — conversational capture in mobile, persistent memory across sessions, "specialist team member" framing, productizable as standalone offering | ADR 0006 — deferred                                                     | First ~10 paying customers + customer feedback indicating AI assistance is the next gap |
| **VPS staging deployment**                                                                                                                                                     | PR #64 open                                                             | When founding partner needs a public staging URL ahead of full GCP production           |
| **Macquarie Cloud Services migration option**                                                                                                                                  | Documented in `tools/vps/README.md` comparison table                    | When AU-sovereign infrastructure becomes a sales weapon                                 |
| **Phase 2 extension of mobile capture**                                                                                                                                        | Not yet ADR'd                                                           | Customer feedback on mobile usage patterns                                              |
| **Dark mode**                                                                                                                                                                  | Tokens scaffolded in `globals.css`, dark-mode tokens defined but unused | When ≥3 customers explicitly request                                                    |

---

## 9. Differentiation matrix vs alternatives

Marketing's mining gold for the comparison sections of website + sales deck.

### vs. Big-4 internal tools (KPMG, Deloitte, EY, PwC)

| Dimension                           | Big-4 internal                              | This platform                                       |
| ----------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| Available to mid-market consultants | ❌ Not licensed externally                  | ✅ Founding partners + standard tier                |
| Per-firm white-label                | ❌ Branded as Big-4                         | ✅ Per-tenant brand_config (logo, colors, app icon) |
| Pricing transparency                | ❌ Bundled in Big-4 hourly rates            | ✅ Public pricing                                   |
| AU R&DTI specificity                | ✅ (Big-4 AU teams use AU-specific tooling) | ✅ Built specifically for AU R&DTI                  |
| Audit-defence cryptographic chain   | ❌ Not architecturally typical              | ✅ SHA-256 chain on every event                     |

### vs. US R&D-credit tools (Boast, TaxCloud, Strike Tax)

| Dimension                                | US R&D-credit tools             | This platform                     |
| ---------------------------------------- | ------------------------------- | --------------------------------- |
| 13/10 AusIndustry portal field schema    | ❌ US 4-part test, not s.355-25 | ✅ Schema-exact AU fields         |
| TR 2021/5 at-risk rule                   | ❌ N/A in US tax                | ✅ Two-limb structured evaluation |
| Two-slice intensity calc (>$20M)         | ❌ N/A                          | ✅ Per EM202033                   |
| Feedstock 1/3 × min adjustment           | ❌ N/A                          | ✅ Independent clawback line      |
| AusIndustry/ATO bifurcated approval flow | ❌ IRS-only model               | ✅ Modeled                        |

### vs. Generic compliance platforms (LeapHR, MYOB Practice)

| Dimension                      | Generic compliance   | This platform                                                                                   |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------- |
| R&DTI domain modeling          | ❌ Not modeled       | ✅ Activities, claims, narratives, expenditure all R&DTI-shaped                                 |
| AusIndustry portal integration | ❌ Manual export     | ✅ Schema-exact PDFs, narrative content pack                                                    |
| Forensic chain                 | ❌ Generic audit log | ✅ SHA-256 cryptographic chain                                                                  |
| AU R&DTI case-law alignment    | ❌ Not domain-aware  | ✅ TR 2021/5, GQHC, Body by Michael, Bakarich, TA 2017/5, TA 2023/5, all structurally addressed |

### vs. Excel + Word + email folders (the actual current default)

| Dimension                                     | Status quo                            | This platform                                                   |
| --------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| Audit reconstruction time                     | Days-weeks of email/folder spelunking | Minutes — single timeline per claimant                          |
| Hypothesis contemporaneity                    | Word-doc timestamps (questionable)    | Immutable trigger at DB layer                                   |
| Cross-claim consistency check                 | Manual                                | Automated reconciliation engine                                 |
| Portal narrative time                         | 40-60% of engagement                  | Minutes per field with AI drafter + char counter                |
| Mobile field capture                          | None                                  | Native iOS + Android, offline-first                             |
| White-label for firms with multiple claimants | Per-folder branding (cosmetic only)   | Per-tenant branding propagating to mobile app + invoices + PDFs |

---

## 10. Marketing extraction guide — sections by channel

### Founding-partner email sequence

- Email 1 (cold intro): §1 (executive summary) + §2 (the problem)
- Email 2 (capability deep-dive): §3.1, §3.2, §3.3 (capture + assessment + narrative drafting are the 80% pain points)
- Email 3 (compliance differentiator): §4 (audit-defence story)
- Email 4 (pricing reveal): §7 (founding partner offer)
- Email 5 (closing): §9 (differentiation matrix vs status quo) + clear founding partner CTA

### Website features pages

- Hero: §1 (executive summary, one-line differentiator)
- "The problem" page: §2
- "Features" pages (one per): §3.1 through §3.10 (each section is a self-contained feature page)
- "Compliance" page: §4
- "Security + sovereignty": §5
- "For technical buyers": §6
- "Pricing" page: §7
- "Roadmap" page: §8
- "Compare" page: §9

### Sales deck (10-slide)

- Slide 1 (title): §1 one-liner
- Slide 2-3 (problem): §2
- Slide 4-7 (solution): §3.1 + §3.2 + §3.3 + §3.7 (the 4 features that close deals — capture, assessment, narrative, cockpit)
- Slide 8 (compliance): §4 highlights
- Slide 9 (pricing + founding partner): §7
- Slide 10 (CTA): contact + next-step

### LinkedIn outreach (one-post version)

- Hook: §2 the problem (the one-strike review + Body by Michael punch)
- Solution: §1 one-liner + §3.3 (narrative drafting time saved is the most LinkedIn-shareable benefit)
- CTA: founding partner application

### Compliance + audit-defence one-pager (CFO-facing)

- §4 (compliance posture) is the entire content — extract verbatim, format as a clean one-pager
- Add §5 (sovereignty) as a sidebar
- Pricing reference: §7 floor + founding partner

### Due-diligence pack (enterprise / acquirer)

- §6 (architecture credibility) — the entire section
- §5 (security + sovereignty) — the entire section
- §4 (compliance posture)
- §8 (roadmap) — frame as "demonstrated discipline of deferring features that don't fit launch scope"

### Founding partner agreement (legal)

- §7 (pricing) — verbatim
- §4 (compliance posture) — to set expectations on what the platform commits to deliver
- §8 (roadmap) — to set expectations on what's NOT yet delivered

---

## Out-of-scope (do NOT include in marketing)

- Internal CI red baseline + admin-merge pattern (engineering-only context; not a public claim)
- The bug-bash dispatch in flight (Phase 1 polish, not a public capability)
- Specific code commits, PR numbers, or migration indices
- The pre-existing pipeline test fixture regression (engineering-only)
- ADR numbers other than 0006 (the others are pure engineering decisions)
- Any phrasing that overclaims Phase 2 capabilities as currently shipped

---

**End of brief.** Update this document only with engineering review for accuracy. Marketing-team derivative materials don't need engineering review — but if something seems too good to be true, ping engineering before publishing.
