# cpa-platform

White-label SaaS platform for Australian R&D Tax Incentive (R&DTI) and grant
consultants. Monorepo: TypeScript across mobile (Expo), web (Next.js), and API
(Fastify); Postgres + pgvector for storage; Anthropic Claude for agents.

## Phase status

| Phase                             | Status   |
| --------------------------------- | -------- |
| P0 Foundation                     | Done     |
| P1 Identity & Tenancy             | Done     |
| P2 Event Capture (vertical slice) | Done     |
| P3+                               | planning |

P2 ships the first end-to-end product slice: paste-to-classify evidence
capture, hash-chained per claimant, with a Haiku-backed classifier and a
stub-fallback circuit breaker. See
[`docs/decisions/0003-event-chain-and-classifier.md`](./docs/decisions/0003-event-chain-and-classifier.md)
for the architectural decisions.
