# ADR-0005: White-Label Hostname Routing & ACME Cert Lifecycle

**Status:** Accepted
**Date:** 2026-04-27
**Authors:** Aaron Newson + AI pair (Claude Opus 4.7 1M)
**Builds on:** [ADR-0001](./0001-monorepo-and-stack.md), [ADR-0002](./0002-identity-and-tenancy.md), [ADR-0004](./0004-claimant-identity-and-mobile.md)
**Source brainstorm:** [P3 design Q7d](../plans/2026-04-27-p3-mobile-scribe-design.md)

## Context

Pillar 5 of the product spec is **white-label-from-day-one**: the consultant
firm's customers (claimants, financiers, lab employees opening the magic-link
email) should never see the platform's brand, only the consultancy's. P3
locks the scope at Q7d=C, the most ambitious of the three options:

- **Logo + theme + email sender + ToS** per consultant firm.
- **Custom subdomain** (`acme.platform.com.au`) — issued instantly via
  wildcard DNS at `*.platform.com.au`.
- **Full custom domain** (`accounts.acme.com.au` or whatever the firm
  picks) — requires the firm to publish a CNAME, then the platform issues
  an ACM TLS cert and attaches it to the CloudFront distribution.
- **Per-firm landing pages** — the marketing site at the firm's hostname is
  themed.
- **ACME cert lifecycle** — automated, no engineering involvement on
  renewal.

Claimant employees follow magic-link emails sent from a DKIM-verified
per-firm sender domain, click into a PWA at the firm's white-labelled
hostname, and land in screens themed by that firm's `brand_config` palette

- logo. The mobile app fetches the same `brand_config` at session
  bootstrap and applies it in-app. The product brief insists this end-to-end
  white-label has to work without engineering involvement on each new firm
  — a self-serve wizard, not a ticket queue.

This ADR captures the routing + cert-lifecycle decisions that propagate
into Fastify (`apps/api`), Next.js (`apps/web`), and the pg-boss job layer
that drives the state machines.

## Decision

### Hostname-based tenant resolution (request-time)

A request-time middleware on both Fastify and Next.js maps `Host:` →
`brand_config` row → `tenant_id`, attached to the request object so
downstream handlers (admin pages, magic-link redeem, landing-page render)
theme themselves without a second lookup.

- **`hostname-tenant-resolver`** (Fastify preHandler at
  `apps/api/src/middleware/hostname-tenant-resolver.ts`).
  1. Read `Host:` header (lowercased, port-stripped).
  2. Match against `^([a-z0-9-]+)\.platform\.com\.au$`. If matched:
     `SELECT … FROM brand_config WHERE custom_subdomain = $1`.
  3. Otherwise (full custom domain):
     `SELECT … FROM brand_config WHERE custom_domain = $host`.
  4. On match: attach `req.resolvedBrand = { tenant_id, display_name,
primary_color, accent_color, logo_s3_key }`.
  5. On miss: leave `resolvedBrand` undefined; downstream handlers decide
     how to render (typically: 404 "unknown brand" for branded routes,
     fall through to platform default for the bare `platform.com.au`).
- **Next.js mirror** in `apps/web/middleware.ts` (or per-page server
  component, depending on how the route stack lands) does the same lookup
  with the same precedence so the marketing page rendered at
  `acme.platform.com.au` shows Acme's logo, not the platform's.
- **Subdomain match takes precedence over `custom_domain`** if a firm
  somehow has both configured — the subdomain is the canonical route, the
  custom domain is just a vanity alias that resolves the same tenant.
- **Wildcard `*.platform.com.au` subdomains are immediate**: ship a
  wildcard cert and DNS record once, every new `<slug>.platform.com.au`
  works the moment a `brand_config` row writes the slug. No state machine
  for subdomains. Custom domains need the state machine below.

