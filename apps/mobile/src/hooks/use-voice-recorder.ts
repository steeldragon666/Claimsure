import { useEffect, useState } from 'react';
import { Audio } from 'expo-av';

/**
 * Local-only shape returned by the recorder when the user taps stop.
 *
 * The `size_bytes` field is left as 0 here — it's filled in by the
 * upload pipeline once the file lands in S3 (or stays 0 for the v1
 * placeholder path until A4 wires real bytes through). Callers
 * shouldn't rely on it pre-upload.
 *
 * `mime_type` is hard-coded to `audio/m4a` because the HIGH_QUALITY
 * preset on both iOS and Android emits an mp4-container AAC track,
 * and Deepgram's nova-3 endpoint accepts that under the audio/m4a
 * Content-Type. Future work that swaps presets must update this.
 */
export type VoiceRecording = {
  uri: string;
  duration_ms: number;
  mime_type: string;
  size_bytes: number;
};

/**
 * useVoiceRecorder — hook around Audio.Recording for the A1 capture
 * screen.
 *
 * Lifecycle:
 *   - Mount:    request mic permission + flip the audio session into
 *               record-mode (otherwise iOS silent-switch silences the
 *               recording too).
 *   - start():  prepareToRecordAsync(HIGH_QUALITY) → startAsync().
 *               Returns void; consumers read `isRecording` to update
 *               UI affordances.
 *   - stop():   stopAndUnloadAsync → snapshot the status →
 *               return a VoiceRecording. If the status comes back
 *               not-done (rare, usually the user double-tapped),
 *               return null so the caller can show a retry UI.
 *
 * Permission denial isn't surfaced as an error — start() will simply
 * fail when prepareToRecordAsync runs. The screen wraps the start
 * call in try/catch and shows a settings-deeplink hint.
 */
export function useVoiceRecorder(): {
  isRecording: boolean;
  start: () => Promise<void>;
  stop: () => Promise<VoiceRecording | null>;
} {
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    // Fire-and-forget: requestPermissionsAsync resolves with the
    // granted state, but we don't gate the hook on it — start() will
    // fail loudly if the user denied. This avoids a spinner on first
    // mount of the capture screen for the common-case "already
    // granted" path.
    void Audio.requestPermissionsAsync();
    void Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
  }, []);

  async function start(): Promise<void> {
    const r = new Audio.Recording();
    await r.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    await r.startAsync();
    setRecording(r);
    setIsRecording(true);
  }

  async function stop(): Promise<VoiceRecording | null> {
    if (!recording) return null;
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    const status = await recording.getStatusAsync();
    setRecording(null);
    setIsRecording(false);
    if (!uri || !status.isDoneRecording) return null;
    return {
      uri,
      duration_ms: status.durationMillis ?? 0,
      mime_type: 'audio/m4a',
      // size_bytes filled in by the upload pipeline post-A4.
      size_bytes: 0,
    };
  }

  return { isRecording, start, stop };
}
