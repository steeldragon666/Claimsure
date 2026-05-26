# Wizard Step 2 — IP Search + Pass/Fail Report Per Hypothesis (Design Questions)

**Date:** 2026-05-25
**Status:** Decisions made — ready for implementation plan
**Trigger:** "Ip search and pass or fail report per hypothesis"

## DECISIONS (2026-05-25 walkthrough)

| Q | Decision | Why |
|---|---|---|
| Q1 — Data sources | **IP Australia + Semantic Scholar + PubMed + arXiv** (Lens.org skipped) | Australia-focused patent coverage + scholarly literature (biotech via PubMed, software/physics via arXiv). Trade-off: no international patent coverage (USPTO/EPO/WIPO) in v1. Easy to add Lens.org later if a customer hits the case. 4 integrations × ~2 days each = ~1.5 weeks. |
| Q2 — Query construction | **LLM-generated + consultant-editable** | LLM produces 3-5 candidate queries per database using per-database templates (Boolean for patents, natural language for papers, MeSH for PubMed). Consultant ticks which to run and can edit query text. ~$0.05/hypothesis. Best quality + best UX. |
| Q3 — Verdict authority | **Analyst-reviewed: LLM drafts, consultant approves** | `draft_verdict` (LLM) and `verdict` (consultant) are separate columns in `ip_search_verdict`. Consultant clicks Approve or Override+reasoning. Final verdict is always human-signed. Strongest audit defence position. |
| Q4 — Throttling | **No throttling — trust existing $50 LLM budget cap** | Existing `llm_token_usage` ledger is the only safety net. Trade-off: a hypothesis-heavy claim can exhaust the budget before downstream agents (narrative drafting, evidence binding) run. Mitigation: add monitoring check that surfaces "claim X has consumed >80% of budget on IP search". |
| Q5 — Report format | **Inline in wizard + exportable PDF** | Inline = consultant working view; PDF = audit defence document. Same data, different rendering. PDF generated async via pg-boss after consultant approval. ~2 extra hours of work vs. inline-only. |
| Q6 — Cache | **30-day TTL keyed by (hypothesis_hash, database, query) with explicit Re-run override** | Hypothesis text edit auto-invalidates (hash changes). Re-run button forces fresh search bypassing cache. Balances cost vs. coverage of recently-filed prior art. |

## What this feature does (working definition)

For each R&D hypothesis in a claim, the platform runs an Intellectual Property (IP) search to find prior art that might disqualify the hypothesis from R&D Tax Incentive (R&DTI) eligibility. The output is a per-hypothesis **pass/fail report** that the consultant uses to:

1. Decide whether to include the activity in the final claim.
2. Defend the claim if audited by the ATO / AusIndustry.

"Pass" means: the hypothesis represents genuine novelty — we couldn't find existing prior art that already solves the problem, so the work qualifies as a "core R&D activity" under s.355-25 ITAA 1997.

"Fail" means: prior art exists that already addresses this hypothesis — the work is at best a "supporting R&D activity" (s.355-30) or not eligible at all. The consultant may still claim related expenditure but with different framing.

## Why this matters

The R&DTI's "core activity" definition requires *scientific or technological uncertainty that cannot be resolved with existing knowledge in the field*. An IP search is the strongest objective evidence that the knowledge gap was real. The ATO and AusIndustry both expect this kind of evidence in claim defences. Automating it is a significant differentiator vs. competitors who do it by hand.

## What already exists

- **Hypotheses are a first-class concept** in the schema. The `activity` table (and related tables in migrations 0012, 0029, 0037, 0044) has hypothesis text fields.
- The **agent runtime** (`packages/agents/`) already runs LLM-driven tasks per activity (claim-evidence-binding, claim-finalisation, document-extract). IP-search is a new agent type but fits the existing runtime.
- **`llm_token_usage` table** (migration 0082) bills LLM calls per claim — IP searches will plug into the same budget model.

## What does NOT exist yet

- No IP-search agent.
- No connection to any patent database (IP Australia, USPTO, EPO, WIPO, Google Patents).
- No prior-art search results storage schema.
- No pass/fail verdict storage or report generation.

## Open design questions

