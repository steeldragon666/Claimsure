import { useRef } from 'react';
// `CameraView` is referenced exclusively as a TS generic (useRef<CameraView>,
// React.RefObject<CameraView | null>) — never as a value/JSX in this file —
// so both imports are type-only. The screen that mounts <CameraView>
// (apps/mobile/app/(authed)/capture/photo.tsx) imports it separately as a
// value.
import type { CameraView, CameraCapturedPicture } from 'expo-camera';

/**
 * Photo capture returned from the camera hook.
 *
 * `uri` is a `file://` path to the JPEG written to the cache directory by
 * expo-camera. The upload pipeline (A6) reads bytes from there and feeds
 * them through the pre-signed S3 PUT.
 *
 * `width` / `height` come from the JPEG header; useful for optional
 * client-side preview thumbnails. `exif` is the raw camera-metadata
 * dictionary (orientation, GPS, capture device) — left as `unknown` here
 * because the schema differs across iOS / Android / SDK versions, and
 * the API's media_artefact.exif column is `jsonb` (anything serialisable).
 */
export type CapturedPhoto = {
  uri: string;
  width: number;
  height: number;
  /**
   * Raw EXIF dictionary as returned by expo-camera. Present only when
   * `takePictureAsync({ exif: true })` succeeded — some Android camera2
   * implementations silently drop the block on low-end devices.
   */
  exif: Record<string, unknown> | null;
};

/**
 * useCamera — thin wrapper around `<CameraView>` for the A5 capture
 * screen.
 *
 * SDK 51 dropped the legacy `Camera` class in favour of the imperative
 * `CameraView` component + ref. The takePicture API moved to an
 * instance method on the ref; permission requests now go through
 * `useCameraPermissions()` which the screen owns directly (since it
 * needs to render permission-prompt UI on denial).
 *
 * Quality: 0.85 is the sweet spot for evidence-grade photos — visibly
 * indistinguishable from 1.0 to a human reviewer, but ~30% smaller on
 * disk. We're paying the upload bandwidth so the trade matters.
 *
 * `exif: true` preserves GPS + device metadata, which the assurance
 * report (P5) uses for evidence-quality scoring.
 *
 * `skipProcessing: false` lets expo-camera correct rotation server-
 * side — without it, an iPhone shot in portrait orientation comes
 * back rotated 90deg with EXIF orientation=6, which the consultant
 * UI then has to re-rotate. Better to bake it in once.
 */
export function useCamera(): {
  cameraRef: React.RefObject<CameraView | null>;
  takePhoto: () => Promise<CapturedPhoto | null>;
} {
  const ref = useRef<CameraView>(null);

  async function takePhoto(): Promise<CapturedPhoto | null> {
    if (!ref.current) return null;
    const pic: CameraCapturedPicture | undefined = await ref.current.takePictureAsync({
      quality: 0.85,
      exif: true,
      skipProcessing: false,
    });
    if (!pic) return null;
    // expo-camera's CameraCapturedPicture.exif is typed as `any` in SDK
    // 51 since the shape varies wildly across platforms; coerce to a
    // record-of-unknown so callers must JSON-validate before persistence.
    const rawExif = (pic as { exif?: unknown }).exif;
    const exif: Record<string, unknown> | null =
      rawExif && typeof rawExif === 'object' && !Array.isArray(rawExif)
        ? (rawExif as Record<string, unknown>)
        : null;
    return {
      uri: pic.uri,
      width: pic.width,
      height: pic.height,
      exif,
    };
  }

  return { cameraRef: ref, takePhoto };
}
