import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { getSigningRequest, type SigningStatus } from '../../../src/api-client/signing.js';
import { useTheme } from '../../../src/branding/use-theme.js';

/**
 * Mobile signing screen (T-B7).
 *
 * Opens the DocuSign signing URL in expo-web-browser (system Safari /
 * Chrome custom tab) rather than a WebView. DocuSign's signing flow
 * actively breaks in WebView — they fingerprint the user agent and
 * may refuse the session — and the system browser keeps the user's
 * existing DocuSign credentials available, which is the smoother UX.
 *
 * After the browser closes (the user dismissed it, finished signing,
 * or navigated away), we re-fetch the signing request to surface the
 * latest status. The server is the source of truth — DocuSign's
 * webhook updates the request row, our GET picks up the change. No
 * client-side polling; we trust the user closing the browser as the
 * "check now" trigger.
 *
 * Note on availability: GET /v1/signing/:id lives in the p3b worktree
 * (B6) and isn't merged into p3 yet. This screen ships its UI shell
 * here so post-merge the wiring is complete; before merge, the GET
 * 404s and the screen shows the error state.
 */
type ScreenState =
  | { kind: 'loading' }
  | { kind: 'ready'; signingUrl: string | null }
  | { kind: 'completed'; status: SigningStatus }
  | { kind: 'error'; message: string };

export default function SigningScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });

  // Loaded once on mount + once after the browser closes — see
  // `handleOpen` for the post-close re-fetch. The effect deliberately
  // doesn't poll while the browser is open; iOS suspends RN JS while
  // SafariViewController is foregrounded so polling would be ineffective.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await getSigningRequest(id);
        if (cancelled) return;
        if (r.status === 'completed' || r.status === 'declined' || r.status === 'voided') {
          setState({ kind: 'completed', status: r.status });
          return;
        }
        setState({ kind: 'ready', signingUrl: r.signing_url });
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: e instanceof Error ? e.message : 'Could not load signing request',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleOpen(): Promise<void> {
    if (state.kind !== 'ready' || !state.signingUrl) return;
    await WebBrowser.openBrowserAsync(state.signingUrl);
    if (!id) return;
    // After the browser dismiss, re-check the status. Best-effort —
    // a transient network blip just leaves the user on the "open"
    // screen; tapping again repeats the round-trip.
    try {
      const r = await getSigningRequest(id);
      if (r.status === 'completed' || r.status === 'declined' || r.status === 'voided') {
        setState({ kind: 'completed', status: r.status });
      }
    } catch {
      // Swallow — keep the existing 'ready' state and let the user retry.
    }
  }

  if (state.kind === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (state.kind === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{state.message}</Text>
      </View>
    );
  }
  if (state.kind === 'completed') {
    const message =
      state.status === 'completed' ? 'Signed' : state.status === 'declined' ? 'Declined' : 'Voided';
    return (
      <View style={styles.center}>
        <Text style={styles.completed}>{message}</Text>
        <Pressable
          onPress={() => router.push('/')}
          style={[styles.primary, { backgroundColor: theme.primary_color }]}
        >
          <Text style={styles.primaryLabel}>Back to home</Text>
        </Pressable>
      </View>
    );
  }
  // ready
  if (!state.signingUrl) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Signing URL not available yet — try again shortly.</Text>
      </View>
    );
  }
  return (
    <View style={styles.body}>
      <Text style={styles.body_label}>You have a document to sign.</Text>
      <Pressable
        onPress={() => void handleOpen()}
        style={[styles.primary, { backgroundColor: theme.primary_color }]}
      >
        <Text style={styles.primaryLabel}>Open signing</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  body: { flex: 1, justifyContent: 'center', padding: 24 },
  body_label: { fontSize: 16, marginBottom: 16 },
  error: { color: '#dc2626', fontSize: 14, textAlign: 'center' },
  completed: { fontSize: 18, fontWeight: '600', marginBottom: 16 },
  primary: {
    padding: 16,
    borderRadius: 8,
  },
  primaryLabel: {
    color: 'white',
    textAlign: 'center',
    fontWeight: '600',
    fontSize: 16,
  },
});
