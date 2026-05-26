# 04 — PubMed + arXiv Integration Packages

**Depends on:** none (parallel with 02 and 03)

## Goal

Two self-contained integration packages: `@cpa/integrations-pubmed` and `@cpa/integrations-arxiv`. Each exports a single `searchX(query): Promise<XResult[]>` function. Same structural pattern as tasks 02 and 03.

## Files to add

Two parallel package directories:
- `packages/integrations/pubmed/...` (mirror task 02 layout)
- `packages/integrations/arxiv/...` (mirror task 02 layout)

## PubMed API

NCBI E-utilities (free, no key required for low volume; optional `PUBMED_API_KEY` for higher rate limits):
- Search: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<query>&retmode=json`
- Fetch: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=<ids>&retmode=json`
- Two-step: search returns PMIDs, then fetch summaries.
- Docs: https://www.ncbi.nlm.nih.gov/books/NBK25497/
- Rate limit: 3 req/sec unauthenticated, 10 req/sec with key.

PubMed-specific note: queries can use MeSH terms for higher precision. v1 can use natural language; v2 might invest in MeSH expansion.

## arXiv API

arXiv query API (free, no key):
- Endpoint: `http://export.arxiv.org/api/query?search_query=<query>&max_results=20`
- Returns Atom XML (use `fast-xml-parser` or similar to parse).
- Docs: https://info.arxiv.org/help/api/user-manual.html
- Rate limit: no hard limit but they ask for ≤1 req/3sec.

## Normalized return shape

Both share the same shape; differ only in source naming.

```ts
export interface PubMedResult {
  externalId: string;     // PMID
  title: string;
  abstract: string | null;
  publishedAt: string | null;
  url: string;            // https://pubmed.ncbi.nlm.nih.gov/<pmid>/
  relevanceScore?: number;
}

export interface ArxivResult {
  externalId: string;     // arXiv id, e.g. "2305.12345"
  title: string;
  abstract: string | null;
  publishedAt: string | null;
  url: string;            // https://arxiv.org/abs/<id>
  relevanceScore?: number;
}
```

## Acceptance

- [ ] Both packages searchX returns ≥1 result against live API (network tests `.skip`-able).
- [ ] Unit tests for normalize cover empty/malformed/valid responses.
- [ ] Both packages build, typecheck, lint cleanly.

## Deliverable

PR titled `feat(integrations): @cpa/integrations-pubmed + @cpa/integrations-arxiv packages`.

(One PR for both since they're symmetric; reviewer load is the same as separate PRs would be.)
