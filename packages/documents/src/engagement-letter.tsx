import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';

/**
 * Engagement-letter PDF renderer (Wizard Step 1, Task 03).
 *
 * Renders the verbatim `engagement_letter.rendered_markdown` snapshot
 * (captured at send time, never re-templated) into an A4 PDF for legal
 * archival. Lives in `@cpa/documents` alongside the other claim-side
 * report PDFs (activity-application, claim-summary, apportionment,
 * compliance-notes, etc.) so the api worker stays a `.ts` file —
 * keeping JSX inside this package matches the codebase convention.
 *
 * ## Markdown
 *
 * The template surface is a closed-system markdown subset:
 *   - `#`/`##`/`###` ATX headings
 *   - blank-line separated paragraphs
 *   - `**bold**` markers are kept verbatim (auditor-facing PDF stays
 *     byte-faithful to the signed text — see job module JSDoc)
 *
 * Consciously NOT a full GFM parser. The firm-side admin controls the
 * template via `tenant.engagement_letter_template_md`; loosening to
 * link/HTML support would widen the attack surface without a real
 * driver. If GFM is ever needed, swap `markdownToBlocks` for `marked`
 * or `markdown-it` — none of the rest of the renderer changes.
 *
 * ## Signature block
 *
 * When `signedAt` is non-null the renderer appends a signature block
 * with typed-name, ISO timestamp and (optionally) source IP. The job
 * always populates this block — the PDF is only rendered after the
 * claimant signs.
 */

// ---------------------------------------------------------------------------
// Markdown -> block tree
// ---------------------------------------------------------------------------

export type EngagementLetterBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string };

const H3_RE = /^###\s+(.+)$/;
const H2_RE = /^##\s+(.+)$/;
const H1_RE = /^#\s+(.+)$/;

export function markdownToBlocks(md: string): EngagementLetterBlock[] {
  const blocks: EngagementLetterBlock[] = [];
  const paragraphLines: string[] = [];
  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    blocks.push({ kind: 'paragraph', text: paragraphLines.join(' ') });
    paragraphLines.length = 0;
  };

  for (const rawLine of md.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    const h3 = line.match(H3_RE);
    if (h3) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: 3, text: h3[1]! });
      continue;
    }
    const h2 = line.match(H2_RE);
    if (h2) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: 2, text: h2[1]! });
      continue;
    }
    const h1 = line.match(H1_RE);
    if (h1) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: 1, text: h1[1]! });
      continue;
    }
    paragraphLines.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  page: { padding: 48, fontFamily: 'Helvetica', fontSize: 11, lineHeight: 1.5 },
  header: {
    marginBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1814',
    paddingBottom: 8,
  },
  headerTitle: { fontSize: 16, fontFamily: 'Helvetica-Bold' },
  headerSub: { fontSize: 9, color: '#666666', marginTop: 4 },
  h1: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginTop: 14, marginBottom: 6 },
  h2: { fontSize: 12, fontFamily: 'Helvetica-Bold', marginTop: 12, marginBottom: 4 },
  h3: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginTop: 10, marginBottom: 4 },
  paragraph: { marginBottom: 8 },
  signatureBlock: {
    marginTop: 24,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#cccccc',
  },
  signatureLine: { marginBottom: 4 },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 48,
    right: 48,
    borderTopWidth: 1,
    borderTopColor: '#cccccc',
    paddingTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: '#666666',
  },
});

export interface EngagementLetterPdfInput {
  firmName: string;
  claimantName: string | null;
  templateVersion: string;
  engagementLetterId: string;
  renderedMarkdown: string;
  signedAt: Date | null;
  signedByClaimantName: string | null;
  signedByClaimantIp: string | null;
  generatedAt: Date;
}

function EngagementLetterPdfDocument(props: { input: EngagementLetterPdfInput }) {
  const { input } = props;
  const blocks = markdownToBlocks(input.renderedMarkdown);
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Engagement Letter</Text>
          <Text style={styles.headerSub}>
            {input.firmName}
            {input.claimantName ? ` · ${input.claimantName}` : ''}
            {` · template ${input.templateVersion}`}
          </Text>
        </View>
        {blocks.map((block, idx) => {
          if (block.kind === 'heading') {
            const style = block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
            return (
              <Text key={`b${idx}`} style={style}>
                {block.text}
              </Text>
            );
          }
          return (
            <Text key={`b${idx}`} style={styles.paragraph}>
              {block.text}
            </Text>
          );
        })}
        {input.signedAt !== null ? (
          <View style={styles.signatureBlock}>
            <Text style={styles.signatureLine}>
              Signed by: {input.signedByClaimantName ?? '(name not captured)'}
            </Text>
            <Text style={styles.signatureLine}>Signed at: {input.signedAt.toISOString()}</Text>
            {input.signedByClaimantIp ? (
              <Text style={styles.signatureLine}>Signed from IP: {input.signedByClaimantIp}</Text>
            ) : null}
          </View>
        ) : null}
        <View style={styles.footer} fixed>
          <Text>Generated {input.generatedAt.toISOString()}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
          <Text>Letter id: {input.engagementLetterId.slice(0, 8)}…</Text>
        </View>
      </Page>
    </Document>
  );
}

/**
 * Render an engagement letter to PDF bytes. Returns a Uint8Array so
 * the public surface stays Node-Buffer-free (callers can convert to
 * Buffer with `Buffer.from(pdf)` at the boundary).
 */
export async function renderEngagementLetterPdf(
  input: EngagementLetterPdfInput,
): Promise<Uint8Array> {
  const buf = await renderToBuffer(<EngagementLetterPdfDocument input={input} />);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
