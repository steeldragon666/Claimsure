# Agent Prompt — Write Platform Documentation (Help + Files Pages)

Copy the block below into a fresh agent session. The prompt is self-contained; the agent has no memory of any prior conversation.

---

## PROMPT BEGINS

You are writing **user-facing product documentation** for the CPA Platform (deployed as **Claimsure / ArchiveOne**), an Australian R&D Tax Incentive consulting SaaS. Repo at `C:\Users\Aaron\cpa-platform`. pnpm monorepo, Node 22+, TypeScript strict.

Your deliverable is **two new in-app pages**: `/help` and `/files`, populated with substantive content that reflects what the platform actually does today.

### Step 1 — Discovery (READ FIRST, DO NOT SKIP)

Before writing a single line of content, map the product. Read in this order:

1. `README.md` and `CLAUDE.md` at repo root — project north star, tech stack, conventions.
2. `apps/web/src/app/` — every `page.tsx` route. Build a mental table of what's at `/consultant`, `/evidence`, `/claims/...`, `/financing`, `/pipeline`, `/intelligence`, `/admin/...`, `/claimant/...`, `/compliance/...`, etc. There are 30+ routes; you do not need to read each in detail, but you must know what exists.
3. `apps/web/src/app/consultant/_components/*.tsx` — the main consultant workspace (dashboard, wizard, watch, financing). Read `dashboard-view.tsx` and `wizard-view.tsx` in particular for the core concepts.
4. `apps/web/src/app/consultant/_components/tokens.ts` and `atoms.tsx` — the design system you MUST match (colors, typography `fSerif`/`fSans`/`fMono`, `MonoLabel`, `Diamond`, `StatusPill`).
5. `docs/product/`, `docs/plans/` — existing design docs (gold-mine for "what does this product actually do"). Skim filenames; deep-read 3-4 of the most recent.
6. `docs/runbooks/` — for any operational topics worth surfacing to users.
7. `packages/schemas/src/` — the domain glossary lives in the type definitions (claim, activity, evidence, event, etc.).
8. `apps/web/src/app/consultant/_components/preview-banner.tsx` — currently mounted; signals the consultant workspace is "design surface only, values fictional" until D1-D5/W1-W5/V1/X1-X4 wiring lands. Be honest about this state in /help.

### Step 2 — Build the routes

Create two new Next.js routes:

#### `apps/web/src/app/help/page.tsx`

Server-rendered or client component, your call. **Match the consultant workspace visual language** — same color tokens (`ink`, `ink2`, `bone`, `bone3`, `amber`, `rust`, `rule`, `ruleStrong`), same fonts (`fSerif` for headings, `fSans` for body, `fMono` for labels/metadata), same `MonoLabel` + `Diamond` accents. Use the existing tokens — do NOT introduce new colors or fonts.

Content sections (scale length to substance — total page 1000-1800 words):

