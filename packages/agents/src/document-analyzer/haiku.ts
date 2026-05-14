import { getAnthropicClient } from '../runtime/anthropic-client.js';
import { getPrompt } from '../runtime/prompt-registry.js';
import { callWithToolUse } from '../runtime/tool-use.js';
import './prompts/analyze-document@1.0.0.js'; // side-effect: registers the prompt
import type { DocumentAnalyzer, DocumentAnalyzerInput, DocumentAnalyzerResult } from './types.js';
import type { AnalyzeDocumentToolOutput } from './prompts/analyze-document@1.0.0.js';

const MODEL = process.env.DOCUMENT_ANALYZER_MODEL ?? 'claude-haiku-4-5';
const PROMPT_KEY = 'analyze-document@1.0.0';

// 8 192 tokens should cover most work-package documents and invoice schedules
// without hitting the 100k-token context limit. The extraction prompt is rich
// but the tool schema is well-defined, so the model shouldn't need much space
// to fill in the structured output.
const MAX_TOKENS = 8192;

// Truncate raw_text to roughly 60 000 characters (well within Haiku's
// 200k context window even with the system prompt overhead). This covers
// a 50-page PDF comfortably.
const MAX_TEXT_CHARS = 60_000;

/**
 * Production document analyzer backed by the Anthropic SDK + Claude Haiku.
 *
 * The side-effect import above registers the prompt before the first
 * analyze() call; without it `getPrompt(PROMPT_KEY)` throws.
 */
export class HaikuDocumentAnalyzer implements DocumentAnalyzer {
  async analyze(input: DocumentAnalyzerInput): Promise<DocumentAnalyzerResult> {
    // DIAG: prove this class is actually running for each call.
    const callId = Math.random().toString(36).slice(2, 8);
    console.log(
      '[HaikuDocumentAnalyzer][DIAG]',
      JSON.stringify({
        callId,
        filename: input.filename,
        textLen: input.raw_text.length,
        existingActivities: input.existing_activities.length,
        startedAt: new Date().toISOString(),
      }),
    );
    const prompt = getPrompt<AnalyzeDocumentToolOutput>(PROMPT_KEY);

    const truncatedText =
      input.raw_text.length > MAX_TEXT_CHARS
        ? input.raw_text.slice(0, MAX_TEXT_CHARS) +
          `\n\n[Document truncated at ${MAX_TEXT_CHARS} chars — ${input.raw_text.length - MAX_TEXT_CHARS} additional chars omitted]`
        : input.raw_text;

    const existingActivitiesList =
      input.existing_activities.length > 0
        ? input.existing_activities
            .map(
              (a) =>
                `- code: ${a.code} | kind: ${a.kind} | title: ${a.title}${a.hypothesis ? ` | hypothesis: ${a.hypothesis.slice(0, 120)}` : ''}`,
            )
            .join('\n')
        : '(none registered yet)';

    const userMessage = [
      `## Document: ${input.filename}`,
      `## MIME type: ${input.mime_type}`,
      ``,
      `## Already-registered activities (do not re-propose these)`,
      existingActivitiesList,
      ``,
      `## Document text`,
      truncatedText,
    ].join('\n');

    const { output, tokens_in, tokens_out } = await callWithToolUse(getAnthropicClient(), {
      model: MODEL,
      system: prompt.system,
      user: userMessage,
      tool: prompt.tool,
      max_tokens: MAX_TOKENS,
    });

    return {
      output: {
        activities: output.activities,
        invoices: output.invoices,
        document_summary: output.document_summary,
      },
      usage: { model: MODEL, tokens_in, tokens_out },
    };
  }
}
