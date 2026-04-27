# Omniscient AI for R&DTI & Grants — Feature Architecture

**Date:** 2026-04-27
**Status:** Canonical product spec — supersedes prior feature lists in `docs/plans/2026-04-25-rdti-grants-platform-design.md` where they conflict.
**Source:** Top-tier product specification, derived from Australian market research and proven Carbon Project tooling. Written by Aaron Newson + AI pair.
**Anchor:** TPB 2026 enforcement priorities, Code Determination 2024 (Sections 15, 30, 45), Shortfall Interest Charge (1 April 2025), ART tribunal regime, Division 355 ITAA 1997, AusIndustry June 2024 Guide to Interpretation.

---

## Strategic frame: five pillars every feature must satisfy

Before module-level design, every feature is tested against five filters that come directly from the market research:

1. **Compliance-grade by default.** TPB's 2026 enforcement priorities, the Code Determination 2024 (Section 15 false/misleading statement duty, Section 45 client-information obligation, mandatory QMS), the Shortfall Interest Charge from 1 April 2025, and the ART tribunal regime have made audit-defensibility the buyer's #1 anxiety. Every feature must produce or reinforce an evidentiary trail.
2. **Augmentation, not replacement.** The buyer is the consultant whose hours the tool replaces. Messaging and UX must scale their expertise — never "skip the consultant" in firm-facing copy.
3. **AU-native.** GrantConnect API, AusIndustry portal alignment, Division 355 ITAA 1997 statutory language, ATO/AusIndustry guidance versioning, AU data residency, AU payroll/accounting integrations. International tools cannot replicate this without a substantial rebuild — that's the moat.
4. **Closed system, citation-grounded.** No training on customer data, every AI output linked to source artefacts, refusal-to-fabricate where evidence is missing. Aligns with TPB(I) D62/2026 exposure draft and Voluntary AI Safety Standard guardrails.
5. **Multi-tenant white-label from day one.** The channel strategy depends on Tier 2 mid-tier accounting firms reselling under their brand. Cannot be retrofitted later.

---

## Module 1 — The Evidence & Compliance Engine (the moat)

This is the single most important module and the product's structural defence against Synnch, against Big 4 internal accelerators, and against international entrants. It is the "audit-ready from the start" promise made operational.

**Core capabilities:**

- **Activity register with hierarchical IDs.** Auto-generated CA-## (Core) and SA-## (Supporting) IDs, with hypothesis, technical uncertainty statement, systematic experimentation log, expected/actual outcome fields. Locked to Section 355-25 / 355-30 statutory wording.
- **Technical uncertainty register.** Per-activity uncertainty entries with date created, hypothesis evolution log, references to prior art / competent professional knowledge state, experimental method, results, conclusion. Immutable revision history (append-only) so AusIndustry can trace knowledge state at the date of experimentation.
- **Contemporaneous evidence chain.** Every activity links to source artefacts: meeting notes, design docs, code commits, lab notebook entries, invoices, timesheets. Each artefact stamped with cryptographic content hash + ingestion timestamp + source-system metadata. SHA-256 evidence chain.
- **Invoice-to-activity cross-walk.** Every R&D dollar links to a specific activity ID, with evidence link and outcome statement. Generates the one-page ATO cross-walk artefact — auto-populated from accounting integration.
- **Apportionment workbench.** Mixed-use staff time, associated-entity transactions (TA 2023/4, TA 2023/5 alerts), aggregated turnover grouping rules, dominant-purpose tests for supporting activities. AI suggests apportionment with confidence indicator; human consultant confirms or overrides; both states logged.
- **Findings & Internal Review preparation pack.** One-click bundle for a Finding application, Internal Review submission, ART appeal materials. Includes activity narratives, evidence index, expenditure schedule, and timeline reconstruction.

**Why this is defensible:** Synnch documents activities but does not produce litigation-ready bundles or apportionment reasoning. The Big 4 do this manually with senior consultants. International tools have no concept of the AusIndustry/ATO Findings/ART regime.

---

## Module 2 — AI Co-Author Suite

Where 85–90% time savings actually land, and the surface where Aaron's existing prompt/agent stack converts directly into product.

**For R&DTI narratives:**

