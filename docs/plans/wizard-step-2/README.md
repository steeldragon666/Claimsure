# Wizard Step 2 — IP Search + Pass/Fail Report Per Hypothesis

**Design doc:** [../2026-05-25-wizard-step-2-ip-search-design.md](../2026-05-25-wizard-step-2-ip-search-design.md)
**Status:** Decisions locked — ready for dispatch
**Goal:** For each R&D hypothesis in a claim, run prior-art searches across IP Australia + Semantic Scholar + PubMed + arXiv, and produce a consultant-approved pass/fail verdict with PDF report.

## Decisions

- **Data sources:** IP Australia + Semantic Scholar + PubMed + arXiv (no Lens.org).
- **Query construction:** LLM-generated + consultant-editable.
- **Verdict authority:** Analyst-reviewed (LLM drafts, consultant approves/overrides).
- **Throttling:** None at the IP-search layer — rely on existing $50/claim LLM budget.
- **Report format:** Inline in wizard + exportable PDF.
- **Cache:** 30-day TTL by (hypothesis_hash, database, query) with explicit Re-run.

## Task list

| ID | File | Surface | Depends on |
|----|------|---------|------------|
| 01 | [01-migration.md](01-migration.md) | DB schema | — |
| 02 | [02-ip-australia-integration.md](02-ip-australia-integration.md) | packages/integrations | — |
| 03 | [03-semantic-scholar-integration.md](03-semantic-scholar-integration.md) | packages/integrations | — |
| 04 | [04-pubmed-arxiv-integrations.md](04-pubmed-arxiv-integrations.md) | packages/integrations | — |
| 05 | [05-query-and-verdict-agents.md](05-query-and-verdict-agents.md) | packages/agents | 02, 03, 04 |
| 06 | [06-api-and-wizard-ui.md](06-api-and-wizard-ui.md) | apps/api + apps/web | 01, 02, 03, 04, 05 |
| 07 | [07-pdf-report-job.md](07-pdf-report-job.md) | pg-boss job | 01, 06 |

## Cross-task conventions

- All new tables RLS-scoped via `tenant_id = current_setting('app.current_tenant_id', true)::uuid`.
- Each integration package is independent (no cross-package coupling) — `packages/integrations/ip-australia/`, `packages/integrations/semantic-scholar/`, `packages/integrations/pubmed/`, `packages/integrations/arxiv/`.
- All LLM calls billed to `llm_token_usage` with `agent_name = 'ip-search-query' | 'ip-search-verdict'`.
- Match design language tokens. No Tailwind.

## Suggested handoff sequence (~2-3 weeks total)

| Day | Track A | Track B | Track C |
|-----|---------|---------|---------|
| 1 | 01 (migration) | 02 (IP Australia integration) | — |
| 2-3 | 03 (Semantic Scholar) | 04 (PubMed + arXiv) | — |
| 4-5 | 05 (query + verdict agents) | — | — |
| 6-7 | 06 (API + wizard UI) | — | — |
| 8 | 07 (PDF report job) | smoke test | — |

Tracks A/B/C can run in parallel for tasks 02/03/04. After integrations land, tasks 05 → 06 → 07 are sequential.