- **Getting Started** — sign-in (Google/Microsoft OIDC; mention dev-login is internal-only), tour of the consultant workspace, first claim
- **Core concepts** — what is a Claim, an Activity, an Evidence item, a Stage (Stamp / Assemble / Apportion / Seal etc.), the Audit Chain (note: ingestion not yet shipped — be honest), Signals (regulatory watch). Use real names from the codebase; grep before guessing.
- **Workflows** — at minimum:
  - "Start a new claim" (the `+ New claim` button on the consultant dashboard)
  - "Add evidence to a claim" (link to `/evidence`)
  - "Watch for regulatory exposure" (`/consultant` watch panel)
  - "Apportion expenditure" (the wizard's ledger step)
  - "Seal a finalised claim"
- **FAQ** — 6-10 entries. Examples to include: "Why does my dashboard show fictional values?" (preview banner), "Where is my data stored?" (Australia, sovereign — check `docs/iso27001/`), "How long is evidence retained?" (R&D Tax Incentive requires 5 years; verify in `docs/iso27001/` or `docs/process/`), "Who can see my claimant data?" (RLS-scoped per tenant), "How do I export?" (link to relevant route if it exists).
- **Where to get more help** — support contact (find the real email in the codebase or env templates; do NOT invent one), in-app feedback widget if it exists, link to the public marketing site if mentioned in `docs/marketing/`.

#### `apps/web/src/app/files/page.tsx`

Same visual language. Content (1000-1500 words):

- **What "files" means in this product** — evidence artefacts, supporting documents, exported claim packs. The relationship between files and `evidence`, `event`, `activity`, `claim` records.
- **How files are organized** — per claim, per activity, per stage. Folder/label/tag semantics if any.
- **Operations** — upload (single + bulk), search, link to claim, label, archive. Reference the real UI affordances; if a feature isn't built yet, say "Coming soon" rather than inventing it.
- **Compliance & retention** — R&D Tax Incentive retention period, ATO record-keeping requirements (cross-check in `docs/iso27001/` and `docs/process/`). Mention sovereign-data location.
- **Supported file types** — verify in the upload code (`grep -r 'mime\|accept=' apps/web/src/app`); list real types, not aspirational ones.
- **File-size limits** — find the real limit in the upload handler; cite it.
- **Audit trail** — every file action is logged; reference `docs/iso27001/audit-trail.md` or wherever the policy lives.

### Step 3 — Optional top-level docs hub

If you have time and the existing `docs/` doesn't have a clear entrypoint, add `docs/README.md` — a one-page index linking to product docs, design docs, runbooks, and operational documentation. Do NOT duplicate content; just link. This is gravy, not required.

### Step 4 — Style & tone

- Professional, concise, factual. **No emojis.** No marketing speak. No flowery prose.
- Audience: R&D tax consultants who are domain experts in tax but not software. Use plain English; define every product-specific term on first use.
- Use real terminology from the codebase. If you find yourself inventing a term, grep for what the codebase actually calls it.
- Code/CLI examples only where strictly relevant to a user task (e.g., none for /help, possibly a couple for /files if there's a power-user export workflow).
- No screenshots; use prose to describe UI. If a section would clearly benefit from a screenshot, leave a `{/* SCREENSHOT: ... */}` comment as a placeholder.
- Australian English spelling (apportion, organisation, finalise, behaviour, signalled).
- Date format: ISO (`2026-05-25`) or AU long (`25 May 2026`). Never US format.

### Step 5 — Verify

Run from the repo root:

```
pnpm install   # if not already
pnpm --filter @cpa/web typecheck
pnpm --filter @cpa/web lint
```

Both must pass. Fix any errors you introduce; do NOT suppress with `// @ts-ignore` or `eslint-disable`.

Visually confirm the pages render in the design system by reading them top-to-bottom one last time — no broken imports, no missing tokens, no Tailwind classes (this codebase uses inline `style` props with token constants).

### Step 6 — Commit + return

Commit on a new branch `docs/help-and-files-pages` off `main`. Do NOT push, do NOT open a PR.

Return at the end of your run:

1. Branch name and final commit hash.
2. Files added/changed (numbered).
3. Word counts for `/help` and `/files` content (approximate).
4. List of any features you decided NOT to document because they're not yet built (be specific — these become product TODOs).
5. List of any terms/numbers you couldn't verify from the codebase (retention period, file size limit, support email, etc.) — these become product-owner questions.
6. 1-paragraph PR description ready for `gh pr create --title "docs(web): add /help and /files in-app pages" --body "..."`.

### Hard constraints

- DO NOT invent features. If something isn't in the codebase, don't document it.
- DO NOT touch product code beyond adding the two new page files (and any minimal supporting structure like a help-specific sub-component if the page is long).
- DO NOT modify `apps/api`.
- DO NOT modify the consultant preview banner.
- DO NOT add new dependencies. The existing design tokens + React + Next.js are enough.
- DO NOT use Tailwind (this codebase doesn't use it; the consultant workspace is inline-styled with token constants).

## PROMPT ENDS