The middleware uses **`privilegedSql`** (RLS-bypass) because it runs
BEFORE any session / GUC is set — RLS on `brand_config` would hide every
row. This is acceptable because the fields read (`display_name`,
`primary_color`, `accent_color`, `logo_s3_key`) are public-by-design (they
render on the unauthenticated landing page). Operational fields (DKIM
status, ACM ARN) are NEVER returned through `req.resolvedBrand` so they
cannot leak.

### Custom-domain state machine

Custom-domain provisioning is a four-state, three-transition machine
driven by a pg-boss job:

```
unconfigured
  ↓ consultant submits a domain in /admin/brand-config/domain
cname_pending
  ↓ pg-boss job polls DNS for CNAME → expected target every 60s
  ↓ on match:
cert_pending
  ↓ pg-boss job submits ACM RequestCertificate (DNS-01 method)
  ↓ on ISSUED:
active
  ↓ CloudFront distribution updated to include the new alternative-domain
  ↓ brand_config.custom_domain_acm_arn populated
  ↓ requests on the custom domain start working

failed (terminal at any step)
```

- **State column** — `brand_config.custom_domain_status text NOT NULL
DEFAULT 'unconfigured'`, CHECK-constrained to the five-state enum.
- **Driver** — `apps/api/src/jobs/custom-domain-state-machine.ts`
  (`advanceCustomDomainState(tenantId, deps?)`). Idempotent — calling
  twice on the same row is safe; the second call sees the already-advanced
  state and is a no-op. Tests inject a CNAME-resolver stub via the
  `deps.resolveCname` hole rather than mocking `node:dns` at module level.
- **Expected CNAME target** — read from `PLATFORM_CNAME_TARGET` env, default
  `platform-cnames.platform.com.au`. The CNAME-match accepts both the
  trailing-dot rooted-FQDN form and the dotless form (resolvers vary).
- **`failed` is terminal** — once entered, the state stays there until a
  consultant explicitly retries from the admin UI. Auto-retry on a typo'd
  domain would generate ACM rate-limit pressure and obscure the user's
  remediation path.
- **`failed` surfaces in the admin UI** with a remediation hint: "expected
  CNAME `<target>`, got `<seen>`" or "DNS resolver error: `<message>`".
  The PWA on the failed domain doesn't break — until cert-pending →
  active fires, requests on the custom domain just don't reach the
  platform (no DNS), so the firm continues to operate on their
  `*.platform.com.au` subdomain in the interim.

### DKIM email-sender verification (parallel state machine)

DKIM verification for the firm's outbound email sender follows the same
state-machine pattern but on `email_sender_dkim_status`:

```
unconfigured
  ↓ consultant enters domain in /admin/brand-config/email-sender
pending
  ↓ pg-boss job polls DKIM TXT records for selector{1,2,3}._domainkey.<domain>
  ↓ on match:
verified
  ↓ SES configured to use the domain as sender for tenant-scoped emails

failed (terminal)
```

- **Driver** — `apps/api/src/jobs/email-sender-state-machine.ts`
  (`advanceEmailSenderState(tenantId)`).
- **Why a parallel state machine, not a column on the custom-domain one**
  — a firm may want a custom email sender (`mail.acme.com.au`) and a
  custom platform domain (`accounts.acme.com.au`) on different domains,
  or just one or the other. Coupling them would force premature
  bundling.
- **Same RLS-bypass pattern** for the same reason — the job needs to read
  `brand_config` rows across all tenants to drive transitions.

### v1 STUB transitions for ACM + SES + Route53

For P3 v1, the second transition in each state machine is **stubbed**:

- `cert_pending → active` flips directly with a placeholder `acm_arn`
  string. No real ACM RequestCertificate; no real CloudFront
  alternative-domain update.
- `pending → verified` flips directly without resolving DKIM TXT records.

The first transition in each (DNS CNAME match, in the custom-domain case)
IS real — it uses `dns.promises.resolveCname` and validates against the
expected target. The stub is purely on the AWS-write side. This means:

