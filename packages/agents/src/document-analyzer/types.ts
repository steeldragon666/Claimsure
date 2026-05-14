import { z } from 'zod';

/**
 * Generous upper bound for prose fields produced by the document analyzer.
 *
 * Background: the original schema capped rationale at 500 chars and
 * source_excerpt at 300, which caused Haiku to fail validation with
 * `too_big` whenever it produced longer reasoning or quoted a paragraph
 * verbatim from the source document. The AusIndustry gold exemplar shows
 * the model SHOULD produce 2,000–2,400 char paragraphs in many fields, so
 * the previous limits were strangling output quality.
 *
 * 30,000 chars ≈ 5,000 words ≈ a full paragraph from a research paper.
 * Comfortably above what AusIndustry's portal accepts in a single field
 * (4,000), but generous enough that we never have to revisit limits when
 * a future agent variant produces richer output. The model's own
 * max_tokens cap (8,192 tokens ≈ 32k chars) is the real backstop.
 */
const MAX_PROSE = 30_000;

/**
 * A single proposed R&D activity extracted from a document.
 *
 * The analyzer surfaces activities that look like genuine R&D undertakings:
 * hypothesis text, technical uncertainty, and systematic investigation.
 * Each proposal carries a confidence score and a verbatim source excerpt
 * so consultants can judge provenance without re-reading the document.
 */
export const ProposedActivityExtract = z.object({
  proposed_name: z.string().min(1).max(200),
  proposed_kind: z.enum(['core', 'supporting']),
  hypothesis_text: z.string().min(1).max(MAX_PROSE),
  technical_uncertainty: z.string().min(1).max(MAX_PROSE),
  expected_outcome: z.string().min(1).max(MAX_PROSE),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(MAX_PROSE),
  source_excerpt: z.string().min(1).max(MAX_PROSE),
});
export type ProposedActivityExtract = z.infer<typeof ProposedActivityExtract>;

/**
 * A single invoice / expenditure record extracted from a document.
 *
 * Only proposed when there is a clear vendor + amount + date. The analyzer
 * extracts structured invoice records from spreadsheets, expenditure logs,
 * and vendor PDFs.
 */
export const ProposedInvoiceExtract = z.object({
  vendor_name: z.string().min(1).max(200),
  invoice_date: z.string().min(1).max(30),
  amount_aud: z.number().nonnegative(),
  gst_aud: z.number().nonnegative().nullable(),
  total_aud: z.number().nonnegative(),
  invoice_number: z.string().max(100).nullable(),
  line_items: z.array(
    z.object({
      description: z.string().min(1).max(MAX_PROSE),
      amount_aud: z.number().nonnegative(),
    }),
  ),
  confidence: z.number().min(0).max(1),
  source_excerpt: z.string().min(1).max(MAX_PROSE),
});
export type ProposedInvoiceExtract = z.infer<typeof ProposedInvoiceExtract>;

/**
 * Full output from the document-analyzer agent.
 *
 * Both arrays may be empty (not every document contains R&D activities or
 * invoice data). document_summary is always present — a 2-3 sentence
 * description of what the document contains.
 */
export const DocumentAnalyzerOutput = z.object({
  activities: z.array(ProposedActivityExtract),
  invoices: z.array(ProposedInvoiceExtract),
  document_summary: z.string().min(1).max(MAX_PROSE),
});
export type DocumentAnalyzerOutput = z.infer<typeof DocumentAnalyzerOutput>;

/**
 * Input to the document-analyzer agent.
 *
 * filename, mime_type: metadata surfaced in the prompt so the model
 *   understands the document type and can make better extraction decisions.
 * raw_text: the plain text extracted client-side (mammoth/pdfjs/xlsx).
 * existing_activities: the claim's current activities so the model can
 *   deduplicate proposals against already-registered activities.
 */
export type DocumentAnalyzerInput = {
  filename: string;
  mime_type: string;
  raw_text: string;
  existing_activities: Array<{
    code: string;
    kind: 'core' | 'supporting';
    title: string;
    hypothesis: string | null;
  }>;
};

/**
 * Token usage report attached to every real (non-stub) agent call.
 *
 * Stub implementations return `null` here — they don't consume tokens
 * so there's nothing to ledger.
 *
 * The model id is captured at call time (NOT a constant) because env
 * overrides like DOCUMENT_ANALYZER_MODEL can swap the model per-deploy;
 * the ledger row must record what was ACTUALLY billed, not what the
 * code defaults to.
 */
export type AgentUsage = {
  model: string;
  tokens_in: number;
  tokens_out: number;
};

export interface DocumentAnalyzerResult {
  output: DocumentAnalyzerOutput;
  usage: AgentUsage | null;
}

export interface DocumentAnalyzer {
  analyze(input: DocumentAnalyzerInput): Promise<DocumentAnalyzerResult>;
}
