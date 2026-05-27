/**
 * Prompts for the ip-search-verdict agent.
 *
 * The agent receives an R&D hypothesis + all prior-art hits across the
 * four databases (IP Australia, Semantic Scholar, PubMed, arXiv) and
 * drafts a verdict on whether the hypothesis represents genuine novelty
 * (PASS), is already addressed by existing prior art (FAIL), or is
 * inconclusive (INCONCLUSIVE).
 *
 * The verdict is ALWAYS analyst-reviewable — see Q3 of the design doc
 * (`docs/plans/2026-05-25-wizard-step-2-ip-search-design.md`). The LLM
 * drafts, the consultant approves or overrides. The agent is never the
 * final word.
 *
 * Output format: single `emit_verdict` tool call with two fields:
 *   - verdict:           'pass' | 'fail' | 'inconclusive'
 *   - analysis_markdown: 200-500 words; cites hits by `[externalId]`
 *                        and ends with a clear conclusion sentence.
 */

export const SYSTEM_PROMPT = `You are an R&D Tax Incentive eligibility analyst.

Given an R&D hypothesis and a list of prior-art hits across patent and
scholarly databases, draft a verdict on whether the hypothesis
represents genuine novelty (PASS) or is already addressed by existing
prior art (FAIL). When the evidence is mixed or insufficient, return
INCONCLUSIVE.

Your verdict will be reviewed by a human consultant before it is final.
Be honest about uncertainty — INCONCLUSIVE is a legitimate output when
the hits don't clearly resolve the question.

OUTPUT

Emit a SINGLE call to the \`emit_verdict\` tool with these fields:

  - \`verdict\`: one of "pass" | "fail" | "inconclusive"
  - \`analysis_markdown\`: 200-500 words of markdown-formatted analysis

RULES FOR analysis_markdown

  1. Cite specific hits by \`[externalId]\` reference. Example:
     "Patent [AU2019123456] describes a closely related cryogenic
     separation method that achieves comparable yields..."

  2. Walk through the hits that influenced your verdict. Group by
     database where useful. Highlight the SINGLE most-relevant hit
     first if there is one.

  3. If verdict is PASS:
       - Acknowledge what prior art exists in the adjacent space and
         explain why none of it negates the hypothesis's novelty.
       - If there are NO hits at all, say so explicitly: "No prior
         art was found across IP Australia, Semantic Scholar, PubMed,
         or arXiv for the queries generated from this hypothesis."

  4. If verdict is FAIL:
       - Name the specific hit(s) that establish prior art. Quote
         titles. Explain why the hypothesis is anticipated or
         obvious in light of them.

  5. If verdict is INCONCLUSIVE:
       - Explain what is unresolved: missing context in the hits, the
         hypothesis is too vague to compare, or the hits are tangential.
       - Suggest what additional information would resolve the question
         (e.g. "the analyst should review the full text of patent
         [AU2019123456] to determine claim overlap").

  6. End with a single concluding sentence of EXACTLY this form
     (substituting the correct verdict):
        "Therefore, this hypothesis is **PASS** for R&DTI core-activity eligibility."
        "Therefore, this hypothesis is **FAIL** for R&DTI core-activity eligibility."
        "Therefore, this hypothesis is **INCONCLUSIVE** for R&DTI core-activity eligibility."

  7. Length: 200-500 words. Do not pad; do not truncate.

  8. NEVER fabricate hits. If you cite an externalId it must appear in
     the input hits list. If no hits are provided, the analysis_markdown
     must explicitly state that no prior art was found and the verdict
     must be \`pass\` (since absence of prior art is the foundation of
     R&DTI novelty).

  9. Do NOT include front-matter, code fences, or surrounding prose
     outside the analysis_markdown field. The tool call IS the response.`;

/**
 * Render hypothesis + hits into the user message body.
 *
 * Hits are grouped by database for readability and listed compactly so
 * Sonnet can scan many at once. We include the external ID + title +
 * abstract excerpt + URL — that's the minimum needed for the verdict.
 *
 * Hits are passed in as the structural shape declared in `index.ts`;
 * we don't depend on the integration packages (they live in PRs not
 * yet merged) so the shape is intentionally minimal.
 */
export function buildUserMessage(
  hypothesis: string,
  hits: ReadonlyArray<IpSearchHitForPrompt>,
): string {
  const lines: string[] = [
    'Draft a verdict for the following R&D hypothesis based on the prior-art hits below.',
    '',
    'Hypothesis:',
    '```',
    hypothesis.trim(),
    '```',
    '',
  ];

  if (hits.length === 0) {
    lines.push('Prior-art hits: NONE — no results returned from any of the four databases.');
    lines.push('');
    lines.push(
      'Per rule 8, your verdict should be `pass` and the analysis must explicitly state that no prior art was found.',
    );
    return lines.join('\n');
  }

  // Group hits by database for readability.
  const byDb = new Map<string, IpSearchHitForPrompt[]>();
  for (const h of hits) {
    const arr = byDb.get(h.database) ?? [];
    arr.push(h);
    byDb.set(h.database, arr);
  }

  lines.push(`Prior-art hits: ${hits.length} total across ${byDb.size} database(s).`);
  lines.push('');

  for (const [db, dbHits] of byDb.entries()) {
    lines.push(`### Database: ${db} (${dbHits.length} hit${dbHits.length === 1 ? '' : 's'})`);
    lines.push('');
    for (const h of dbHits) {
      lines.push(`- **[${h.externalId}]** ${h.title}`);
      if (h.url) lines.push(`  URL: ${h.url}`);
      if (h.abstract) {
        // Trim abstract to keep input tokens bounded; 800 chars is enough
        // for the model to grok relevance without ballooning context.
        const trimmed = h.abstract.length > 800 ? `${h.abstract.slice(0, 800)}…` : h.abstract;
        lines.push(`  Abstract: ${trimmed}`);
      }
      if (h.relevanceScore !== undefined) {
        lines.push(`  Relevance score: ${h.relevanceScore}`);
      }
      lines.push('');
    }
  }

  lines.push('Emit a single `emit_verdict` tool call with your verdict + analysis_markdown.');
  return lines.join('\n');
}

/**
 * Structural shape this prompt module expects for each prior-art hit.
 * Declared here (not in index.ts) so prompts.ts is self-contained for
 * prompt-engineering review — reviewers can see the exact fields the
 * model is shown.
 */
export interface IpSearchHitForPrompt {
  /** Source database for this hit. */
  database: 'ip_australia' | 'semantic_scholar' | 'pubmed' | 'arxiv';
  /** External identifier (patent number, PMID, arXiv ID, etc.) — used for citation. */
  externalId: string;
  /** Document title. */
  title: string;
  /** Optional abstract / snippet (will be trimmed to 800 chars). */
  abstract?: string;
  /** Optional URL the consultant can click to read the full record. */
  url?: string;
  /** Optional relevance score (0..1) from the source database. */
  relevanceScore?: number;
}

export const EMIT_VERDICT_TOOL_NAME = 'emit_verdict';

export const EMIT_VERDICT_TOOL_DESCRIPTION =
  'Emit the prior-art verdict (pass/fail/inconclusive) plus a markdown analysis citing the relevant hits.';
