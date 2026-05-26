# 03 — Semantic Scholar Integration Package

**Depends on:** none (parallel with 02 and 04)

## Goal

A self-contained `@cpa/integrations-semantic-scholar` package with `searchSemanticScholar(query: string, opts?): Promise<SemanticScholarResult[]>`.

## Files to add

Mirror the structure from task 02 (IP Australia). Substitute Semantic Scholar specifics.

## API to use

Semantic Scholar Academic Graph API:
- Base: `https://api.semanticscholar.org/graph/v1/paper/search`
- Free, no key required for low volume; optional API key for higher rate limits (env var `SEMANTIC_SCHOLAR_API_KEY`).
- Docs: https://api.semanticscholar.org/api-docs/graph

Query params worth supporting:
- `query` — natural language; the API does the relevance scoring
- `limit` — max results (default 20)
- `fields` — request `externalIds,title,abstract,year,url,citationCount`

## Normalized return shape

```ts
export interface SemanticScholarResult {
  externalId: string;     // DOI if present, else Semantic Scholar paperId
  title: string;
  abstract: string | null;
  publishedAt: string | null;  // best-effort ISO date from year
  url: string;
  relevanceScore?: number;  // Semantic Scholar provides a `score` field
  citationCount?: number;
}
```

## Architecture rules

Same as task 02:
- No DB. No LLM. Timeouts + retries. Typed errors. Optional API key via function argument.
- Semantic Scholar's unauthenticated rate limit is ~1 req/sec — respect it.

## Acceptance

- [ ] `searchSemanticScholar('cryogenic process')` returns ≥1 result against the live API (test marked `.skip` if no network).
- [ ] Unit tests for `normalize.ts` cover empty / malformed / valid responses.
- [ ] `typecheck` + `lint` pass.

## Deliverable

PR titled `feat(integrations): @cpa/integrations-semantic-scholar package`.
