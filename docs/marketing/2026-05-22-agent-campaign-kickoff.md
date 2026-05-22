# Claimsure Agent-Based Marketing Campaign Kickoff

**Date:** 2026-05-22
**Goal:** book demos with the first 10 qualified founding-partner R&DTI consulting firms.
**Primary CTA:** apply for a Claimsure trial at `/signup`.
**Use status:** internal campaign operating brief. Public-facing copy must be pulled from the approved outreach section or the website, not from research notes.

## Campaign Thesis

Claimsure should not sell as generic AI software. It should sell as audit-defence infrastructure for Australian R&DTI consultants who feel the pressure of portal narrative work, ATO review risk, and contemporaneous evidence expectations.

The campaign prioritises firms where one partner owns delivery quality, claimant volume is high enough to feel operational pain, and the firm cannot justify building internal Big-4-grade tooling.

## Agent Roles

### 1. Prospect Research Agent

Inputs:
- target geography: Australia
- target segment: boutique to mid-tier R&DTI consultants, R&D tax specialists, grant advisory firms
- exclusion: Big-4 firms, generic bookkeeping practices with no visible R&DTI specialisation

Tasks:
- identify firm name, website, LinkedIn company page, senior partner or director, public R&DTI positioning, likely claimant volume, and contact channel
- score each prospect from 1-5 on founding-partner fit
- tag angle: `audit-defence`, `portal-narrative-time`, `mobile-evidence-capture`, `white-label-platform`, or `pricing-floor`

Output:
- one row per prospect with `firm_name`, `contact_name`, `role`, `email_or_linkedin`, `fit_score`, `angle`, `evidence`, `next_action`

### 2. Message Strategy Agent

Inputs:
- prospect row
- marketing feature brief: `docs/marketing/2026-05-07-features-brief-marketing-input.md`
- public signup URL

Tasks:
- choose one pain-point angle, not a general product pitch
- draft a 5-touch sequence with subject lines
- keep copy direct, founder-led, and specific to Australian R&DTI
- avoid overclaiming Phase 2 capabilities
- use only source-checked compliance references; if a claim depends on a case, Budget measure, or portal change, include the source note for manual review before sending

Sequence:
1. cold intro: audit risk or portal narrative drag
2. capability proof: evidence chain plus schema-exact narrative pack
3. compliance proof: source-checked review risk and contemporaneous evidence framing
4. pricing and scarcity: first 10 firms, 50% year-one discount
5. close: ask for a 25-minute workflow review

### 3. Reply Triage Agent

Tasks:
- classify replies as `book_demo`, `needs_info`, `not_now`, `not_fit`, `unsubscribe`, or `manual_review`
- draft a response under 120 words
- route `book_demo` and `manual_review` to the founder
- never continue outreach after unsubscribe or explicit no

### 4. Founder Slot Ops Agent

Tasks:
- maintain current count of qualified founder slots
- record trial signups and demo status
- flag any firm that needs procurement, security, or data-sovereignty follow-up
- prepare weekly summary: new prospects, touches sent, replies, demos booked, trials created

## Launch List Criteria

Qualified prospects should meet at least three:
- visible Australian R&DTI or grants consulting offer
- boutique to mid-size advisory positioning
- direct partner or director reachable
- content mentions compliance, substantiation, audit, AusIndustry, or ATO
- likely 5-50 active claimants per year
- no obvious in-house proprietary platform

## First Outreach Copy

Subject: R&DTI evidence chain for boutique firms

Hi {{first_name}},

I am building Claimsure for Australian R&DTI consultants who need the evidence trail to be as defensible as the narrative.

The platform captures claimant evidence into a tamper-evident timeline, drafts portal-ready narrative fields from source events, and produces audit-defence packs from the same structured source.

I am opening 10 founding-partner slots for firms that want workflow influence plus 50% off year one.

Worth a 25-minute review of how {{firm_name}} currently handles evidence, narratives, and audit packs?

Aaron

## Metrics

Weekly leading indicators:
- 40 researched prospects
- 20 first-touch messages
- 8 replies
- 4 workflow reviews booked
- 2 trial signups

Conversion indicators:
- founder slot reserved
- trial tenant created
- first claimant added
- first evidence event captured
- first narrative generated

## Guardrails

- Respect unsubscribe or explicit no immediately.
- Do not imply Claimsure replaces consultant judgement.
- Do not market Phase 2 per-tenant conversational agents as shipped.
- Do not claim certification beyond documented ISO 27001 artefacts and GCP infrastructure posture.
- Do not claim SOC 2, IRAP, tax-agent endorsement, ATO endorsement, AusIndustry endorsement, or guaranteed claim eligibility.
- Do not use "no other tool" or "only platform" unless a competitor review has been refreshed and documented.
- Treat Budget and reform claims as date-sensitive. Check current official sources before each campaign wave.
- Avoid percentage-of-refund comparisons unless the buyer raises pricing benchmarks.

## Source Check Notes

Checked on 2026-05-22:
- ATO publishes the GQHC Decision Impact Statement and confirms the Commissioner can assess R&D eligibility where no binding Innovation and Science Australia finding exists.
- business.gov.au and the Department of Industry describe current R&DTI responsibilities split between Industry/IISA for activity registration and the ATO for entity and expenditure rules.
- Public commentary confirms AusIndustry released an updated R&DTI portal application form on 2025-08-15, but outreach should not rely on exact field-count claims unless matched to the current portal schema.
- 2026-27 Budget reform details are active and date-sensitive. Do not use minimum-threshold or reform-effective-date claims without checking the current Budget/Industry pages immediately before sending.