- **Core Activity narrative drafter.** Trained on historic AusIndustry decisions, the Body by Michael, Ultimate Vision Inventions, GQHC, and Active Sports Management tribunal precedents, AusIndustry sector guides (software, biotech, energy, agriculture, manufacturing, food, construction), and the June 2024 Guide to Interpretation. Drafts portal-ready wording for systematic experimentation, hypothesis, technical uncertainty, new knowledge.
- **Supporting Activity drafter.** With dominant-purpose test logic. AI flags activities that read as "ordinary business" and suggests reframing to demonstrate direct relation to a core activity.
- **Eligibility risk scorer.** Per-activity score against sector guides; surfaces specific risk language. Confidence indicator visible to consultant.
- **Source-grounded drafting.** Every paragraph in a generated narrative links back to specific source artefacts (meeting note dated X, code commit dated Y, lab entry dated Z). Refuses to draft sections where contemporaneous evidence does not exist — surfaces evidence gaps proactively.
- **Sector-specific prompting.** Software claims trigger software-specific framing; biotech triggers regulatory pathway language; agriculture triggers field-trial methodology. Output never sounds like generic ChatGPT.
- **AusIndustry portal mirror.** Drafts in the exact field structure and word limits of the AusIndustry portal, including character counts, mandatory subheadings, and the new Finding application format from July 2024.

**For grants:**

- **Eligibility analyser.** Upload a Grant Opportunity Guidelines PDF; AI extracts criteria, scoring rubric, weightings, and gap analysis against firm's client profile.
- **Selection criterion drafter.** Per-criterion drafting with explicit scoring-rubric alignment, evidence/case-study insertion from a firm knowledge base, word-count enforcement.
- **Budget builder.** Co-contribution calculator with valuation methodology (project-period chargeout, fully-loaded labour rates, cost-based IP — DIDG framework). Generates Commonwealth-audit-defensible co-contribution tables.
- **Risk & milestone planner.** Auto-generates GANTT, milestone schedule, risk register with mitigations.
- **Reviewer simulator.** Three-reviewer scoring panel (productisation of the AU-grant-workflow skill) with weakness flags before submission.

