# Claimsure downloaded marketing assets review

Date: 2026-05-22

Assets reviewed:

- `C:\Users\shedm\Downloads\claimsure-explainer.docx`
- `C:\Users\shedm\Downloads\claimsure-onepager.pdf`
- `C:\Users\shedm\Downloads\claimsure-landing.html`
- `C:\Users\shedm\Downloads\claimsure-deck.pptx`

## Bottom line

Do not publish or send these assets as-is.

The positioning is directionally useful: Claimsure as a consultant-grade R&DTI evidence and claim preparation platform, focused on contemporaneous evidence, provenance, and reduced manual work. However, the assets currently make several public claims that are too absolute, likely unsupported by the current product, or need legal/compliance substantiation before use.

The safest near-term route is to preserve the strategic story but recast it as:

- A purpose-built Australian R&DTI workflow platform.
- Designed to help consultants collect contemporaneous evidence earlier.
- Uses tamper-evident provenance and structured review workflows.
- Supports consultant-led assessment rather than replacing professional judgement.
- Available for pilots with evidence packaging, review, and export workflows.

## Highest-risk claims

### 1. "One-strike examination model"

Appears throughout all four assets, including variants such as:

- "R&D Tax, reimagined for the one-strike era."
- "FY25-26 introduced ... the one-strike examination model."
- "A single contemporaneous evidence gap ... grounds for full disallowance of the entire claim."
- "One missing record can wipe out an entire claim."

Risk: This is presented as an official FY25-26 program change and a deterministic outcome. The official source set checked did not corroborate the claim in that form. R&DTI evidence standards are real, and poor evidence can cause claims to fail, but "single missing record equals full disallowance" is too strong for public copy unless a lawyer or named authority signs off.

Recommended replacement:

"R&DTI reviews increasingly depend on contemporaneous evidence. Claimsure helps consultants collect, organise, and preserve supporting records before claim preparation begins."

### 2. Consultant personal liability claims

Appears in phrases such as:

- "consultants personally on the hook"
- "consultant signing the file now carries professional risk"
- references to Body by Michael, GQHC, and Aristocrat as a connected line of decisions

Risk: This is a legal conclusion and should not be used publicly without counsel review. It may also overconnect cases that do not stand for the same proposition.

Recommended replacement:

"Consultants are under pressure to maintain clearer working papers, stronger evidence trails, and more defensible claim files."

### 3. Superlative market claims

Appears in phrases such as:

- "The first AI platform purpose-built for the Australian R&D Tax Incentive."
- "five things nothing else in the Australian R&DTI market does"
- "not a general LLM, not a workflow tool"

Risk: "First", "only", and "nothing else" require a current competitor review and substantiation. This is particularly risky in a public landing page or investor deck.

Recommended replacement:

"A purpose-built AI-assisted platform for Australian R&DTI consultants."

### 4. Performance metrics without substantiation

Appears in phrases such as:

- "85-95% of consultant time returned"
- "80%+ of claim time - across firms surveyed"
- "claim quality improves because defects are removed at architectural level"

Risk: These need documented methodology, sample size, date, definition of "consultant time", and whether results are measured or projected.

Recommended replacement:

"Designed to reduce repetitive evidence chasing, manual summarisation, and claim assembly effort during pilot engagements."

### 5. AI training and capability claims

Appears in phrases such as:

- "not GPT"
- "trained on Division 355"
- "trained on ... AusIndustry guidance, AAT and Federal Court precedent, Ambitious Australia agenda"
- "refuses hallucinated hypothesis"
- "consultant-grade judgement"

Risk: The codebase appears to rely on model APIs and application-layer prompts/workflows, not a verified custom-trained or fine-tuned model. "Refuses hallucinated" is also absolute.

Recommended replacement:

"Uses specialised R&DTI prompts, structured workflows, and review checks to assist consultant assessment. Outputs should be reviewed by qualified professionals."

### 6. Integration claims

Appears in phrases such as:

- "integrates with Xero and MYOB"
- "Integrations: Xero - MYOB - ATO - AusIndustry"

Risk: The codebase shows Xero-related integration patterns, but MYOB and direct ATO/AusIndustry integrations were not substantiated during review. Regulatory monitoring/scraping is not the same as a platform integration.

Recommended replacement:

"Supports accounting and evidence workflows, with Xero support and additional integrations planned."

### 7. Blockchain, GitHub mirror, and cryptographic proof claims

Appears in phrases such as:

- "Blockchain-anchored"
- "GitHub-mirrored"
- "A parallel mirror is written to a GitHub repository the client controls."
- "cryptographically provable to AusIndustry"
- "claim sealed as a single cryptographic block"

