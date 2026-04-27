import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import { useCamera, type CapturedPhoto } from '../../../src/hooks/use-camera.js';
import { uploadMedia } from '../../../src/api-client/media.js';

/**
 * Photo capture screen (T-A5).
 *
 * Three-state flow that matches A1's voice screen:
 *
 *   permission-pending → live-camera → preview → uploading → home
 *
 * The upload step is filled in by A6 (`uploadPhoto`); for now the
 * "Submit" button transitions to the uploading state and routes home,
 * with the upload itself a no-op on this commit. A6 swaps the no-op
 * for the real `uploadPhoto(file)` call without restructuring this UI.
 *
 * Permission UX: expo-camera's `useCameraPermissions` returns a
 * 3-state response (granted / undetermined / denied). For undetermined
 * we render a "Tap to grant" CTA; for denied we tell the user to open
 * Settings (Linking deep-link is overkill for v1). Granted falls
 * through to the live preview.
 */
type ScreenState =
  | { kind: 'preview-camera' }
  | { kind: 'previewing'; photo: CapturedPhoto }
  | { kind: 'uploading' };

export default function PhotoCaptureScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const { cameraRef, takePhoto } = useCamera();
  const [state, setState] = useState<ScreenState>({ kind: 'preview-camera' });
  const [error, setError] = useState<string | null>(null);

  // Permission gating. expo-camera recommends rendering the live view
  // only when granted — accessing the camera without it throws on iOS
  // and silently fails on Android.
  if (!permission) {
    // First render before useCameraPermissions has resolved. Render a
    // neutral placeholder rather than null so the layout doesn't jump.
    return (
      <View style={styles.container}>
        <Text style={styles.help}>Loading camera…</Text>
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Camera permission needed</Text>
        <Text style={styles.help}>
          Photos are stored as evidence in your firm's vault. We never access the camera without
          your tap.
        </Text>
        <Pressable
          onPress={() => {
            void requestPermission();
          }}
          style={[styles.action, styles.submit]}
        >
          <Text style={styles.actionLabel}>Grant camera</Text>
        </Pressable>
      </View>
    );
  }

  async function handleShutter(): Promise<void> {
    setError(null);
    try {
      const photo = await takePhoto();
      if (!photo) {
        setError('Capture failed — please try again');
        return;
      }
      setState({ kind: 'previewing', photo });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'capture failed');
    }
  }

  function handleDiscard(): void {
    setState({ kind: 'preview-camera' });
  }

  async function handleSubmit(): Promise<void> {
    if (state.kind !== 'previewing') return;
    const photo = state.photo;
    setState({ kind: 'uploading' });
    try {
      // Stat the file for size_bytes; expo-camera doesn't include it
      // on the CameraCapturedPicture object (it's a single getInfo
      // round-trip and avoids guessing from JPEG dimensions).
      const info = await FileSystem.getInfoAsync(photo.uri, { size: true });
      const size_bytes = info.exists && 'size' in info ? info.size : 0;
      await uploadMedia({
        uri: photo.uri,
        mime_type: 'image/jpeg',
        size_bytes,
        ...(photo.exif ? { exif: photo.exif } : {}),
      });
      router.replace('/(authed)');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed');
      setState({ kind: 'previewing', photo });
    }
  }

  if (state.kind === 'previewing') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Preview</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Image source={{ uri: state.photo.uri }} style={styles.previewImage} resizeMode="contain" />
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
      </View>
    );
  }

  if (state.kind === 'uploading') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Uploading…</Text>
      </View>
    );
  }

  return (
    <View style={styles.cameraContainer}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
      {error ? (
        <View style={styles.errorOverlay}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : null}
      <View style={styles.shutterContainer}>
        <Pressable
          onPress={() => {
            void handleShutter();
          }}
          style={({ pressed }) => [styles.shutterButton, pressed && styles.shutterButtonPressed]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    backgroundColor: 'white',
  },
  cameraContainer: {
    flex: 1,
    backgroundColor: 'black',
  },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 12 },
  error: { color: '#dc2626', marginBottom: 12, textAlign: 'center' },
  errorOverlay: {
    position: 'absolute',
    top: 60,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 12,
    borderRadius: 8,
  },
  help: { fontSize: 14, color: '#666', marginVertical: 12, textAlign: 'center' },
  previewImage: {
    width: '100%',
    flex: 1,
    backgroundColor: '#000',
    marginBottom: 16,
  },
  actions: { flexDirection: 'row', gap: 16, marginTop: 8 },
  action: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  discard: { backgroundColor: '#9ca3af' },
  submit: { backgroundColor: '#10b981' },
  actionLabel: { color: 'white', fontSize: 16, fontWeight: '600' },
  shutterContainer: {
    position: 'absolute',
    bottom: 48,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  shutterButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'white',
    borderWidth: 6,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  shutterButtonPressed: { opacity: 0.7 },
});
