# R&DTI Skill Parity Plan v3.1 — Strategic Examination of R&D (SERD) Addendum

**Companion to:** v1 plan + v2 + v3 + audit
**Source:** "Ambitious Australia: Strategic Examination of Research and Development Final Report" (Robyn Denholm, panel chair)
- Delivered to government: December 2025
- Public release: 17 March 2026
- 20 recommendations + 35 sub-recommendations
**Date added:** 2026-05-05

## TL;DR

**Zero v3 plan revisions needed.** All 20 SERD recommendations are aspirational. None legislated as at 5 May 2026. The 2026-27 Federal Budget (12 May 2026) did NOT include R&DTI reform among announced measures.

The platform's v1/v2/v3 plan tasks are correctly based on currently enacted law. SERD proposes reforms that work around the existing s.355-25 / s.355-405 / s.355-465 framework rather than replacing it.

## Top 5 SERD reforms relevant to the platform (FOR MONITORING ONLY)

| # | Reform | Status | Platform impact IF legislated |
|---|--------|--------|-------------------------------|
| 1 | Deemed rate for supporting activities (Rec. 5a) | Aspirational | `SupportingPortalFieldsSchema` becomes optional path; need comparison calc (current cost vs deemed rate) |
| 2 | Minimum expenditure threshold $20K → $150K (Rec. 5a, 5c) | Aspirational | Add floor check in claim validation. 23.9% of current claimants would be ineligible |
| 3 | Refundable offset turnover threshold $20M → $50M (Rec. 5c) | Aspirational | Update `LARGE_ENTITY_THRESHOLD_AUD` constant in clawback-calculator. Plus new growth-conditioned off-ramp (5% above CPI) |
| 4 | Startup premium stream (Rec. 5b) | Aspirational | Entirely new code path: 100-point eligibility test, quarterly cash advances, expanded eligible expenditure for software/digital |
| 5 | Removal of $150M cap + intensity measure (Rec. 5d) | Aspirational | Two-slice intensity calc (v3 B.3 refinement) becomes obsolete IF intensity measure abolished — but only for large entities |

## Single new monitoring task

### Task RIF-1 — SERD Regulatory Monitoring Seed (low priority, no sprint assignment)

**Type:** ops-config (data seeding)
**Severity:** Low (monitoring, not implementation)

**Files:**
- New seed entries via SQL or admin API to existing `regulatory_source` + `regulatory_event` tables (migration 0040)

**Implementation:**

```sql
-- Seed SERD/Ambitious Australia as tracked source
INSERT INTO regulatory_source (id, name, kind, url, parser_kind, is_active)
VALUES (
  gen_random_uuid(),
  'Strategic Examination of R&D (SERD)',
  'government_review',
  'https://www.industry.gov.au/publications/ambitious-australia-strategic-examination-research-and-development-final-report',
  'manual',
  true
);

-- Seed initial events
INSERT INTO regulatory_event (regulatory_source_id, kind, severity, title, summary, url, published_at)
VALUES
  -- SERD final report
  (<source_id>, 'government_review', 'medium',
   'Ambitious Australia: SERD Final Report Released',
   '20 recommendations + 35 sub-recommendations. All aspirational; none yet legislated.',
   'https://www.industry.gov.au/publications/ambitious-australia-strategic-examination-research-and-development-final-report',
   '2026-03-17'),
  -- Pre-budget signal
  (<source_id>, 'budget_check', 'low',
   '2026-27 Federal Budget — no R&DTI reform announced',
   'May 12 budget did not include SERD recommendations as legislated measures.',
   'https://en.wikipedia.org/wiki/2026_Australian_federal_budget',
   '2026-05-12');
```

When future SERD-related events surface (consultation papers, draft bills, exposure drafts, enacted legislation), the regulatory-classify agent (already shipped) will categorize them. If `severity >= high` AND `kind = 'legislation_enacted'`, trigger compliance review of:
- `calculateOffsetRate` (intensity-tier code)
- `SupportingPortalFieldsSchema` (deemed-rate interaction)
- Claim minimum-expenditure validation
- Startup-stream eligibility logic (if introduced)

**Effort:** ~30 minutes (data seeding only).

## Architecture note (proactive defense)

Per multiple analysts (BDO, RSF), software firms where supporting-activity expenditure equals or exceeds core R&D would be DISADVANTAGED by the deemed-rate proposal. This is a real business risk for platform users.

**Recommendation (no immediate code change):** when the deemed rate mechanism is eventually detailed (consultation paper expected before legislation), the platform should run a comparison: "under current rules your supporting benefit = $X; under deemed rate = $Y; difference = $Z." This requires that supporting activity expenditure CONTINUE to be tracked at its actual cost even if the deemed rate is elected.

**Do not remove** the detailed supporting-activity costing fields in `SupportingPortalFieldsSchema` in anticipation of the deemed rate. Keep both code paths available.

## Coverage outcome — unchanged

- v1: ~85% rdti-workflow skill parity
- v1 + v2: ~98%
- v1 + v2 + v3: ~99%
- **v1 + v2 + v3 + v3.1: ~99%** (no coverage change; v3.1 adds monitoring infrastructure only)

The remaining ~1% is conscious deferrals: email parser (P9), ASX feed (P9), specialised code-file parsers, EM20238 (unresolved), EV/1052237848852 (unresolved), and any rules introduced after May 2026.

## Sources

- [Ambitious Australia Final Report PDF](https://www.industry.gov.au/sites/default/files/2026-03/ambitious-australia-strategic-examination-of-research-and-development-final-report.pdf)
- [Ambitious Australia Summary Report PDF](https://www.industry.gov.au/sites/default/files/2026-03/ambitious-australia-strategic-examination-of-research-and-development-summary-report.pdf)
- [Minister's Media Release (17 March 2026)](https://www.minister.industry.gov.au/ministers/timayres/media-releases/ambitious-australia-release-strategic-examination-research-and-development-report)
- RSM, Intellect Labs, Pattens, RSF, EY, BDO, Swanson Reed, ACS, Startup Daily commentary
- [2026 Australian federal budget — Wikipedia](https://en.wikipedia.org/wiki/2026_Australian_federal_budget)