Risk: The codebase supports tamper-evident hashing/provenance concepts, but not public blockchain anchoring or mandatory GitHub mirroring as described. "Provable to AusIndustry" also implies official acceptance.

Recommended replacement:

"Tamper-evident provenance records and evidence hashes help preserve a defensible audit trail."

### 8. Security and sovereignty claims

Appears in phrases such as:

- "Keys held in HSM"
- "operators cannot read claim data"
- "ClaimSure cannot read the content"
- "Australian sovereign infrastructure"
- "built for Department's expectations"

Risk: These claims require architecture, cloud configuration, encryption design, access controls, and audit evidence. Current evidence supports more conservative infrastructure language, not zero-access or HSM guarantees.

Recommended replacement:

"Designed for Australian data residency, role-based access control, and encrypted cloud infrastructure."

### 9. Fabricated or demo-only regulatory updates

The deck includes sample-looking items such as:

- "ATO published TA 2026/4 overnight"
- "AAT decision in Re Forward Engineering"

Risk: These look like real-time legal/regulatory updates. If they are not real, they must be labelled as demo data or removed.

Recommended replacement:

Use clearly marked placeholders:

"Example regulatory signal - for demo only"

### 10. Financial product roadmap

Appears in phrases such as:

- "autonomous R&DTI financing"
- "12-minute refund-secured loan approval"

Risk: This introduces financial product, credit, licensing, and regulatory issues. Keep out of public marketing until there is a compliant product and approval pathway.

Recommended replacement:

Remove from public assets. If needed for internal strategy, label as exploratory and subject to legal, credit, and compliance review.

## Asset-by-asset recommendations

### `claimsure-landing.html`

Status: Do not publish as-is.

The page has the strongest public risk because it combines unverified legal change claims, quantified performance claims, "nothing else" market positioning, blockchain/GitHub claims, and implied guarantee language such as "single missing record never costs a client their refund."

Action:

- Replace public copy with the safer landing-page direction already added to the repo.
- Remove "one-strike" framing unless verified by counsel and official sources.
- Remove blockchain, GitHub mirror, HSM, zero-access, and MYOB claims unless product evidence exists.
- Convert "book a demo" into pilot/signup language with qualification.

### `claimsure-onepager.pdf`

Status: Do not send externally as-is.

The one-pager is punchy, but it compresses the riskiest claims into a sales asset. That makes it more likely to be forwarded without caveats.

Action:

- Rebuild as a conservative consultant pilot one-pager.
- Replace all absolute language with "designed to", "helps", "supports", and "pilot".
- Add a professional-review disclaimer.

### `claimsure-deck.pptx`

Status: Useful as a narrative draft, not ready for prospects or investors.

The strongest slides are the problem/solution/product-flow slides. The highest-risk slides are the regulatory-change slides, AI capability slide, market-signal slide, security slide, and roadmap slide.

Action:

- Redline slides 2, 6, 8, 9, 10, and 11.
- Label any simulated regulatory feed as demo data.
- Move aggressive future roadmap claims into an internal-only appendix.

### `claimsure-explainer.docx`

Status: Useful source material, but needs rewrite before external use.

The explainer has enough substance to become a good founder memo or sales narrative after claim cleanup.

Action:

- Reframe from "omniscient sovereign platform" to "consultant-grade R&DTI evidence infrastructure".
- Keep the "capture earlier, package better, review faster" message.
- Remove unsupported guarantees and superlatives.

## Approved message architecture

Use this hierarchy for the next public website and signup campaign:

1. Headline: "R&DTI evidence workflows for Australian consultants."
2. Subhead: "Claimsure helps firms collect contemporaneous evidence, structure technical narratives, and prepare review-ready claim files."
3. Product pillars:
   - Evidence capture
   - Tamper-evident provenance
   - Consultant review workflows
   - Exportable claim packs
4. Trust language:
   - Australian data residency target
   - Role-based access
   - Encrypted infrastructure
   - Professional review required
5. CTA:
   - "Apply for pilot access"

## Source-check notes

Sources checked during marketing review:

- ATO Decision Impact Statement for GQHC and Commissioner of Taxation.
- business.gov.au R&D Tax Incentive overview.
- Department of Industry, Science and Resources R&D Tax Incentive program page.
- SW Accountants and Advisors note on the 15 August 2025 R&DTI portal form update.

Working conclusion:

- There is support for positioning around contemporaneous evidence, structured registration, and increasing scrutiny.
- There is not enough support from the checked sources to publicly claim an official "one-strike examination model" or that any single missing record automatically disallows an entire claim.
- Any legal-liability claim tied to specific cases should be reviewed by counsel before publication.

