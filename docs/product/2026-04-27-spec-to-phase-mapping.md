# Omniscient Feature Spec → Implementation Phase Mapping

**Date:** 2026-04-27
**Status:** Authoritative — every future phase plan must reference this map.
**Anchor:** [`./2026-04-27-omniscient-feature-spec.md`](./2026-04-27-omniscient-feature-spec.md)

---

## Purpose

Bridge between the canonical product spec (8 modules + 5 pillars) and the engineering phases (P0 through P9 in [`docs/plans/2026-04-25-rdti-grants-platform-design.md`](../plans/2026-04-25-rdti-grants-platform-design.md)). Every line of code we ship is justified by this map.

## Phase ↔ module table

| Phase                                               | Module(s) being delivered                                                                                                                                                                                                                                                                                         | Pillar emphasis                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **P0** Foundation                                   | Cross-cutting (CI, monorepo, OTel, Postgres + RLS scaffolding)                                                                                                                                                                                                                                                    | Pillar 5 (white-label / multi-tenancy from first commit) |
| **P1** Identity & Tenancy                           | Module 6 (white-label core: tenant + subject_tenant + RLS + OIDC)                                                                                                                                                                                                                                                 | Pillar 5                                                 |
| **P2** Event Capture Vertical Slice (current)       | **Module 1 core** (hash chain + 13 evidence kinds + Division 355 anchors + override) + Module 2 ground floor (classifier agent, citation-grounded via `statutory_anchor`, refuse-to-fabricate via low-confidence escalation)                                                                                      | Pillars 1, 3, 4                                          |
| **P3** Mobile Scribe MVP                            | **Module 3** (daily contemporaneous capture, hypothesis prompts, evidence vault, voice→event with Body by Michael fix)                                                                                                                                                                                            | Pillars 1, 2                                             |
| **P4** First Documents + Activity Register          | **Module 1 advanced**: activity register with CA-##/SA-## hierarchical IDs, technical uncertainty register, project model populated, invoice-to-activity cross-walk; Module 4 pipeline workflow                                                                                                                   | Pillars 1, 3                                             |
| **P5** Document Suite + Assurance Report            | **Module 2 R&DTI half**: Core Activity drafter, Supporting Activity drafter, eligibility risk scorer, source-grounded drafting (refuse-to-fabricate), sector-specific prompting, AusIndustry portal mirror; Module 7 PI insurance subrogation pack                                                                | Pillars 1, 2, 4                                          |
| **P6** Grants Pre-award                             | **Module 8 pre-award half** + **Module 2 grants drafter**: GrantConnect aggregator, eligibility analyser, criterion drafter, budget builder (DIDG framework), 3-reviewer simulator                                                                                                                                | Pillars 1, 3                                             |
| **P7** Grants Post-award                            | **Module 8 post-award**: agreement extractor (Opus), milestone tracking, milestone-aware Scribe (Module 3 extension), acquittal/financial reporting                                                                                                                                                               | Pillars 1, 2                                             |
| **P8** Federation + Financier Tenancy               | **Module 6 advanced**: reseller admin, sub-tenant provisioning, scoped read tokens (delegation_token already in P1 schema); Module 4 Practice OS expansion: consultant productivity dashboard, client portfolio analytics, knowledge base                                                                         | Pillars 5, 1                                             |
| **P9** Production Readiness + Compliance            | **Module 7 full**: AU data residency attestation, SOC 2 Type II prep, ISO 27001 scoping, IRAP roadmap; Module 5 Tier A integrations (Xero, MYOB, AusIndustry portal API, GrantConnect API/email parser); Module 4 QMS module (Code Determination 2024 §30); cost-rollup dashboards; idempotency cache TTL cleanup | Pillars 1, 4                                             |
| **P10+** Tier B/C integrations + per-firm fine-tune | Module 5 Tier B (QuickBooks, Jira/Linear/GitHub/GitLab, Employment Hero/KeyPay/Deputy, DocuSign), Module 6 per-firm AI fine-tune opt-in, Module 5 Tier C (Slack/Teams, Notion, MLflow, state portals)                                                                                                             | Pillar 3 deepening                                       |

## Module-by-module status

### Module 1 — Evidence & Compliance Engine

- **In P2:** SHA-256 hash chain (per-`subject_tenant`), 13 evidence kinds incl. `OVERRIDE`, append-only with override semantics, `statutory_anchor` field on classification, `INELIGIBLE` evidence kind for ordinary-business exclusion (§355-25(2)(a)), confidence threshold gating (default 0.7) for "Needs Review" surface, content-addressed idempotency cache.
- **Pending P4:** Activity register with hierarchical CA-##/SA-## IDs, technical uncertainty register with hypothesis evolution log, source-artefact attachments per event (extend `event.payload.source_artefacts`), invoice-to-activity cross-walk via accounting integration.
- **Pending P5:** Apportionment workbench (mixed-use staff time, TA 2023/4 + TA 2023/5 associate flags — note `ASSOCIATE_FLAG` evidence kind already shipped in P2).
- **Pending P9:** Findings & Internal Review preparation pack.

### Module 2 — AI Co-Author Suite

