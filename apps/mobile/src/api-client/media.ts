import * as FileSystem from 'expo-file-system';
import { getApiBaseUrl } from '../auth/redeem.js';
import { useSessionStore } from '../auth/session-store.js';
import type { MediaArtefact } from '@cpa/schemas';

/**
 * Mobile-side media upload client (T-A6, T-A7).
 *
 * Three-step flow that mirrors the API contract:
 *   1. Hash the file bytes locally (SHA-256, hex).
 *   2. POST /v1/media/presigned-upload — receive an S3 PUT URL.
 *   3. PUT bytes (best-effort in v1; the placeholder URL won't accept
 *      the upload — we swallow the error so finalize still runs).
 *   4. POST /v1/media/finalize — server inserts the media_artefact row.
 *
 * The captured photo's local file:// URI is read once for the hash
 * (base64 → digest) and reused at the PUT step; we never copy bytes
 * through JS memory beyond the hash compute.
 *
 * If the API contract evolves to a single-call upload (rare — most
 * "vault" services keep the presign / finalize split for direct-to-
 * S3 streaming), this file is the only place that changes.
 */

/** What the photo / document picker hands us to upload. */
export type UploadInput = {
  /** Local file:// URI (from Camera or DocumentPicker). */
  uri: string;
  /** MIME type from the picker; falls back to image/jpeg for camera. */
  mime_type: string;
  /** Stat'd size on disk; the API caps at 50 MB. */
  size_bytes: number;
  /** Optional EXIF dictionary from expo-camera. */
  exif?: Record<string, unknown>;
  /** Optional event_id to attach this upload to. */
  event_id?: string;
};

export type UploadResult = {
  media: MediaArtefact;
  /**
   * `duplicate=true` when the finalize was idempotent — the same
   * (tenant, subject, content_hash) row already existed. UI can
   * suppress the "uploaded successfully" toast for this case if it
   * wants distinct UX.
   */
  duplicate: boolean;
};

/**
 * Compute the SHA-256 hash of a file at a `file://` URI.
 *
 * React Native ships with the Web Crypto API on Hermes (RN ≥ 0.74),
 * which is what we're on per package.json. We read the file as base64
 * (cheap; expo-file-system does a single native call), decode to a
 * Uint8Array, and feed that into `crypto.subtle.digest`. The result
 * is a 32-byte ArrayBuffer; we hex-encode for the wire.
 *
 * Avoiding `expo-crypto` keeps the dep surface flat — `expo-file-
 * system` is already in package.json and Web Crypto is a freebie on
 * Hermes. If the hash compute proves slow on large videos in the
 * future, we can swap to a streaming hasher (`react-native-quick-
 * crypto`) without touching the call site.
 */
async function sha256OfFile(uri: string): Promise<string> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  // base64 → Uint8Array. atob is available in Hermes.
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Auth-injecting fetch helper for the mobile API.
 *
 * Reads the access token off the zustand session store at call-time
 * (so token refresh between screens propagates without a rebind).
 * Throws on non-2xx so callers can use a single try/catch around the
 * whole flow.
 */
async function apiFetch<T>(
  path: string,
  init: { method: 'POST' | 'GET' | 'DELETE'; body?: string },
): Promise<T> {
  const session = useSessionStore.getState().session;
  if (!session) throw new Error('not authenticated');
  const url = `${getApiBaseUrl()}${path}`;
  const res = await fetch(url, {
    method: init.method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.access_token}`,
    },
    body: init.body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${init.method} ${path} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * Run the full presign → PUT → finalize pipeline for a captured
 * photo, document, or other vault artefact.
 *
 * The PUT step is wrapped in a try/catch with intentional swallow:
 * the v1 API returns a placeholder URL that the network layer will
 * reject (DNS / CORS / 403 from the bogus host). The contract test
 * surface is presign + finalize; the PUT becomes real once the S3
 * client lands. Once it does, this swallow can be tightened to
 * "throw on real S3 errors" without changing the call shape.
 */
export async function uploadMedia(file: UploadInput): Promise<UploadResult> {
  const sha256 = await sha256OfFile(file.uri);

  const presigned = await apiFetch<{
    upload_url: string;
    s3_key: string;
    content_hash_required: string;
  }>('/v1/media/presigned-upload', {
    method: 'POST',
    body: JSON.stringify({
      content_type: file.mime_type,
      size_bytes: file.size_bytes,
      sha256,
    }),
  });

  try {
    await FileSystem.uploadAsync(presigned.upload_url, file.uri, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': file.mime_type },
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    });
  } catch {
    // v1 placeholder URL. Real S3 client lands later; until then,
    // the row still gets created at finalize-time so the UI flow is
    // exercisable end-to-end.
  }

  const finalized = await apiFetch<{
    media: MediaArtefact;
    duplicate?: boolean;
  }>('/v1/media/finalize', {
    method: 'POST',
    body: JSON.stringify({
      s3_key: presigned.s3_key,
      content_hash: sha256,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      ...(file.exif ? { exif: file.exif } : {}),
      ...(file.event_id ? { event_id: file.event_id } : {}),
    }),
  });
  return { media: finalized.media, duplicate: finalized.duplicate ?? false };
}
