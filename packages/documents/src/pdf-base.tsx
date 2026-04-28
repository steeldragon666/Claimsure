import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { ReactNode } from 'react';

/**
 * Shared layout for all P4-generated PDFs.
 *
 * - Header: title + claimant name + fiscal year
 * - Body: caller-provided children
 * - Footer: page number, generated-at timestamp, content hash (truncated)
 *
 * The content hash links the PDF back to its source data — auditors can
 * verify reproducibility by recomputing `contentHash(inputData)` and
 * comparing the prefix shown on every page.
 *
 * Page size A4 (matches AusIndustry portal expectations and KPMG
 * letterhead conventions).
 */
export type DocumentLayoutProps = {
  title: string;
  claimantName: string;
  fiscalYear: number;
  contentHashHex: string;
  generatedAt: Date;
  children: ReactNode;
};

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: 'Helvetica', fontSize: 10 },
  header: {
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#cccccc',
    paddingBottom: 8,
  },
  title: { fontSize: 16, fontWeight: 'bold' },
  subtitle: { fontSize: 10, color: '#666666', marginTop: 4 },
  content: { flex: 1 },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: '#cccccc',
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: '#666666',
  },
});

export function DocumentLayout(props: DocumentLayoutProps) {
  const hashShort = props.contentHashHex.slice(0, 12);
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>{props.title}</Text>
          <Text style={styles.subtitle}>
            {props.claimantName} · FY{props.fiscalYear}
          </Text>
        </View>
        <View style={styles.content}>{props.children}</View>
        <View style={styles.footer} fixed>
          <Text>Generated {props.generatedAt.toISOString()}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
          <Text>Content hash: {hashShort}…</Text>
        </View>
      </Page>
    </Document>
  );
}
