/**
 * SonnetApplicationDrafter — production implementation of the
 * application-drafter agent.
 *
 * Takes the full classified evidence chain for a claimant + fiscal year
 * and produces a portal-ready AusIndustry application via Sonnet's
 * structured tool-use.
 *
 * MODEL: claude-sonnet-4-5 by default; override via
 * `APPLICATION_DRAFTER_MODEL` env var (allows trying Opus for high-stakes
 * runs without a code change).
 *
 * INPUT TOKENS: typically 30K-100K (depending on event count + payload
 * size). Sonnet's 200k context window comfortably fits all 40 events
 * we see in production.
 *
 * OUTPUT TOKENS: 20K-30K typical (~25K words of structured prose). Set
 * MAX_TOKENS = 32_000 to give Sonnet room; if output truncates,
 * raise the cap.
 *
 * LATENCY: 60-120 seconds for the full draft. Caller should run this
 * inside a pg-boss job (apps/api/src/jobs/generate-application.ts —
 * coming in a follow-up commit) and poll for completion rather than
 * blocking an HTTP request.
 */
import { getAnthropicClient } from '../runtime/anthropic-client.js';
import { getPrompt } from '../runtime/prompt-registry.js';
import { callWithToolUse } from '../runtime/tool-use.js';
import './prompts/draft-application@1.0.0.js'; // side-effect: registers
import type {
  ApplicationDrafter,
  ApplicationDrafterInput,
  ApplicationDrafterResult,
} from './types.js';

const MODEL = process.env.APPLICATION_DRAFTER_MODEL ?? 'claude-sonnet-4-5';
const PROMPT_KEY = 'draft-application@1.0.0';
const MAX_TOKENS = 32_000;

export class SonnetApplicationDrafter implements ApplicationDrafter {
  async draft(input: ApplicationDrafterInput): Promise<ApplicationDrafterResult> {
    const prompt = getPrompt<ApplicationDrafterResult['output']>(PROMPT_KEY);

    // DIAG: surface model + input volume for production runs. These are
    // expensive calls (~60s, ~$0.50 per draft) — observability matters.
    console.log(
      '[SonnetApplicationDrafter][DIAG]',
      JSON.stringify({
        model: MODEL,
        claimant: input.applicant.name,
        income_year: input.income_year,
        eventCount: input.events.length,
        proposalCount: input.events.reduce(
          (n, e) => n + (e.extracted_content?.activities.length ?? 0),
          0,
        ),
        startedAt: new Date().toISOString(),
      }),
    );

    const userMessage = buildUserMessage(input);

    const { output, tokens_in, tokens_out } = await callWithToolUse(getAnthropicClient(), {
      model: MODEL,
      system: prompt.system,
      user: userMessage,
      tool: prompt.tool,
      max_tokens: MAX_TOKENS,
    });

    console.log(
      '[SonnetApplicationDrafter][DIAG] complete',
      JSON.stringify({
        tokens_in,
        tokens_out,
        core_activities: output.core_activities.length,
        supporting_activities: output.supporting_activities.length,
        hypotheses: output.hypothesis_register.length,
        failures: output.failure_register.length,
        new_knowledge: output.new_knowledge_register.length,
      }),
    );

    return {
      output,
      usage: { model: MODEL, tokens_in, tokens_out },
    };
  }
}

/**
 * Render the input bundle as a structured user message. The model gets
 * markdown-formatted blocks per evidence event so it can scan + reason
 * across the full chain.
 *
 * Order matters: we sort events by captured_at ASC so the chronology of
 * the R&D programme is implicit. The model can derive project phases
 * from that ordering.
 */
function buildUserMessage(input: ApplicationDrafterInput): string {
  const sortedEvents = [...input.events].sort((a, b) => a.captured_at.localeCompare(b.captured_at));

  const eventBlocks = sortedEvents.map((e, i) => {
    const parts: string[] = [];
    parts.push(`### Event ${i + 1} — ${e.filename ?? e.kind} (${e.kind})`);
    parts.push(`Captured: ${e.captured_at}`);

    if (e.classification) {
      parts.push(``);
      parts.push(
        `**Classification:** ${e.classification.kind} (confidence ${e.classification.confidence})`,
      );
      parts.push(`**Statutory anchor:** ${e.classification.statutory_anchor}`);
      parts.push(`**Rationale:** ${e.classification.rationale}`);
    }

    if (e.extracted_content?.document_summary) {
      parts.push(``);
      parts.push(`**Document summary:** ${e.extracted_content.document_summary}`);
    }

    const activities = e.extracted_content?.activities ?? [];
    if (activities.length > 0) {
      parts.push(``);
      parts.push(`**Proposed activities (Haiku extraction):**`);
      for (const a of activities) {
        parts.push(``);
        parts.push(`- **${a.proposed_name}** [${a.proposed_kind}] confidence=${a.confidence}`);
        parts.push(`  - Hypothesis: ${a.hypothesis_text}`);
        parts.push(`  - Technical uncertainty: ${a.technical_uncertainty}`);
        parts.push(`  - Expected outcome: ${a.expected_outcome}`);
        if (a.source_excerpt) {
          parts.push(`  - Source excerpt: "${a.source_excerpt.slice(0, 600)}"`);
        }
        if (a.rationale) {
          parts.push(`  - Rationale: ${a.rationale}`);
        }
      }
    }

    const invoices = e.extracted_content?.invoices ?? [];
    if (invoices.length > 0) {
      parts.push(``);
      parts.push(`**Proposed invoices:**`);
      for (const inv of invoices) {
        parts.push(
          `- ${inv.vendor_name} (${inv.invoice_date}): $${inv.total_aud.toLocaleString()} AUD`,
        );
        if (inv.line_items.length > 0) {
          for (const li of inv.line_items.slice(0, 5)) {
            parts.push(`  - ${li.description}: $${li.amount_aud.toLocaleString()}`);
          }
        }
      }
    }

    return parts.join('\n');
  });

  return [
    `# AusIndustry R&D Tax Incentive Application Draft`,
    ``,
    `## Applicant`,
    `- Name: ${input.applicant.name}`,
    `- ABN: ${input.applicant.abn ?? '(to be confirmed by client)'}`,
    ``,
    `## Income year`,
    input.income_year,
    ``,
    `## Project`,
    `- Name: ${input.project.name}`,
    `- Started: ${input.project.started_at}`,
    `- Ended: ${input.project.ended_at ?? '(ongoing)'}`,
    `- Description: ${input.project.description ?? '(see evidence)'}`,
    ``,
    `## Evidence chain (${input.events.length} events, ordered chronologically)`,
    ``,
    ...eventBlocks,
    ``,
    `---`,
    ``,
    `Now produce the complete portal-ready application via a single call to`,
    `the \`draft_application\` tool. Follow every depth, citation, and`,
    `statutory-anchor requirement in the system prompt. Do not omit fields.`,
    `Do not invent citations.`,
  ].join('\n');
}
