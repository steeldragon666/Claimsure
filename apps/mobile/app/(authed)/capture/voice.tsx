import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useVoiceRecorder, type VoiceRecording } from '../../../src/hooks/use-voice-recorder.js';
import { enqueueVoiceEvent } from '../../../src/api-client/events.js';
import { useTheme } from '../../../src/branding/use-theme.js';

/**
 * Voice capture screen (T-A1).
 *
 * Tap-to-record / tap-to-stop with a 30-second hard cap (the auto-stop
 * fires the same code path as a manual stop). Once recorded, the user
 * sees the duration + a "Submit" button; pressing it enqueues the
 * event in the local SQLite queue and routes back to home. The F14
 * worker drains it on the next pass once A4's dispatcher lands.
 *
 * No waveform yet — that's a Swimlane-B polish task. The duration
 * counter ticks while recording so the user knows they're being heard.
 *
 * State machine (local):
 *   idle → recording → previewing → submitting → idle
 */
const MAX_DURATION_MS = 30_000;

type ScreenState =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAt: number; elapsedMs: number }
  | { kind: 'previewing'; recording: VoiceRecording }
  | { kind: 'submitting' };

export default function VoiceCaptureScreen() {
  const router = useRouter();
  const recorder = useVoiceRecorder();
  const theme = useTheme();
  const [state, setState] = useState<ScreenState>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tick the elapsed counter while recording. Re-runs whenever the
  // state-machine transitions in or out of 'recording'; the cleanup
  // clears the interval on stop / unmount.
  useEffect(() => {
    if (state.kind !== 'recording') return undefined;
    const startedAt = state.startedAt;
    const interval = setInterval(() => {
      setState((s) => (s.kind === 'recording' ? { ...s, elapsedMs: Date.now() - startedAt } : s));
    }, 100);
    return () => clearInterval(interval);
  }, [state.kind, state.kind === 'recording' ? state.startedAt : null]);

  async function handleStop(): Promise<void> {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    try {
      const rec = await recorder.stop();
      if (!rec) {
        setError('Recording failed — please try again');
        setState({ kind: 'idle' });
        return;
      }
      setState({ kind: 'previewing', recording: rec });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown error');
      setState({ kind: 'idle' });
    }
  }

  async function handleStart(): Promise<void> {
    setError(null);
    try {
      await recorder.start();
      setState({ kind: 'recording', startedAt: Date.now(), elapsedMs: 0 });
      // Hard cap at 30s — fires the same handleStop path as a manual tap.
      stopTimerRef.current = setTimeout(() => {
        void handleStop();
      }, MAX_DURATION_MS);
    } catch (e) {
      setError(
        e instanceof Error ? `${e.message} — check microphone permission` : 'mic permission denied',
      );
    }
  }

  async function handleSubmit(): Promise<void> {
    if (state.kind !== 'previewing') return;
    const rec = state.recording;
    setState({ kind: 'submitting' });
    try {
      await enqueueVoiceEvent({
        audio_uri: rec.uri,
        audio_mime_type: rec.mime_type,
        duration_ms: rec.duration_ms,
        captured_at_local: Date.now(),
      });
      router.replace('/(authed)');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'enqueue failed');
      setState({ kind: 'previewing', recording: rec });
    }
  }

  function handleDiscard(): void {
    setState({ kind: 'idle' });
  }

  // Big circular record button. Colour flips between a red "stop" and
  // a primary-colour "record" depending on state. The expandable
  // active-recording variant shows the elapsed counter inside the
  // circle; pre/post recording it shows static labels.
  // Wrap the async handlers in void-returning thunks so the JSX onPress
  // attribute (which expects `() => void`) doesn't trip
  // @typescript-eslint/no-misused-promises. The promise is intentionally
  // floated — the recorder's start/stop methods drive their own state.
  const tapping =
    state.kind === 'idle'
      ? (): void => {
          void handleStart();
        }
      : state.kind === 'recording'
        ? (): void => {
            void handleStop();
          }
        : undefined;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Voice capture</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        onPress={tapping}
        disabled={state.kind === 'previewing' || state.kind === 'submitting'}
        style={({ pressed }) => [
          styles.recordButton,
          { backgroundColor: theme.primary_color },
          state.kind === 'recording' && styles.recordButtonActive,
          pressed && styles.recordButtonPressed,
        ]}
      >
        <Text style={styles.recordLabel}>
          {state.kind === 'idle'
            ? 'Tap to record'
            : state.kind === 'recording'
              ? `${Math.round(state.elapsedMs / 1000)}s`
              : state.kind === 'previewing'
                ? `${Math.round(state.recording.duration_ms / 1000)}s`
                : '...'}
        </Text>
      </Pressable>

      {state.kind === 'previewing' ? (
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
            <Text style={styles.actionLabel}>Submit</Text>
          </Pressable>
        </View>
      ) : null}

      <Text style={styles.help}>
        {state.kind === 'recording'
          ? `Auto-stops at ${MAX_DURATION_MS / 1000}s`
          : 'Tap the circle to capture a voice note'}
      </Text>
    </View>
  );
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
  recordButton: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: '#0066cc',
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 32,
  },
  recordButtonActive: { backgroundColor: '#dc2626' },
  recordButtonPressed: { opacity: 0.85 },
  recordLabel: { color: 'white', fontSize: 18, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 16, marginTop: 8 },
  action: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  discard: { backgroundColor: '#9ca3af' },
  submit: { backgroundColor: '#10b981' },
  actionLabel: { color: 'white', fontSize: 16, fontWeight: '600' },
  help: { fontSize: 12, color: '#666', marginTop: 16, textAlign: 'center' },
});
