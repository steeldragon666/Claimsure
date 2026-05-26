# Wizard Step 1 — Engagement Letter E-Signing (Design Questions)

**Date:** 2026-05-25
**Status:** Decisions made — ready for implementation plan
**Trigger:** "Step one is an engagement letter e-signing from the client upon installation of mobile app"

## DECISIONS (2026-05-25 walkthrough)

| Q | Decision | Why |
|---|---|---|
| Q1 — Provider | **In-house** (typed name + checkbox + audit trail) | Defensible under AU ETA 1999; $0/claim vs $10-25/claim third-party; ~1 week effort vs ~3 days for third-party but no vendor lock-in. Clean upgrade path documented if needed. |
| Q2 — Template scope | **Per-firm template + per-claim variable substitution** | `tenant.engagement_letter_template_md` stores firm-level markdown with `{{claimant_name}}`, `{{financial_year}}`, `{{fee_pct}}` placeholders. Manual template upload by ops during firm onboarding for v1; template editor UI deferred to v2. |
| Q3 — Sign trigger | **Mobile-first + web email-link fallback** | Mobile is primary path on first-launch. Token-gated `/engagement/[token]/sign` web route is the fallback if claimant doesn't install. Avoids deadlock; ~3 extra days of engineering. |
| Q4 — Signers | **Claimant + consultant counter-sign** | Bilateral consent for legal robustness. Consultant counter-signs in web app after notification. Schema already supports it (`countersigned_by_user_id`, `countersigned_at`). |
| Q5 — Stall policy | **Auto-remind + auto-expire at 30 days** | Reminder at 7d and 14d; auto-expire at 30d with `engagement_status='expired'`. Limits offer-open liability. Uses existing email-sender state machine. |
| Q6 — PDF timing | **Async pg-boss job, fires immediately after sign** | Sign endpoint stays fast; PDF appears in evidence ledger within ~30s. Matches existing `apps/api/src/jobs/` pattern. Defensibility-preserving (immutable artifact at the legal moment). |

## What this feature does (working definition)

When a claimant ("the client", as distinct from the consultant who runs the platform) first installs the CPA Platform mobile app, the very first screen they see — before any other functionality — is a legally-binding engagement letter that they must e-sign. The engagement letter is the consultant firm's authorisation to act on the claimant's behalf for R&D Tax Incentive (R&DTI) purposes. No claim work can proceed against that claimant until the letter is signed.

This is the **first step of the claim wizard** from the claimant's perspective; the consultant has already set up the claim record in the web app (likely via the "+ New claim" button now wired by D5).

## What already exists

- **`apps/mobile/`** is in the monorepo. Worth confirming what stack (React Native? Expo? Capacitor?) and what's already in it.
- The `claim`, `tenant`, `tenant_user`, `subject_tenant` tables already model the consultant-firm ↔ claimant relationship.
- `audit_log` table exists (migration 0022) — engagement-letter signing is exactly the kind of event that belongs there.

## What does NOT exist yet

- No `engagement_letter` / `engagement_letter_signature` table or schema.
- No e-signing UI (mobile or web).
- No PDF generation / templating for the signed letter.
- No integration with any third-party e-signature provider.

## Open design questions

### Q1 — Provider: in-house or third-party?

Three options:

**(a) In-house** — typed-name + checkbox + audit trail (timestamp, IP, device info). Cheapest, fastest, fewest vendors to wrangle. Legally defensible in Australia under the *Electronic Transactions Act 1999* (Cth) for most commercial agreements, but discount on enforceability for high-stakes audits.

**(b) DocuSign / HelloSign / SignWell embedded** — third-party SaaS handles the signing flow + audit trail + PDF generation. Strong legal weight (court-tested). Costs ~$10-25/envelope. Adds a vendor dependency and a per-claim cost.

**(c) Hybrid** — in-house for the click-through experience, but mirror the signed letter into a third-party for the audit/PDF trail in the background. Best of both worlds; most engineering effort.

**Recommendation:** start with (a) in-house, document the upgrade path to (b). Australian R&DTI doesn't legally require third-party e-signing; the audit trail (timestamp + IP + device fingerprint + claimant identity verification from the OIDC session) is sufficient. Revisit if a customer asks.

### Q2 — Engagement letter template: per-firm, per-claim, or global?

**(a) Global template** — one canonical letter for all consultant firms. Easiest to maintain, lowest customisation.

**(b) Per-firm template** — each consultant firm uploads/edits their own engagement letter. Highest flexibility; each firm has its own legal preferences. Requires a template editor or markdown upload.

**(c) Per-claim template** — generated per claim with variable substitution (claimant name, FY, fee structure). Combines (b) with a parameterised "instance".

**Recommendation:** (c) per-claim, generated from a per-firm template with variables filled in. Mirrors how engagement letters work in real consulting practice. Requires a Markdown/Mustache-style template editor for the firm admin (out of scope for v1 — ship with one hardcoded firm-level template + variable substitution).

### Q3 — Signing flow trigger: mobile-only or mobile + web?

The user said "upon installation of mobile app". Two reads:

