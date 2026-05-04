# CPA Platform — Design Brief

**Audience:** Designer (Claude design / human designer / agency)
**Author:** Aaron (founder + lead consultant), with platform context from engineering
**Date:** 2026-05-04
**Status:** Engineering has built the functional surface; visual identity work has not started.

---

## TL;DR

This is a B2B platform for **R&D Tax Incentive (R&DTI) consultants in Australia**. It automates the work of preparing a defensible R&DTI claim — capturing evidence, drafting narrative, applying Division 355 statutory tests — while preserving an audit trail that survives DISR/ATO scrutiny. The engineering team has built ~80% of the workflows. **It currently looks like a developer-built admin console.** It needs a visual identity that communicates regulatory authority, evidentiary rigor, and trust — without being stuffy. Users are sophisticated; pretty for pretty's sake is wasted effort.

The platform is **NOT** a generic SaaS productivity app. Three things make it unusual:

1. **Forensic discipline as a core value.** Every claim-bearing artefact carries a content hash, a `first_recorded_at` timestamp, and (where applicable) a `hypothesis_formed_at` immutability constraint. The visual language should make this discoverable — users should _see_ that the system is treating their data with archival rigor.
2. **AI agents as named workflow participants.** Three agents (A, B, C) appear in the UI as collaborators that draft, classify, and synthesise — not as background ML magic. P7 adds a fourth pattern (suggestion queue + auto-PR generation via GitHub App) and a fifth (regulatory intelligence feed).
3. **Multi-cycle continuity.** A claim isn't a one-shot artefact. It's an evolving multi-year story tied to a `proposed_id` chain. Year-over-year transitions (continuation / pivot / completion / abandoned) are first-class concepts. The UI must communicate "we know what you said in FY24 and we're consistent with it."

---

## The user

### Primary: R&DTI consultants (Aaron's persona)

**Profile:** Big-4 trained, 5–15 years in tax/R&D advisory. Knows Division 355 cold. Fluent in the AusIndustry framework (eligibility limbs, supporting activity tests, expenditure apportionment). Has lived through at least one DISR audit. Reads ATO Tax Alerts before breakfast.

**Mental model:** They think in claim cycles, fiscal years, eligibility tests, evidence chains, statutory anchors. They are NOT looking for "magic" — they want a tool that augments their judgment with structured prompts and forensic metadata.

**Frustrations with current tooling:**

- Word docs as the source of truth (no version control, no audit trail)
- Email/SharePoint for evidence (no search, no provenance)
- Manual reconciliation between Xero ledger and claim narrative
- DISR's "one-strike policy" + 15 Aug 2025 form changes mean any sloppy claim gets bounced; they need to _prove_ rigor, not just claim it.

**Workflow density:** They live in the platform 4–6 hours/day during claim season (Feb–Apr). They tolerate density and information richness — they hate hidden state and wasted clicks.

### Secondary: Claimants (CFOs, founders, R&D leads)

**Profile:** They're paying the consultant to do the work. Their interaction with the platform is the **claimant portal** — a focused, mobile-friendly surface where they confirm activities, upload evidence, and approve narrative drafts.

**Mental model:** They want to know "is my claim on track" and "what do you need from me." They don't read Tax Alerts; they read calendar reminders.

**Workflow density:** Light. 30 min/week during claim season. Mobile-first.

### Tertiary: Admin staff

**Profile:** Practice managers, paralegals. Run the firm-side configuration — branding, user management, billing.

**Workflow density:** Moderate, but mostly setup-and-forget.

---

## What's been built

15 pages across four surfaces:

| Surface                | Pages                                                                                     | State                            |
| ---------------------- | ----------------------------------------------------------------------------------------- | -------------------------------- |
| **Consultant cockpit** | `/projects`, `/pipeline`, `/claims/[id]`, activity detail, register, multi-cycle timeline | Functional, dense, ad-hoc layout |
| **Admin**              | `/admin/apportionment`, `/admin/brand-config`, `/subject-tenants`                         | Functional, very utilitarian     |
| **Claimant portal**    | `/claimant/[id]/m`, `/score`, `/status`, `/expired`                                       | Functional, mobile-first, simple |
| **Auth**               | `/login`                                                                                  | Default shadcn login form        |

**Stack constraints (cannot be changed):**