### Q1 — Data sources

**Patent databases (the obvious ones):**
- **IP Australia** — primary AU patent database. Free public API. Essential.
- **WIPO PATENTSCOPE** — international PCT filings. Free. Important for global novelty.
- **USPTO / Google Patents** — US patents. Free via Google Patents Public Datasets on BigQuery, or USPTO PEDS API. Comprehensive.
- **EPO Espacenet / OPS** — European. Free with API key (rate limits).
- **Lens.org** — aggregator (patents + scholarly). Generous free tier, paid for higher volume. Good developer DX.

**Scholarly literature (often needed for software/biotech hypotheses where novelty is in academic literature, not patents):**
- **Google Scholar** — no official API; scraping is fragile and against ToS.
- **Semantic Scholar** — free API, generous rate limits, excellent metadata. Best option.
- **arXiv** — free API. Strong for software/ML.
- **PubMed** — free API. Strong for biotech.
- **CrossRef** — free, comprehensive but bare-metal.

**Recommendation for v1:** **IP Australia + Lens.org + Semantic Scholar.** IP Australia is non-negotiable (the regulator's own register). Lens.org gives broad patent coverage with one integration. Semantic Scholar gives scholarly coverage. Three integrations is enough for v1; the rest are deferred.

### Q2 — Search query construction

A hypothesis is free-text ("We sought to determine whether a novel cryogenic process could reduce X to Y..."). Patent and scholarly databases need keywords or boolean queries.

**(a) Naive keyword extraction** — strip stopwords, use top-N nouns. Fast, free, poor recall.

**(b) LLM-driven query construction** — pass the hypothesis to Claude/GPT with a prompt: "Generate 3-5 patent-search queries that would find prior art for this hypothesis." Expensive (~$0.05/hypothesis) but vastly better quality.

**(c) Hybrid** — LLM generates queries, but the consultant can edit them before searching. Best UX for sensitive cases.

**Recommendation:** (c). Run the LLM step automatically when the hypothesis is saved, present 3-5 candidate queries in the wizard, let the consultant tick which to run. Default-all-on.

### Q3 — Pass/fail verdict: fully automated or analyst-reviewed?

**(a) Fully automated** — search results count + LLM judgement → pass/fail. Fast, scales, may misclassify.

**(b) Analyst-reviewed** — automated draft verdict, but the consultant must approve before the verdict is final. Highest defensibility.

**(c) Tiered** — auto-pass if zero hits across all databases; auto-fail if highly cited matching patent; manual review for ambiguous (the majority).

**Recommendation:** (b). The platform's product proposition is that the consultant is a trained R&DTI specialist; verdicts must be theirs. The LLM produces a draft + supporting analysis; consultant clicks approve/override. Faster than manual but defensible. (c) might be a v2 optimisation.

### Q4 — Per-hypothesis budget / rate-limiting

LLM-driven query construction + multiple database searches per hypothesis = real cost. A 6-activity claim with 3 hypotheses each = 18 searches × 3 databases = 54 API calls + 18 LLM calls.

Existing infra: `llm_token_usage` ledger (0082) already enforces a per-claim AUD budget (default $50). IP-search costs add to that budget.

**Decision:**
- LLM query construction: bill to `llm_token_usage` like every other LLM call.
- Database searches: most are free. Lens.org has a free tier (~1000 records/month). Beyond that → commercial tier (~$200/mo per consultant firm).
- Throttle: cap at 5 hypotheses per claim in v1, surfacing a "raise the cap" CTA. Avoids the worst case where a 50-hypothesis monster claim consumes the entire monthly Lens.org quota in one click.

### Q5 — Report format

The output is a per-hypothesis report. Two views:

**(a) Inline in the wizard** — expandable card per hypothesis showing verdict, top 3 prior-art hits with summaries, the searches that were run, supporting LLM analysis.

**(b) Exportable PDF** — for inclusion in claim defence packs (auditor reads PDF, not the platform).

**Recommendation:** ship both. Inline is for the consultant's working view; PDF is for the audit defence. The PDF generation can be async (same job-runner pattern as the engagement letter).

### Q6 — Caching strategy

A hypothesis text doesn't change frequently. Re-running the same search wastes money.

**Suggested approach:**
- Cache search results by `(hypothesis_text_hash, database, query)` for 90 days.
- "Re-run" button forces a refresh, ignores cache.
- Cache stored in `ip_search_result` table.

## Out of scope for v1 (defer)

- Non-English language hypotheses (translation layer).
- Trade-secret search (no public API exists anyway).
- Citation graph / forward-citation analysis (advanced patent analytics).
- Watch/alert: "tell me if a new patent is filed that matches this hypothesis" — interesting feature, separate workstream.
- Auto-claim defence narrative generation from the search results (the agent runtime could do this; v2).

## Suggested data model

```sql
-- One row per (hypothesis, database, query) search execution:
CREATE TABLE ip_search_run (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenant(id),
  claim_id            uuid        NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  activity_id         uuid        NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  hypothesis_text     text        NOT NULL,
  hypothesis_hash     text        NOT NULL,  -- sha256(hypothesis_text) for caching
  database_name       text        NOT NULL,  -- 'ip_australia' | 'lens' | 'semantic_scholar'
  query               text        NOT NULL,
  query_source        text        NOT NULL CHECK (query_source IN ('llm', 'analyst_edit')),
  raw_response        jsonb,                  -- full API response for forensics
  result_count        int         NOT NULL DEFAULT 0,
  ran_at              timestamptz NOT NULL DEFAULT now(),
  ran_by_user_id      uuid        REFERENCES "user"(id)
);

CREATE INDEX ip_search_run_cache_idx ON ip_search_run (hypothesis_hash, database_name, query);

-- One row per relevant prior-art hit found (extracted from raw_response):
CREATE TABLE ip_search_hit (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  search_run_id       uuid        NOT NULL REFERENCES ip_search_run(id) ON DELETE CASCADE,
  external_id         text        NOT NULL,    -- patent number / paper DOI / arxiv id
  title               text        NOT NULL,
  abstract            text,
  published_at        date,
  relevance_score     numeric,                  -- LLM-assigned 0..1
  url                 text
);

-- One row per hypothesis-level verdict:
CREATE TABLE ip_search_verdict (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenant(id),
  claim_id            uuid        NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  activity_id         uuid        NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  hypothesis_text     text        NOT NULL,
  verdict             text        NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
  draft_verdict       text                                                       -- the LLM's draft, before consultant override
                                  CHECK (draft_verdict IN ('pass', 'fail', 'inconclusive')),
  analysis_markdown   text        NOT NULL,    -- the LLM's reasoning, citing search hits
  approved_by_user_id uuid        REFERENCES "user"(id),
  approved_at         timestamptz,
  pdf_evidence_id     uuid        REFERENCES evidence(id),
  CONSTRAINT one_verdict_per_hypothesis UNIQUE (activity_id, hypothesis_text)
);
```

All three tables get RLS: `tenant_id = current_setting('app.current_tenant_id', true)::uuid`.

## Suggested next move

Pick answers to the open questions, then this design becomes an implementation spec. Dispatch order:

1. **Migration agent** — three tables + RLS policies.
2. **Integration agents (parallel)** — one per database:
   - `packages/integrations/ip-australia/`
   - `packages/integrations/lens/`
   - `packages/integrations/semantic-scholar/`
3. **Query-construction agent** — LLM step (lives in `packages/agents/ip-search-query/`).
4. **Verdict agent** — LLM step that synthesises results into a draft verdict + analysis_markdown.
5. **API agent** — endpoints: `POST /v1/claims/:id/activities/:aid/ip-search/run` (kicks off a job), `GET /v1/.../verdicts`, `POST /v1/.../verdicts/:id/approve`, `POST /v1/.../verdicts/:id/override`.
6. **Wizard UI agent** — per-hypothesis card with "Run search" button, results inline, approve/override controls.
7. **PDF agent** — async job to render the verdict report.

Order: 1 → 2 (parallel) → 3 + 4 (after the integrations have one example response) → 5 → 6 → 7.

Estimated effort: 2-3 weeks of focused work across all agents. Probably more than the wiring-task batch — this is genuine new product surface.
