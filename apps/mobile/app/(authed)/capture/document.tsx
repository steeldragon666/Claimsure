import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { uploadMedia } from '../../../src/api-client/media.js';

/**
 * Document capture screen (T-A7).
 *
 * Single-tap "Pick a document" button → native picker → preview the
 * filename / size → submit/discard. Reuses the A6 upload pipeline
 * (`uploadMedia`) — only the file source differs.
 *
 * Accepted MIME types:
 *   - `application/pdf`         (the bulk: tax invoices, lab reports)
 *   - `image/*`                 (scanned receipts, whiteboard photos)
 *   - `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
 *     (.docx — DOC isn't in the modern Office MIME tree, drop it)
 *
 * Other types (text/plain, .xlsx) are filtered by the system picker
 * itself; we don't surface them as a server-side reject because the
 * server-side `presigned-upload` schema accepts `application/*` more
 * broadly to support PDFs without enumerating every Office variant.
 *
 * `copyToCacheDirectory: true` is required so `expo-file-system` can
 * read the bytes for the SHA-256 hash compute. On iOS, picking from
 * iCloud Drive without copy returns a security-scoped URL we can't
 * read directly.
 */
const ACCEPTED_TYPES = [
  'application/pdf',
  'image/*',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

type ScreenState =
  | { kind: 'idle' }
  | {
      kind: 'previewing';
      asset: DocumentPicker.DocumentPickerAsset;
    }
  | { kind: 'uploading' };

export default function DocumentCaptureScreen() {
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  async function handlePick(): Promise<void> {
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ACCEPTED_TYPES,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) {
        setError('Picker returned no asset');
        return;
      }
      // The picker doesn't always populate size on Android; the server
      // caps at 50 MB regardless, so we set a reasonable upper bound
      // here for UX (banner before the round-trip).
      if (asset.size && asset.size > 50 * 1024 * 1024) {
        setError('Document is larger than 50 MB');
        return;
      }
      setState({ kind: 'previewing', asset });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'pick failed');
    }
  }

  function handleDiscard(): void {
    setState({ kind: 'idle' });
  }

  async function handleSubmit(): Promise<void> {
    if (state.kind !== 'previewing') return;
    const asset = state.asset;
    setState({ kind: 'uploading' });
    try {
      await uploadMedia({
        uri: asset.uri,
        mime_type: asset.mimeType ?? 'application/octet-stream',
        size_bytes: asset.size ?? 0,
      });
      router.replace('/(authed)');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed');
      setState({ kind: 'previewing', asset });
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Document upload</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {state.kind === 'idle' ? (
        <>
          <Text style={styles.help}>Pick a PDF, image, or Word document from your device.</Text>
          <Pressable
            onPress={() => {
              void handlePick();
            }}
            style={[styles.action, styles.submit]}
          >
            <Text style={styles.actionLabel}>Pick a document</Text>
          </Pressable>
        </>
      ) : null}

      {state.kind === 'previewing' ? (
        <>
          <View style={styles.previewBox}>
            <Text style={styles.previewName} numberOfLines={2}>
              {state.asset.name}
            </Text>
            <Text style={styles.previewMeta}>
              {state.asset.mimeType ?? 'unknown'} ·{' '}
              {state.asset.size ? formatBytes(state.asset.size) : 'unknown size'}
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable onPress={handleDiscard} style={[styles.action, styles.discard]}>
              <Text style={styles.actionLabel}>Discard</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void handleSubmit();
              }}
              style={[styles.action, styles.submit]}
            >
              <Text style={styles.actionLabel}>Upload</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {state.kind === 'uploading' ? <Text style={styles.help}>Uploading…</Text> : null}
    </View>
  );
}

/**
 * Human-readable byte count: 1.2 MB, 856 KB, 12 B.
 *
 * Inlined here rather than pulling a util — only used in this file.
 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 12 },
  error: { color: '#dc2626', marginBottom: 12, textAlign: 'center' },
  help: { fontSize: 14, color: '#666', marginVertical: 16, textAlign: 'center' },
  previewBox: {
    width: '100%',
    padding: 16,
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    marginVertical: 16,
  },
  previewName: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
  previewMeta: { fontSize: 13, color: '#6b7280' },
  actions: { flexDirection: 'row', gap: 16, marginTop: 8 },
  action: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    minWidth: 140,
    alignItems: 'center',
  },
  discard: { backgroundColor: '#9ca3af' },
  submit: { backgroundColor: '#10b981' },
  actionLabel: { color: 'white', fontSize: 16, fontWeight: '600' },
});
