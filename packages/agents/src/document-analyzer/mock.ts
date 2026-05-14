/**
 * MockDocumentAnalyzer — deterministic analyzer for integration tests.
 *
 * Unlike `StubDocumentAnalyzer` (which always returns empty arrays and
 * usage:null), the mock produces VARIED output AND non-zero token usage
 * based on a SHA-256 hash of the input. Same input → same output every
 * time; different inputs → different outputs.
 *
 * Use this for tests that exercise the FULL pipeline including the
 * token ledger, budget gate, and downstream consumers (drafter, etc.)
 * without making real Anthropic calls.
 *
 * KEY differences from the production Haiku path:
 *   - No external network calls (synchronous-ish promise).
 *   - tokens_in/out are computed deterministically from input length
 *     (chars/4 input, chars/40 output) so ledger arithmetic is
 *     reproducible.
 *   - Output is a fixed schema-valid shape with 1-3 activities, 0-2
 *     invoices, and a 100-200 char summary. The exact contents are
 *     templated from the input filename + hash so tests can pattern-
 *     match assertions.
 */
import { createHash } from 'node:crypto';
import type { DocumentAnalyzer, DocumentAnalyzerInput, DocumentAnalyzerResult } from './types.js';

export interface MockDocumentAnalyzerOptions {
  /** Model name reported in the usage record. Default 'claude-haiku-4-5-mock'. */
  model?: string;
  /**
   * Override input-token computation. Default: ceil(raw_text.length / 4).
   * Useful for tests that need to drive the ledger to a specific total.
   */
  tokensInFn?: (input: DocumentAnalyzerInput) => number;
  /** Override output-token computation. Default: ceil(raw_text.length / 40). */
  tokensOutFn?: (input: DocumentAnalyzerInput) => number;
  /** Force a specific number of activities. Default: derived from hash, 0-3. */
  activitiesCount?: number;
  /** Force a specific number of invoices. Default: derived from hash, 0-2. */
  invoicesCount?: number;
  /**
   * If true, every analyze() call throws — useful for testing error paths
   * in workers that wrap the analyzer in try/catch.
   */
  throwError?: boolean;
}

/**
 * Hash-derived helpers — pure functions of the raw_text so every call
 * with the same input yields the same output.
 */
function hashInt(rawText: string, mod: number): number {
  const h = createHash('sha256').update(rawText).digest('hex');
  return parseInt(h.slice(0, 8), 16) % mod;
}

export class MockDocumentAnalyzer implements DocumentAnalyzer {
  constructor(private readonly opts: MockDocumentAnalyzerOptions = {}) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async analyze(input: DocumentAnalyzerInput): Promise<DocumentAnalyzerResult> {
    if (this.opts.throwError) {
      throw new Error('MockDocumentAnalyzer: configured to throw');
    }

    const model = this.opts.model ?? 'claude-haiku-4-5-mock';
    const tokens_in = this.opts.tokensInFn?.(input) ?? Math.ceil(input.raw_text.length / 4);
    const tokens_out = this.opts.tokensOutFn?.(input) ?? Math.ceil(input.raw_text.length / 40);

    // If the input has fewer than 50 chars of usable text, mimic Haiku's
    // tendency to produce empty activities/invoices for sparse inputs.
    const sparse = input.raw_text.trim().length < 50;

    const activitiesCount = sparse ? 0 : (this.opts.activitiesCount ?? hashInt(input.raw_text, 4)); // 0-3
    const invoicesCount = sparse
      ? 0
      : (this.opts.invoicesCount ?? hashInt(input.raw_text + 'inv', 3)); // 0-2

    const activities = Array.from({ length: activitiesCount }, (_, i) => ({
      proposed_name: `Mock activity ${i + 1} from ${input.filename}`,
      proposed_kind: i === 0 ? ('core' as const) : ('supporting' as const),
      hypothesis_text: `Hypothesis ${i + 1}: the deterministic test fixture produces a falsifiable claim about [domain inferred from filename: ${input.filename}].`,
      technical_uncertainty: `No published technique addresses this combination of inputs. The competent-professional test is satisfied because [domain-specific reasoning derived from hash ${hashInt(input.raw_text, 1000)}].`,
      expected_outcome: `Mock expected outcome ${i + 1} — measurable threshold reached on the validation set.`,
      confidence: 0.7 + hashInt(input.raw_text + String(i), 30) / 100, // 0.70-0.99
      rationale: `Mock rationale for activity ${i + 1}. Derived from text length ${input.raw_text.length}.`,
      source_excerpt: input.raw_text.slice(0, 200),
    }));

    const invoices = Array.from({ length: invoicesCount }, (_, i) => ({
      vendor_name: `MockVendor ${i + 1} Pty Ltd`,
      invoice_date: `2025-1${i}-15`,
      amount_aud: 1000 * (i + 1),
      gst_aud: 100 * (i + 1),
      total_aud: 1100 * (i + 1),
      invoice_number: `INV-MOCK-${i + 1}`,
      line_items: [
        {
          description: `Mock line item ${i + 1}`,
          amount_aud: 1000 * (i + 1),
        },
      ],
      confidence: 0.85,
      source_excerpt: input.raw_text.slice(0, 100),
    }));

    return {
      output: {
        activities,
        invoices,
        document_summary: sparse
          ? `Sparse mock summary: ${input.filename} (${input.raw_text.length} chars, no proposals).`
          : `Mock summary of ${input.filename}: produced ${activities.length} activities and ${invoices.length} invoices from ${input.raw_text.length} chars of input. Domain hash: ${hashInt(input.raw_text, 1000)}.`,
      },
      usage: { model, tokens_in, tokens_out },
    };
  }
}