- The wizard's full happy path is **demoable end-to-end** without an AWS
  account: a firm enters a domain, publishes the CNAME, the job picks it
  up, the state advances to `active`, the admin UI shows green check.
- The **handover to real wiring is mechanical** — replace the stub branch
  with `acm.requestCertificate(...)` + `cloudfront.updateDistribution(...)`
  - `ses.verifyDomainDkim(...)`. The state machine shape, the DB columns,
    the admin UI, and the test scaffold all stay the same.

Real wiring lands in **P9** as part of the production deployment phase. The
ADR documents this explicitly so future contributors don't accidentally
ship the stub to a real customer.

## Consequences

**Positive**

- **Customers can fully white-label without engineering involvement.**
  Consultant types domain → publishes CNAME → wizard reports green within
  minutes. No deploy. No ticket queue.
- **Multi-tenant cert ops are automated.** Once real ACM wiring lands,
  ACM auto-renews issued certs at 60 days; the platform never manually
  rotates a cert.
- **Zero-downtime cert renewal** via ACM (renewals don't require any
  CloudFront alternative-domain mutation; ACM swaps the cert under the
  hood while the alternative-domain set stays the same).
- **Subdomain customers are instant** — no waiting on DNS propagation or
  ACM issuance for the `*.platform.com.au` path, which covers the
  majority case.
- **State machines are idempotent + driver-injectable** — easy to test
  without external DNS / ACM stubs at the module level.

**Negative**

- **Edge-routing complexity.** Hostname → tenant lookup adds an extra DB
  query per request. Mitigated by:
  - The lookup hits one indexed row and returns five small fields.
  - A reasonable LRU cache (in-memory, 5-minute TTL) is a future
    optimisation; `brand_config` rarely changes, so a cache hit-rate >
    99% is plausible.
  - The middleware short-circuits on bare `platform.com.au` (no firm
    scope), so the platform's own marketing/admin requests skip it.
- **ACM has rate limits.** Real wiring will need to respect AWS's
  per-region cert-issuance limits (currently 20 / day for managed certs
  per AWS account in most regions). Failed states caused by rate-limit
  hits look the same as failed states caused by typo'd domains; the
  remediation hint will need to discriminate.
