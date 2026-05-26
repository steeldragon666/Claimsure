# 02 — IP Australia Integration Package

**Depends on:** none

## Goal

A self-contained `@cpa/integrations-ip-australia` package that exposes one function: `searchIpAustralia(query: string): Promise<IpAustraliaResult[]>`. Calls IP Australia's free public API and returns normalized hits.

## Files to add

- `packages/integrations/ip-australia/package.json`
- `packages/integrations/ip-australia/tsconfig.json` (extend monorepo base; mirror an existing integration package)
- `packages/integrations/ip-australia/src/index.ts` — public exports
- `packages/integrations/ip-australia/src/client.ts` — HTTP client + retry/timeout logic
- `packages/integrations/ip-australia/src/types.ts` — `IpAustraliaResult`, `IpAustraliaSearchOptions`
- `packages/integrations/ip-australia/src/normalize.ts` — pure function: API response → normalized shape (matches `ip_search_hit` table columns: `externalId`, `title`, `abstract`, `publishedAt`, `url`)
- `packages/integrations/ip-australia/src/index.test.ts`

## API to use

IP Australia's official patent search API. Endpoint: research before implementing — start at https://www.ipaustralia.gov.au/about-us/news-and-community/data and look for the data services / web services. If no real API exists, fall back to:
- AusPat search REST endpoint (if public)
- Or scrape AusPat search results page (last resort; document the choice)

Document the chosen endpoint in `client.ts` header comment with a link to the upstream docs.

## Normalized return shape

```ts
export interface IpAustraliaResult {
  externalId: string;     // patent application number, e.g. "2024901234"
  title: string;
  abstract: string | null;
  publishedAt: string | null;  // ISO date
  url: string;            // canonical AusPat URL for the patent
  relevanceScore?: number;  // if the API returns a score; else undefined
}
```

## Architecture rules

- No DB access from this package.
- No LLM access from this package.
- All network calls have a 30-second timeout + 2 retries with exponential backoff.
- Rate-limiting: respect any documented IP Australia rate limit; default to max 5 req/sec if undocumented.
- Errors: throw typed errors (`IpAustraliaApiError` with `statusCode`, `body`); never silently swallow.
- No secrets in the package — if an API key is needed, accept it as a function argument from the caller (which will read it from env vars).

## Acceptance

- [ ] `searchIpAustralia('cryogenic process')` returns ≥1 result against the live API (network test, marked `.skip` in CI if no API access).
- [ ] Unit tests for `normalize.ts` cover: empty response, malformed response, valid response with 3 hits.
- [ ] `typecheck` + `lint` pass.
- [ ] Package builds (`pnpm --filter @cpa/integrations-ip-australia build`).

## Deliverable

PR titled `feat(integrations): @cpa/integrations-ip-australia package`.
