# Claimsure claims-to-code alignment

Date: 2026-05-22

Purpose: treat the downloaded marketing material as the intended product spec and track what the codebase must support before each claim can be used without qualification.

## Principle

The product should earn the claim. If a claim requires code, infrastructure, vendor contracts, operational evidence, or legal sign-off, it stays below until the proof exists.

## Alignment matrix

| Claim family | Current code support | Gap to close |
| --- | --- | --- |
| Australian R&DTI-specific platform | Strong. Portal-field schemas, claim workflow, activity registers, R&DTI narratives, audit score, compliance routes, and statutory prompt work exist. | Keep portal schema current against the live AusIndustry form and add dated schema verification notes. |
| Contemporaneous evidence capture | Strong. Mobile claimant capture, media/events routes, evidence models, hash-chain event ledger, and claimant magic links exist. | Add product-level evidence coverage dashboard by claim/FY so users can see gaps before review. |
| Immutable / tamper-evident evidence chain | Strong for hash-chain/tamper-evident language. ADR-0003 and `packages/db/src/chain.ts` define per-claimant SHA-256 chains. | For "blockchain anchored" or external timestamping, add OpenTimestamps or equivalent anchor jobs, storage, verification, and export proof. |
| Xero integration | Strong. `@cpa/integrations/xero-accounting`, OAuth, sync helpers, API jobs, and fixtures exist. | Keep connection UX and sync status visible in web app. |
| MYOB integration | Started. `@cpa/integrations/myob-accounting` now defines OAuth, company-file discovery, authenticated AccountRight GET, and tests. | Add API routes, encrypted credential persistence, provider enum/schema migration if needed, resource sync helpers for bills/invoices/accounts/contacts, pg-boss job, and UI connection flow. |
| Daily ATO/AusIndustry/case-law scan | Partial. RIF tables, ATO RSS/AustLII sources, daily scrape job, backfill scripts, classifier plumbing, and tests exist. | Add AusIndustry source coverage, visible "last polled" UI, source health checks, and client-specific impact mapping from regulatory events to claims/prompts. |
| Specialised AI engine | Strong as application-layer agent workflow, not custom model training. Prompt registry, Anthropic-backed agents, structured outputs, citations, evals, and token logging exist. | If marketing says "trained", add documented fine-tuning/RAG corpus and provenance. Otherwise keep the product claim to specialised prompts/workflows/evals. |
| Consultant-grade outputs | Partial-to-strong. Narrative, portal fields, activity PDFs, claim PDFs, expenditure apportionment, and human review flows exist. | Add acceptance benchmarks with consultant-reviewed goldens and record measured precision/recall or review pass rates. |
| 85-95% time returned | Not yet code-supported as a measured claim. | Add workflow telemetry: time spent per stage, before/after baseline, pilot cohort analytics, and a report that calculates measured hours saved. |
| Operators cannot read claim data / zero access | Not code-supported as stated. RLS, encryption helpers, cloud runbooks, and ISO docs exist. | Requires envelope encryption design, tenant-held or KMS-isolated keys, operational break-glass controls, audit logs, and verified access tests. |
| HSM keys | Not code-supported as stated. | Requires cloud KMS/HSM configuration, Terraform or scripts, rotation runbooks, and evidence of key residency. |
| Australian sovereign infrastructure | Partial. GCP Australian region docs exist. | Requires deployment config proof, residency controls, backups/logging residency, supplier register, and customer-facing trust evidence. |
| GitHub mirror | Partial adjacent support. GitHub app/webhook and prompt-suggestion PR tracking exist, but not client evidence mirroring. | Add optional per-client GitHub export app: repo provisioning, commit signer, evidence manifest writer, sync job, webhook verifier, and export verification UI. |
| Claim sealed as cryptographic block | Partial. Individual event/content hashes exist. | Add final claim manifest generation: ordered evidence hashes, chain head, report hashes, model/prompt versions, signature, and verifier CLI. |
| Fast R&DTI financing / refund-secured lending | Product plan exists. Financier UI and shared claim views exist. | Keep as future pillar until lender partnership, compliance review, credit policy, referral/licensing posture, and underwriting telemetry are in place. |

## First engineering tranche

1. Add MYOB AccountRight scaffolding under `@cpa/integrations/myob-accounting`.
2. Add provider persistence and routes so tenants can connect MYOB.
3. Add MYOB bill/invoice/account/contact sync helpers mapped to existing expenditure rows.
4. Add external timestamp anchoring for the event chain if the public claim will say blockchain or independently timestamped.
5. Add final claim manifest export so "sealed claim pack" becomes a product capability.

## Messaging gate

Marketing can say a claim is live only when all required proof is present:

- Code path exists.
- Tests cover the provider/security/claim behaviour.
- UI exposes the capability or the API contract is documented.
- Operational runbook exists for failures and audits.
- External/legal claims have non-code evidence where required.