- **In P2:** Classifier agent (Haiku 4.5) with versioned prompt registry, idempotency cache, citation-grounded `statutory_anchor` references to Division 355, refuse-to-fabricate via the Stub fallback when classifier output < 0.7 confidence (escalates to consultant queue).
- **Pending P5:** Drafter agent (Opus 4.7) for Core Activity / Supporting Activity narratives, eligibility risk scorer, source-grounded drafting that refuses to draft when contemporaneous evidence is absent, sector-specific prompts (software/biotech/agriculture/energy), AusIndustry portal mirror with exact field structure + word limits.
- **Pending P6:** Grants drafter (criterion-by-criterion with rubric alignment).

### Module 3 — Client Mobile App

- **Pending P3 in full.** No P2 work overlaps.

### Module 4 — Practice OS / Workflow

- **Pending P4 (pipeline + workflow), P8 (consultant productivity dashboard), P9 (QMS module).**

### Module 5 — Integrations

- **Pending P9 Tier A, P10+ Tier B/C.**

### Module 6 — White-label & multi-tenancy

- **In P1:** Tenant isolation (RLS), `tenant_user` M:N, `subject_tenant_user` ACL primitive, OIDC (Microsoft Entra + Google Workspace), `delegation_token` schema for P8.
- **In P2:** Continuing — `event.tenant_id` denormalised for index-friendly RLS; `agent_call_cache` deliberately content-addressed (cross-tenant safe).
- **Pending P8:** Reseller admin, sub-tenant management UI, scoped read tokens API.
- **Pending P10+:** Per-firm AI fine-tune opt-in.

### Module 7 — AI Governance / Security / Compliance

- **In P0/P1:** OpenTelemetry instrumentation, AU-region Postgres, RLS enforcement, structured-output via tool_use (no free-form parsing), versioned prompt registry.
- **In P2:** Citation-grounded `statutory_anchor`, confidence indicators on every classifier output, refuse-to-fabricate via stub fallback + low-confidence escalation, idempotency cache (no double-billing), tracing per agent call (cost telemetry).
- **Pending P5:** PI insurance subrogation pack (one-click report — needs activity narratives from Module 2).
- **Pending P9:** SOC 2 Type II audit prep, ISO 27001 scoping, AU data residency attestation, IRAP assessment.

### Module 8 — Grant Writing Module

- **Pending P6 pre-award, P7 post-award.**

## Pillar verification — current (post-P2) state

For each of the 5 pillars, what's ✅ in shipped code, what's pending:

### Pillar 1 — Compliance-grade by default

- ✅ Hash chain per subject_tenant (P2)
- ✅ Append-only event log + override semantics (P2)
- ✅ Division 355 statutory anchors emitted on every classification (P2)
- ✅ DB-level CHECK constraints enforce evidence-kind enums + override invariants (P2 T3)
- ✅ Idempotency cache prevents double-billing on retries (P2)
- ⏳ Activity register CA-##/SA-## IDs (P4)
- ⏳ Apportionment workbench (P5)
- ⏳ Findings/ART preparation pack (P9)
- ⏳ QMS module (P9 — Code Determination 2024 §30)

### Pillar 2 — Augmentation, not replacement

- ✅ Override flow keeps consultant in the loop on every event (P2)
- ✅ "Needs Review" filter routes low-confidence + INELIGIBLE events to consultant queue (P2)
- ✅ Confidence indicator on every event card (P2 portal)
- ⏳ Hypothesis prompts (P3 mobile)
- ⏳ Mandatory human-review gates on drafter output (P5 — TPB(I) D62/2026 alignment)

### Pillar 3 — AU-native

- ✅ Division 355 anchors in classifier prompt (P2)
- ✅ AU-only scope per architecture §0
- ✅ AU-region Postgres (P0)
- ✅ ASSOCIATE_FLAG evidence kind for TA 2023/4 + TA 2023/5 (P2)
- ⏳ Xero / MYOB / AusIndustry portal / GrantConnect integrations (P9 Tier A)
- ⏳ State grant portals (P10+ long tail)

### Pillar 4 — Closed system, citation-grounded

- ✅ No fine-tuning on customer data — every API call is stateless (P2)
- ✅ Versioned prompt registry — prompt changes are deliberate (P2 T11)
- ✅ Tool-use structured output — no free-form parsing (P2 T9)
- ✅ Citation-grounded `statutory_anchor` field on every classification (P2)
- ✅ Refuse-to-fabricate at low confidence (Stub falls through to SUPPORTING + 0.5 confidence with anchor §355-30 — surfaces "no specific match" as evidence gap rather than hallucinating; Haiku prompt explicitly instructs "Be conservative on INELIGIBLE")
- ⏳ Drafter refuses to write sections where contemporaneous evidence is absent (P5)
- ⏳ Edit history with AI vs human authorship + prompt version (P5)
- ⏳ PI insurance subrogation pack (P9)

### Pillar 5 — Multi-tenant white-label from day one

- ✅ Tenant + subject_tenant data model from P1
- ✅ RLS on every tenant-scoped table — `event` joined the family in P2
- ✅ FORCE ROW LEVEL SECURITY on all RLS tables (P1 + P2)
- ✅ Two-role pattern (cpa migration runner + cpa_app application role) — RLS enforced at DB layer regardless of API bug
- ⏳ Per-tenant theming (P4 portal)
- ⏳ Reseller admin (P8)
- ⏳ Discount cap enforcement (P8 / P10+)

## How this doc is used

- Every phase's design doc must include a "Modules covered" section referencing this map.
- Every PR description should include a "Pillar(s)" line explaining which pillar(s) the change advances or maintains.
- Architecture-level deviations from this map require an ADR.