The differentiation against Drafter (Funding Centre's AU-native AI grant tool): consultant/agency multi-client orientation, R&DTI integration in the same product, deeper writing surface, white-label-able, integrated with practice management.

---

## Module 3 — Client Mobile App (the per-client revenue stream)

Second monetisation layer beyond firm subscription. Firm pays the annual tier; each client gets a branded mobile/web companion app at A$300–600 per active client, billable at the firm's discretion.

**Capabilities:**

- **Daily contemporaneous capture.** Push notification at end of day: "30 seconds — what R&D did you work on today?" Voice note → AI transcript → activity register entry, linked to staff timesheet.
- **Evidence vault.** Photo/video/document upload tagged to project and activity. Auto-OCR'd, content-hashed, timestamped.
- **Hypothesis prompts.** Before starting a new experiment: "What outcome do you predict? What does success look like? What are you uncertain about?" Captures pre-experiment state — solves the Body by Michael hypothesis-pre-dating problem.
- **Time tracking.** Lightweight project/activity time capture with R&D-vs-non-R&D toggle.
- **Document signing & RFI workflow.** Client signs engagement, responds to consultant RFIs, uploads bank statements/invoices/payroll.
- **Status dashboard.** Where is my claim? What's outstanding? When is the refund expected?
- **Audit-readiness score.** Visible to client; updates as evidence accumulates. Gamified — clients see their score climb.
- **White-labelled.** Firm's brand, firm's colours, firm's domain. Client thinks they're using their consulting firm's app.

**Pricing logic:** A consulting firm with 40 clients at A$500 per client = A$20K of additional ARR on top of the firm tier. Pass-through with markup (A$1,000–1,500/client) into engagement fee — margin-positive for the firm. For a mid-tier firm doing 40 claims with A$25K average fee, the mobile app fee is 1.5–2.5% of revenue.

---

## Module 4 — Practice OS / Workflow

Firm-level operations layer. Competes with Karbon (accounting practice management) and ChangeGPS (AU accounting).

- **Pipeline & workflow.** Client list, stage of claim (engagement → activity capture → narrative drafting → expenditure schedule → review → AusIndustry submission → audit defence). Bulk operations across portfolio.
- **Consultant productivity dashboard.** Hours per claim, claims per consultant per quarter, narrative quality scores, audit pass rate.
- **Client portfolio analytics.** Total R&D spend under management, total benefit secured, average claim size, sector mix.
- **Quality management system module.** Required by Code Determination 2024 Section 30. Templated QMS with documented review steps, sign-off matrix, exception register, periodic supervisor sampling.
- **Knowledge base.** Firm's own narratives, evidence templates, technical case studies — searchable by sector, technology, AusIndustry decision.
- **Team management.** Roles (partner, senior, consultant, admin), claim assignment, workload balancing, capacity planning.

---

## Module 5 — Integrations

**Tier A — must-have on day one:**

- Xero (Synnch is the only Xero-certified R&DTI app globally; you must match).
- MYOB (Synnch gap — closes a chunk of the AU SME market that Synnch can't serve).
- AusIndustry portal API (where it exists; otherwise structured export matching portal field names).
- GrantConnect (no commercial tool currently has API access; bridge with structured scraper + email parser).

**Tier B — strong differentiators:**

- QuickBooks Online (smaller AU footprint but real).
- Jira, Linear, GitHub, GitLab, Asana, ClickUp (software-claim evidentiary capture).
- Employment Hero, KeyPay, Deputy (payroll for time apportionment).
- DocuSign / Adobe Sign (engagement letters, client representation letters).
- Microsoft 365 / Google Workspace (calendar events as evidence, email thread ingestion).

**Tier C — strategic moats:**

- Slack, Teams, Discord (technical discussion → contemporaneous evidence).
- Notion, Confluence, OneNote, Obsidian (lab notebooks, design docs).
- Figma, Miro (design experimentation evidence).
- MLflow, Weights & Biases (ML experiment tracking).

State grant portals as a long tail — Victoria, NSW, Queensland, WA, SA each run separate systems.

---

## Module 6 — White-label & multi-tenancy

Must be architected from the first commit. Retrofitting is fatal.

- **Brand control.** Logo, primary/secondary colours, domain (firm.omniscient.app or fully custom), email sender domain, login screen, terms of service, privacy policy. Mobile app fully rebrand-able.
- **Tenant isolation.** Per-firm data segregation, separate AI knowledge bases, no cross-tenant prompt leakage.
- **Per-firm AI training opt-in.** Firms can optionally train a fine-tuned narrative style on their historic claims — locked to their tenant only.
- **Reseller admin.** Mid-tier accounting firm reselling to its own client portfolio gets a sub-tenant management UI.
- **Margin protection.** Built-in 15–20% maximum resale discount enforcement.
- **Audit log per tenant.** Every action logged for the firm's own QMS evidence and for any future AusIndustry adviser-level inquiry.

---

## Module 7 — AI Governance, Security, Compliance

What gets you over the line with risk-averse Big 4 partners and TPB-watchful Tier 2 firms.

- **Australian data residency.** All data in AU regions. Documented, attestable, contractually committed.
- **Closed-system architecture.** No training on customer data, period. Frontier models accessed via private endpoints (DGX Spark cluster makes a sovereign-inference offering credible).
- **Citation-grounded outputs.** Every AI-generated paragraph linked to source artefacts. Refusal to fabricate where evidence is missing.
- **Confidence indicators.** Every AI output marked with source-strength + reasoning-strength score. Below threshold → mandatory human review gate.
- **Mandatory human-review gates.** Configurable by tenant; enforces TPB(I) D62/2026 alignment.
- **Edit history & provenance.** Every change to a narrative tracked: who/what/when/why, AI vs human authorship, prompt used, model version.
- **PI insurance subrogation pack.** One-click report producing audit log, prompt history, human-review approvals, and source-evidence chain.
- **Privacy Act 1988 compliance.** APP 6, 8, 11 mapping documented. DPA template for firms.
- **SOC 2 Type II + ISO 27001 roadmap (target Year 2).** IRAP assessment as Year 3 stretch goal.

---

## Module 8 — Grant Writing Module

Bundled with R&DTI in Tier 2/3, available standalone for grant-only consultancies.

- **GrantConnect intelligence feed.** All open opportunities, alerts, gap analysis, funding-round prediction.
- **State + corporate Commonwealth grant aggregation.** Beyond GrantConnect — Victorian Treasury, NSW Treasury, Sustainability Victoria, ARENA, CEFC, NAIF, Innovate Australia, Defence Innovation Hub, ASCA/EDT.
- **Strategic-fit scorer.** Match a client's profile against open opportunities; surface the top 3 with scoring rationale.
- **Application drafter.** Per-criterion writing with rubric alignment.
- **Budget & co-contribution workbench.** Cash vs in-kind vs IP, valuation methodology, Commonwealth-audit-defensibility (DIDG framework).
- **3-reviewer scoring panel.** Pre-submission weakness flagging (productised AU-grant-workflow skill).
- **Acquittal & milestone tracking.** Post-award reporting, milestone evidence capture, financial acquittal preparation.
- **Win/loss analytics.** Per-program success rate by sector, by writer, by score component.

---

## Tier mapping

| Capability                     | Tier 1 (10–20 claims, A$24K) | Tier 2 (20–60 claims, A$48K) | Tier 3 (60+ claims, A$120K)   |
| ------------------------------ | ---------------------------- | ---------------------------- | ----------------------------- |
| Evidence & Compliance Engine   | ✓ Full                       | ✓ Full                       | ✓ Full + custom QMS templates |
| AI Co-Author — R&DTI           | ✓                            | ✓                            | ✓ + per-firm fine-tune        |
| AI Co-Author — Grants          | Add-on (+A$8K)               | ✓                            | ✓                             |
| Client Mobile App              | A$500/client                 | A$400/client                 | A$300/client                  |
| Practice OS / Workflow         | Core                         | Full                         | Full + multi-office           |
| Integrations Tier A            | ✓                            | ✓                            | ✓                             |
| Integrations Tier B            | 3 included                   | All                          | All                           |
| Integrations Tier C            | —                            | 5 included                   | All + custom                  |
| White-label                    | Co-branded only              | Full white-label             | Full + reseller admin         |
| Australian data residency      | ✓                            | ✓                            | ✓ + dedicated tenant          |
| PI insurance subrogation pack  | —                            | ✓                            | ✓                             |
| SOC 2 / ISO 27001 attestations | Shared                       | Shared                       | Dedicated                     |
| User seats                     | 5                            | 15                           | 50                            |
| Support                        | Email, 48hr                  | Email + Slack, 8hr           | Dedicated CSM                 |

Per-claim overage above 20/60/100 respectively at A$1,000/A$800/A$500 per claim — natural expansion revenue.

---

## What makes this top-tier (and not just feature-complete)

Three architectural choices separate this from a standard SaaS build and from every competitor:

1. **The evidence chain is the product, not the chrome.** Synnch markets "documentation"; this product markets "audit-defensibility." Every feature — capture, drafting, review, submission, post-claim — feeds into a single immutable evidence graph that is the artefact a TPB or AusIndustry investigator actually needs. That is structurally what the Bogiatto, Body by Michael, Ultimate Vision Inventions, and recent PwC partner deregistration cases were all decided on.

2. **The AI never lies.** Citation-grounded outputs with refuse-to-fabricate behaviour are technically harder than open-ended drafting and produce shorter, more conservative narratives — but they are the only architecture that survives the TPB(I) D62/2026 environment and the only architecture that protects a firm's PI insurance position.

3. **The mobile app converts the consultant's biggest pain — chasing clients for contemporaneous evidence — into the firm's biggest expansion revenue line.** No other product in the AU R&DTI/grants market has a credible per-client mobile companion.

---

## What to NOT build (resist scope creep)

- A claimant marketplace / leads engine. Drives channel conflict with firm subscribers; kills the white-label thesis.
- Replacement messaging for consultants. Every word of marketing copy goes through the augmentation filter.
- Generic "AI assistant" chat surface. Anchors the product in commodity AI; the moat is structured workflows, not an LLM wrapper.
- International expansion before A$3M ARR. AU-native depth is the moat. NZ is the only natural Year 3 adjacency.
- Free tier. Anchors price perception in the wrong band; Tier 1 paid only.

---

## Honest weaknesses to plan around

- The evidentiary architecture creates real engineering debt — append-only event logs, content-hashing, source-graph integrity, and tenant isolation are non-trivial to build and will slow Year 1 velocity. Budget accordingly: a thinner feature set delivered with bulletproof evidence behaviour beats a broader feature set with a leaky audit trail.
- The closed-system AI commitment costs raw model performance — a citation-grounded refuse-to-fabricate model produces shorter, sometimes blander narratives than a freewheeling one. Product copy must be honest about this trade-off and frame conservatism as the feature, not the limitation.
- The white-label motion will inevitably produce partners who try to discount aggressively. The 15–20% resale discount cap must be contractually AND technically enforced (system-level discount limits), not just policy — and the partner agreement needs a kill-switch for breach.
