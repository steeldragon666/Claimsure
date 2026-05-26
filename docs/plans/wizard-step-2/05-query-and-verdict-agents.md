# 05 — Query-Construction + Verdict-Synthesis Agents

**Depends on:** 02, 03, 04 (so the agents know what each integration's result shape looks like)

## Goal

Two LLM-driven agents that live in `packages/agents/`:
1. **ip-search-query** — given a hypothesis, generate 3-5 candidate queries per database with database-aware syntax.
2. **ip-search-verdict** — given a hypothesis + all search hits, draft a verdict (pass/fail/inconclusive) + `analysis_markdown` citing the hits.

Both bill LLM usage to `llm_token_usage` ledger.

## Files to add

- `packages/agents/src/ip-search-query/index.ts` — public `generateQueries(hypothesis: string): Promise<{ ip_australia: string[], semantic_scholar: string[], pubmed: string[], arxiv: string[] }>`
- `packages/agents/src/ip-search-query/prompts.ts` — per-database query templates
- `packages/agents/src/ip-search-verdict/index.ts` — public `draftVerdict({ hypothesis, hits }): Promise<{ verdict, analysisMarkdown }>`
- `packages/agents/src/ip-search-verdict/prompts.ts` — verdict prompt
- Both agents register against the existing agent runtime + budget enforcement.
- Tests under each agent dir.

## Query agent prompt outline

System prompt: "You are an R&D Tax Incentive prior-art search specialist. Generate database-specific search queries that find existing patents and academic papers relevant to a given R&D hypothesis. Each database uses a different syntax — follow the per-database conventions exactly."

User prompt: include the hypothesis text + a description of each database's syntax.

Per-database guidance baked into the prompt:
- **IP Australia / patents**: Boolean operators (`AND`, `OR`, `NOT`); broad terms; include synonyms.
- **Semantic Scholar**: natural language; 5-15 words; focus on the scientific question.
- **PubMed**: natural language or MeSH-style terms; tighter than Semantic Scholar.
- **arXiv**: natural language; technical vocabulary matters.

Output format: JSON `{ ip_australia: string[], semantic_scholar: string[], pubmed: string[], arxiv: string[] }` with 3-5 queries each.

## Verdict agent prompt outline

System prompt: "You are an R&D Tax Incentive eligibility analyst. Given an R&D hypothesis and a list of prior-art hits across patent and scholarly databases, draft a verdict on whether the hypothesis represents genuine novelty (PASS) or is already addressed by existing prior art (FAIL). When the evidence is mixed or insufficient, return INCONCLUSIVE."

User prompt: hypothesis text + all hits across databases (title + abstract excerpt + URL + database name).

Output format: JSON `{ verdict: 'pass'|'fail'|'inconclusive', analysisMarkdown: string }`. The `analysisMarkdown` must:
- Cite specific hits by `[externalId]` reference.
- Be 200-500 words.
- End with a clear "Therefore, this hypothesis is [PASS|FAIL|INCONCLUSIVE] for R&DTI core-activity eligibility."

## Architecture rules

- Both agents use the existing agent runtime budget gate (`llm_token_usage`).
- Both agents pass `agent_name = 'ip-search-query'` or `'ip-search-verdict'` to the ledger.
- Both agents are PURE functions in terms of input → output; no DB writes. Persistence is the API layer's job (task 06).
- Both agents have a deterministic test mode (mock Anthropic client) for unit tests.

## Acceptance

- [ ] `generateQueries('our cryogenic process improves yield by 30%')` returns plausible queries for all 4 databases.
- [ ] `draftVerdict({ hypothesis, hits: [] })` (empty hits) returns `{ verdict: 'pass', ... }` with reasoning "no prior art found".
- [ ] `draftVerdict({ hypothesis, hits: [HIGHLY_RELEVANT_HIT] })` returns `{ verdict: 'fail', ... }` with citation.
- [ ] LLM usage logged to `llm_token_usage` (verify with unit test that captures the mock client calls).
- [ ] `typecheck` + `lint` pass.

## Deliverable

PR titled `feat(agents): ip-search-query + ip-search-verdict agents`.