**(a) Mobile-only.** Only the claimant signs, only via the mobile app. The consultant never sees a sign screen in the web app.

**(b) Mobile-first but web fallback.** Mobile is the primary path, but if the claimant doesn't install the app (or refuses), the consultant can send a signing link by email that opens a web-based sign page.

**Recommendation:** ship (b). "Mobile-only" creates a deadlock: claim is blocked until claimant installs an app, and we have no recourse if they don't. The email-link fallback is a few hours of work and unblocks every claim.

### Q4 — Multiple signers?

In real R&DTI engagements, the signers can be:
- Just the company director (one signature)
- Director + witness
- Director + finance officer (joint authorisation)
- Director + the engaging consultant (mutual countersign)

**(a) Single signer (the claimant's director)** — simplest. Sufficient for most engagements.

**(b) Counter-signed by consultant** — claimant signs first, then the platform user (consultant) counter-signs in the web app. Stronger legal stance.

**(c) Configurable per claim** — claim record specifies the signers list; flow adapts.

**Recommendation:** (b) for v1 — the consultant counter-sign is automatic (just a click in the web app after the claimant signs), provides bilateral consent, and matches industry norm. (c) is a future enhancement.

### Q5 — What happens if claimant declines or never signs?

Two angles: UX and data model.

**UX:** show a "Cannot proceed without engagement letter" screen with a "contact your consultant" CTA.

**Data model:** the claim has a `status` field already (drafting/sealed/etc). Add a new pre-status `pending_engagement` OR an enum field `engagement_status` separate from claim status. Affects which dashboard panels show the claim — probably "blocked" status on the consultant dashboard.

**Recommendation:** new `engagement_status` enum on `claim`: `pending_send` → `sent` → `signed` → `declined` (terminal). Don't conflate with claim status — they have different lifecycles. Dashboard claim list filters out `engagement_status != 'signed'` from the "active" view by default, with a separate "Awaiting engagement" panel.

### Q6 — PDF generation: when and where?

The signed engagement letter needs to exist as a PDF for the audit trail (and to send back to the claimant).

**(a) Generate immediately on sign** — synchronous; user gets the PDF in their hand right away.

**(b) Async job** — write to pg-boss queue; PDF appears in evidence ledger within minutes.

**(c) Lazy** — generate only on demand (export button).

**Recommendation:** (b) async job. PDF generation can be slow if the letter is long or includes per-claim variable substitution; doing it synchronously blocks the sign endpoint. The existing job-runner infrastructure (`apps/api/src/jobs/`) is the right pattern.

## Out of scope for v1 (defer)

- Firm-admin template editor — ship with one global template + per-firm variables in `tenant.engagement_letter_text`.
- Multi-language support.
- Witness signatures (Q4 c).
- Revocation / re-signing on letter changes.
- DocuSign integration (Q1 b/c).
- Negotiated/redlined letters.

## Suggested data model

```sql
-- New table:
CREATE TABLE engagement_letter (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid        NOT NULL REFERENCES tenant(id),
  claim_id                uuid        NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  rendered_markdown       text        NOT NULL,  -- the per-claim instance
  template_version        text        NOT NULL,  -- which firm template version
  created_at              timestamptz NOT NULL DEFAULT now(),
  sent_to_claimant_at     timestamptz,
  signed_by_claimant_at   timestamptz,
  signed_by_claimant_name text,
  signed_by_claimant_ip   inet,
  signed_by_claimant_ua   text,
  countersigned_by_user_id uuid       REFERENCES "user"(id),
  countersigned_at        timestamptz,
  pdf_evidence_id         uuid        REFERENCES evidence(id),  -- the generated PDF
  declined_at             timestamptz,
  declined_reason         text,
  CONSTRAINT one_letter_per_claim UNIQUE (claim_id)
);

-- New column on claim:
ALTER TABLE claim ADD COLUMN engagement_status text NOT NULL DEFAULT 'pending_send'
  CHECK (engagement_status IN ('pending_send', 'sent', 'signed', 'declined'));
```

RLS policy: `tenant_id = current_setting('app.current_tenant_id', true)::uuid` (same as every other tenant-scoped table).

## Suggested next move

Pick the answer to each open question above, then this design becomes an implementation spec. From there, dispatch:

1. **Migration agent** — write the migration adding `engagement_letter` table + `engagement_status` column, with RLS policy.
2. **API agent** — endpoints: `POST /v1/claims/:id/engagement/send` (generates the per-claim letter, sets status to `sent`), `POST /v1/engagement/:id/sign` (mobile/web sign endpoint), `POST /v1/engagement/:id/countersign` (consultant counter-sign), `POST /v1/engagement/:id/decline`.
3. **PDF job agent** — extend pg-boss job runner with `engagement-letter-render-pdf` job.
4. **Mobile agent** — first-launch screen, sign flow.
5. **Web fallback agent** — `/engagement/[token]/sign` route for email-link fallback.
6. **Web wizard agent** — adds the engagement-status badge + countersign button to the consultant wizard's Step 1.

Each is its own PR. Order: 1 → 2 → 3 → (4, 5, 6 in parallel).