- Next.js 15 App Router, React 19, TypeScript strict mode
- Tailwind CSS + shadcn/ui component library (Radix UI primitives)
- TanStack Query for data fetching
- The shadcn primitives are the **a11y backbone** — designers can re-skin them but should not replace them

**Stack non-constraints (designer can change):**

- Color palette (current is shadcn defaults — black/white with HSL tokens)
- Typography choice (currently Tailwind defaults)
- Iconography (currently Lucide via shadcn)
- Spacing rhythm (Tailwind's default scale is in use; could be tightened)
- Information architecture _within_ a route (page composition, hierarchy, grouping — fine to redesign)
- Information architecture _across_ routes (URL structure is in flight; talk to engineering before changing)

---

## Brand position

**Where to land:**

- Authoritative, not playful
- Forensic, not sterile
- Modern, not corporate-90s
- Dense, not cramped
- Inspirational anchors: **Linear** (rigor + density), **Clay** (data-forward), **Stripe Atlas** (regulatory tool with personality), maybe a hint of **Notion's** structural calm

**Where NOT to land:**

- Anything that looks like Quickbooks, MYOB, Xero (consumer-accounting aesthetic)
- Anything Big-4 corporate (PwC blue, KPMG navy — overused, looks dated)
- Tech-bro gradient maximalism
- Any "AI = sparkles + purple gradient" cliché. The agents are real workers, not magical assistants.

**Tone signals to encode visually:**

- "We track every change. Forever." — visible content_hash badges, version timestamps, edit-count chips
- "We know the regulator cares about _when_ you formed your hypothesis." — prominent immutable date fields with rationale
- "This is your work; the AI is augmenting it." — agent contributions clearly labelled, not blended invisibly
- "Your claim spans years." — multi-cycle timeline as a first-class navigation surface, not an afterthought

---

## What we need from you

### Phase 1 — Brand foundation (Week 1)

- Logo (workmark + mark; should work at 16px favicon and 200px header)
- Primary palette: 1 brand color + neutrals + 4 semantic colors (success / warning / error / info)
- Typography: 1 display face + 1 body face (or one variable face used at two ranges); both must have monospace tabular figures for the financial tables
- Iconography direction: stay with Lucide or commit to a custom set (the platform has ~40 icon usage sites today)
- Voice/tone document (1 page): how the platform talks about itself, the agents, the user's work

### Phase 2 — Design system spec (Week 2)

- Token system that maps to Tailwind CSS variables (the codebase already uses HSL tokens via shadcn — extend, don't replace)
- Component variants for the 11 shadcn primitives we use (button states, card densities, form input flavors, table densities)
- Spacing rhythm + density modes (consultant: dense; claimant: comfortable)
- Multi-cycle timeline — this is a brand-defining component; design it carefully
- Forensic-metadata chip — content_hash badge, first_recorded_at hover-card, edit-count indicator (these appear everywhere)
- Agent-attribution chip — when an artefact was drafted by Agent C, the user should see it without being distracted

### Phase 3 — Key screen redesigns (Week 3)

Pick 5 screens to fully design (Figma frames + token-mapped specs). Suggested:

1. `/claims/[id]` — claim overview (the consultant's "home base" during a claim cycle)
2. `/claims/[id]/activities/[id]` — activity detail with multi-cycle timeline embedded
3. `/pipeline` — cross-claim queue (consultant's daily triage view)
4. `/claimant/[id]/m` — claimant mobile capture surface
5. `/admin/apportionment` — config-heavy admin surface (test the design system on a dense form)

For each: annotated frame, component callouts mapping to existing shadcn primitives, responsive variants, empty/loading/error states.

### Phase 4 (optional) — Roll-out plan

- Inventory of remaining 10 pages with rough redesign effort estimates
- Migration order (which pages get the new design first; which can wait)
- Engineering handoff format (Figma + token JSON + Tailwind config patch)

---

## Constraints

- **Timeline:** 30 April 2026 is the FY25 R&DTI deadline. Anything user-facing that ships before then needs to be on-brand. Anything after can roll out gradually.
- **Budget:** [you fill this in — designer asks]
- **No marketing site in scope.** This brief is the platform itself. Marketing site is a separate property.
- **No mobile app in scope.** The claimant portal IS the mobile experience (Next.js responsive).
- **Print/PDF outputs are in scope but later.** Claim deliverables eventually become PDFs that go to AusIndustry. Brand them but defer to Phase 5.
- **Existing pages stay functional during redesign.** Designer hands tokens + Figma; engineering applies them route by route. No big-bang re-skin.

---

## What's explicitly out of scope

- Re-architecting routing (URL structure is in flight; talk to engineering)
- Replacing shadcn/Radix primitives (they're the a11y backbone)
- Marketing copy (separate workstream)
- Onboarding flow design (no users yet — defer until pre-launch)
- Email template design (transactional emails will land in P8)
- PDF/print output design (P8+)

---

## Decision rights

- **Brand direction (palette, typography, voice):** Aaron approves. One round of revisions standard.
- **Component variant design:** Designer proposes; engineering reviews for technical feasibility; Aaron approves.
- **Information architecture (within page):** Designer + engineering negotiate; Aaron breaks ties.
- **Information architecture (across routes):** Engineering owns; designer flags concerns.
- **Token system structure:** Engineering owns the schema; designer fills the values.

---

## Stakeholder + regulatory context (read before designing)

This isn't a generic SaaS. The platform exists because:

- The 15 August 2025 R&DTI form changed materially — added beneficial-ownership disclosures, plant/facilities, knowledge-search records, Year+2/+3 forecasts, and char-count enforcement
- The Body by Michael ART decision (2024) established that hypothesis dates must be **contemporaneously authored** — not retro-fitted at claim time. Hence the immutable `hypothesis_formed_at` field and the audit-log trigger on UPDATE attempts.
- DISR runs **pattern-matching across an applicant's entity group** for similar activity descriptions — Aaron's 4 entities (Carbon Project Australia, Power Plant Energy, Carbon Robotics, Omniscient AI) are a real exposure surface.
- RSM's December 2025 advisory pushed forensic metadata on photos/videos as a defense against "hypothesis was formed in a later year" rejections.

**Why this matters for design:**

- The platform's job is to make rigor _visible_ without making rigor _intimidating_. A "Body by Michael compliant" workflow shouldn't feel like filling out a tax form; it should feel like working with a really thorough colleague.
- "Audit trail" is not a settings page; it's a first-class surface. Design it that way.
- The agents are not chatbots. They're collaborators with version pins and prompt versions. Surface that.

---

## What you'll get from engineering

- Repo access (read-only; designs land via PR review)
- Live staging URL with seeded fixture data (consultant + claimant accounts)
- 30-min walkthrough call covering: what each page does, why it's there, what's planned next
- Slack/email channel for back-and-forth
- This document, kept current

## What we ask from you

- A brief (1-page) brand-direction proposal in Week 1, before going deep
- Working in Figma (or your tool of choice — output as Figma frames + JSON tokens)
- Annotated handoff specs (engineers should not have to ask "what spacing did you mean here")
- Be opinionated. The current state is engineering-defaults; we want a designer to make decisions, not present options for us to pick.

---

## Open questions you might raise

- "What's the company's domain / brand name?" — currently the project is called "cpa-platform" internally. The product name for marketing is undecided. **You can propose one.**
- "Is dark mode in scope?" — the codebase has `.dark` tokens defined but no dark mode in the UI today. **Defer to Phase 5.**
- "What about WCAG AA?" — yes, mandatory. The shadcn/Radix primitives give a baseline; your color choices need to clear 4.5:1 on body text and 3:1 on UI components.
- "What about internationalization?" — Australia only for now (en-AU + AUD). Don't design for multi-locale.
- "What about white-labeling?" — Aaron's firm runs the platform; future white-label tenants are a P9+ consideration. Design for one brand for now.

---

## Appendix: relevant docs

- `docs/plans/2026-04-25-rdti-grants-platform-design.md` — original platform design
- `docs/plans/2026-05-03-p7-design.md` — current phase (P7) design + risk register
- `docs/decisions/0005-white-label-and-hostname-routing.md` — multi-tenancy story
- `docs/runbooks/` — operational details (not design-relevant, but shows engineering rigor)

---

**Bottom line for the designer:** This is a serious tool for serious users. The aesthetic should feel like Linear and Clay had a baby that knew Australian tax law. Don't be scared of density. Don't ship anything that has a sparkle gradient. Make rigor visible.