- **DNS misconfigurations on the customer's side** surface as `failed`
  state with manual remediation. This is the right design (auto-retry
  on a typo'd domain just hides the problem), but the admin UI's error
  message has to be actionable enough that a non-technical consultant
  can fix it.
- **`privilegedSql` is RLS-bypass** — every use is auditable in the codebase
  (`hostname-tenant-resolver.ts`, the two state-machine jobs, and a
  handful of P0 boot paths). The risk is that a future contributor uses
  it elsewhere without thinking through the cross-tenant data exposure.
  Mitigation: `privilegedSql` is named conspicuously and the existing
  call sites all carry comments explaining why RLS-bypass is acceptable
  there.
- **Tests on the state machine require careful resolver-stub injection.**
  The `deps.resolveCname` parameter is the only sanctioned mocking
  surface; module-level mocking of `node:dns` is forbidden because
  node:test doesn't support it cleanly.

**Reviewable in P9 (real-wiring task)**

- **Real ACM + Route53 + SES wiring**. The stub transitions
  (`cert_pending → active`, `pending → verified`) need to call AWS APIs
  with appropriate retry/error-classification. Cert-issuance failures
  should distinguish "typo / DNS misconfiguration" from "ACM transient
  error" (retry) from "ACM rate-limit hit" (back off, surface to ops).
- **CloudFront alternative-domain update batching**. CloudFront
  distributions take ~15 minutes to deploy a config change; if multiple
  firms onboard within a window, batch the alternative-domain updates
  rather than triggering N deploys.
- **Multi-region failover for the resolver**. Today the middleware reads
  from the primary region's Postgres on every request. If the API moves
  to multi-region active-active, the resolver needs region-local read
  replicas or an in-memory cache primed on deploy.
- **DNS pre-flight check at submission time.** The wizard could resolve
  the CNAME BEFORE writing `cname_pending` to surface "you haven't
  published the record yet" earlier in the flow. Currently the user
  submits, then waits for the polling job. Acceptable for v1; UX
  refinement after first-customer feedback.
- **ACME via Let's Encrypt as an alternative to ACM**. ACM ties us to
  AWS for the cert plane; Let's Encrypt + a DNS-01 ACME client would
  decouple cert issuance from cloud provider. Probably not worth the
  switch — ACM-on-CloudFront is operationally cleaner — but worth
  flagging if AWS-cost optimisation surfaces as a P-something concern.

## Alternatives considered

- **Per-tenant subdomain only — no full custom domain.** Rejected. The
  spec demands full custom-domain support (Q7d=C). A platform-branded
  subdomain still leaks the platform's brand in the URL bar, which
  defeats the purpose of "your customer never sees us".
- **Single SaaS domain with no white-label** (consultants identify their
  firm via a slug in the path: `platform.com.au/firms/acme/...`).
  Rejected. Pillar 5 demands the firm's brand IS the experience; a
  shared SaaS hostname is the antithesis.
- **Per-tenant CloudFront distribution** instead of one shared
  distribution with multiple alternative domains. Rejected. CloudFront
  has a hard limit (~200 distributions per AWS account by default);
  scaling per-tenant distributions would hit the limit at ~the 200th
  consultant firm, which is a perfectly plausible scale for the AU
  market. One distribution + alternative-domain set scales cleanly to
  thousands of domains.
- **Customer-supplied cert** (consultant uploads a PEM). Rejected as
  v1 default — it surfaces every cert-renewal headache to the customer
  and breaks the "no engineering involvement" promise. Worth keeping as
  an enterprise opt-in (some compliance regimes require customer-managed
  PKI), but ACM is the default.
- **Synchronous cert issuance in the wizard** (block the consultant's
  submit until the cert is issued). Rejected. Cert issuance can take
  minutes; a wizard that blocks on it is a UX failure. Async + visible
  state-machine progress in the admin UI is the right shape.
- **Treat email-sender DKIM as part of the custom-domain state machine.**
  Rejected. The two surfaces are independent (a firm may want one and
  not the other) and the verification predicates are different (CNAME
  vs DKIM TXT). Coupling them would force premature bundling.

## References

- [P3 design §6 — hostname routing + custom-domain lifecycle](../plans/2026-04-27-p3-mobile-scribe-design.md)
- [P3 design Q7d — white-label scope decision (=C: full)](../plans/2026-04-27-p3-mobile-scribe-design.md)
- [Product feature spec — Module 6 + Pillar 5](../product/2026-04-27-omniscient-feature-spec.md)
- Migration `0008_funny_kid_colt.sql` — `brand_config` table including
  `custom_domain_status` + `email_sender_dkim_status` enum CHECKs
- `apps/api/src/middleware/hostname-tenant-resolver.ts` — F4 hostname
  resolver
- `apps/api/src/jobs/custom-domain-state-machine.ts` — C7
  CNAME-poll + cert-issuance state advance (cert step stubbed)
- `apps/api/src/jobs/email-sender-state-machine.ts` — C9 DKIM
  verification state advance (TXT-resolution step stubbed)
- `apps/api/src/routes/brand-config.ts` — admin-portal wizard endpoints
- `packages/integrations/src/runtime/dns-resolver.ts` — `resolveCname`
  wrapper used by the custom-domain state machine
- AWS ACM cert lifecycle docs: https://docs.aws.amazon.com/acm/latest/userguide/managed-renewal.html
- DocuSign Connect HMAC verification (parallel pattern at the integration
  layer): `packages/integrations/src/runtime/webhook-verify.ts`
