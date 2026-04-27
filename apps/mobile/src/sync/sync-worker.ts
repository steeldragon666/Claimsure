import * as Network from 'expo-network';
import * as FileSystem from 'expo-file-system';
import { nextQueued, markSyncing, markSynced, markFailed, type QueueRow } from './queue.js';
import { getApiBaseUrl } from '../auth/redeem.js';
import { useSessionStore } from '../auth/session-store.js';

/**
 * Per-row dispatcher contract.
 *
 * Returns `{ remote_id }` on success or `{ error }` on failure. The
 * worker handles retry bookkeeping; the dispatcher is a pure mapping
 * from queue row → API call. Real implementations land in Swimlane A
 * (one fn per kind: event, media_artefact, time_entry, signing).
 */
export type DispatchResult = { remote_id?: string; error?: string };
export type Dispatcher = (row: QueueRow) => Promise<DispatchResult>;

/**
 * Retry policy — exponential backoff capped at 5 attempts.
 *
 * Index = retry_count BEFORE this attempt:
 *   0 → first try (no wait)
 *   1 → 1s wait
 *   2 → 2s
 *   3 → 4s
 *   4 → 8s
 *   5+ → give up (worker stops re-trying this row; it stays at
 *        status='failed' for the user to manually retry / inspect).
 */
const BACKOFF_MS = [0, 1000, 2000, 4000, 8000, 16000];
export const MAX_ATTEMPTS = 5;

function backoffFor(retryCount: number): number {
  return BACKOFF_MS[retryCount] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
}

async function sleep(ms: number): Promise<void> {
  if (ms === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function isOnline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.isConnected === true && state.isInternetReachable !== false;
  } catch {
    return false;
  }
}

/**
 * Wire-format envelope as stored by enqueueVoiceEvent / enqueueHypothesisEvent.
 *
 * Mirrors `CreateMobileEventBody` from @cpa/schemas. The voice variant
 * carries an extra `audio_uri` (local file://) — the dispatcher
 * uploads the bytes via /v1/media/presigned-upload and replaces it
 * with the canonical `audio_s3_key` before POSTing.
 */
type StoredVoicePayload = {
  source: 'voice';
  audio_uri: string;
  audio_mime_type: string;
  duration_ms: number;
};

type StoredHypothesisPayload = {
  source: 'hypothesis_prompt';
  predicted_outcome: string;
  success_criteria: string;
  uncertainty: string;
};

type StoredEnvelope = {
  captured_at_local: number;
  subject_tenant_id?: string;
  payload: StoredVoicePayload | StoredHypothesisPayload;
};

/**
 * Outbound voice variant — what /v1/mobile/events expects post-upload.
 * `audio_s3_key` replaces the local `audio_uri` once the bytes land
 * on S3 (or a placeholder key if the placeholder presign URL fails;
 * the route already tolerates voice_pending payloads).
 */
type WireVoicePayload = {
  source: 'voice';
  audio_s3_key: string;
  audio_mime_type: string;
  duration_ms: number;
};

type WireBody = {
  captured_at_local: number;
  subject_tenant_id?: string;
  payload: WireVoicePayload | StoredHypothesisPayload;
};

/**
 * Best-effort SHA-256 of the local audio file. The presigned-upload
 * route requires a sha256 hex digest; if hashing fails (file gone,
 * permission flake) we fall back to a deterministic-per-row-but-fake
 * digest so the row still attempts to flush — the audio bytes just
 * won't be uploadable. The route already accepts a placeholder
 * audio_s3_key for the voice_pending placeholder pattern.
 */
async function sha256OfFile(uri: string): Promise<string | null> {
  try {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

async function fileSize(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && !info.isDirectory && typeof info.size === 'number') {
      return info.size;
    }
  } catch {
    // fall through
  }
  return 0;
}

/**
 * Acquire an audio_s3_key via the presigned-upload route + best-effort
 * PUT the local audio bytes. Mirrors the photo upload flow in
 * api-client/media.ts but returns just the s3_key (the audio path
 * doesn't go through media_artefact — the event payload references
 * the key directly).
 *
 * The PUT step is wrapped in a swallow because the v1 placeholder
 * URL won't accept the upload. The route still records a
 * voice_pending event with the s3_key, and the transcribe job
 * re-uploads or re-fetches once the real S3 client lands.
 */
async function uploadAudio(
  apiBase: string,
  accessToken: string,
  audio_uri: string,
  audio_mime_type: string,
): Promise<string> {
  const sha = (await sha256OfFile(audio_uri)) ?? `placeholder-${Date.now().toString(16)}`;
  const size_bytes = await fileSize(audio_uri);

  const presignRes = await fetch(`${apiBase}/v1/media/presigned-upload`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      content_type: audio_mime_type,
      size_bytes,
      sha256: sha,
    }),
  });
  if (!presignRes.ok) {
    const text = await presignRes.text();
    throw new Error(`presign failed (${presignRes.status}): ${text}`);
  }
  const presigned = (await presignRes.json()) as {
    upload_url: string;
    s3_key: string;
  };

  try {
    await FileSystem.uploadAsync(presigned.upload_url, audio_uri, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': audio_mime_type },
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    });
  } catch {
    // v1 placeholder URL — see comment above. Real S3 client lands later.
  }

  return presigned.s3_key;
}

/**
 * Default dispatcher for `kind='event'` rows.
 *
 * Reads the queued envelope JSON, transforms voice variants by
 * uploading audio (file:// → audio_s3_key), and POSTs the resulting
 * `{captured_at_local, subject_tenant_id?, payload}` body to
 * /v1/mobile/events. The local_id is sent as the Idempotency-Key
 * header so server-side dedup catches double-sends across drain passes.
 *
 * Hypothesis variants pass through unchanged — no upload step, no
 * key swap.
 */
export async function dispatchEventRow(row: QueueRow): Promise<DispatchResult> {
  if (row.kind !== 'event') {
    return { error: `unsupported kind: ${row.kind}` };
  }

  let envelope: StoredEnvelope;
  try {
    envelope = JSON.parse(row.payload) as StoredEnvelope;
  } catch (e) {
    return { error: `payload parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const session = useSessionStore.getState().session;
  if (!session) return { error: 'not authenticated' };
  const apiBase = getApiBaseUrl();

  let wirePayload: WireVoicePayload | StoredHypothesisPayload;
  if (envelope.payload.source === 'voice') {
    let audio_s3_key: string;
    try {
      audio_s3_key = await uploadAudio(
        apiBase,
        session.access_token,
        envelope.payload.audio_uri,
        envelope.payload.audio_mime_type,
      );
    } catch (e) {
      return { error: `audio upload failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    wirePayload = {
      source: 'voice',
      audio_s3_key,
      audio_mime_type: envelope.payload.audio_mime_type,
      duration_ms: envelope.payload.duration_ms,
    };
  } else {
    wirePayload = envelope.payload;
  }

  const body: WireBody = {
    captured_at_local: envelope.captured_at_local,
    payload: wirePayload,
  };
  if (envelope.subject_tenant_id) body.subject_tenant_id = envelope.subject_tenant_id;

  const res = await fetch(`${apiBase}/v1/mobile/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.access_token}`,
      'idempotency-key': row.local_id,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `POST /v1/mobile/events ${res.status}: ${text}` };
  }
  const json = (await res.json()) as { event?: { id?: string } };
  const remote_id = json.event?.id;
  if (!remote_id) return { error: 'response missing event.id' };
  return { remote_id };
}

/**
 * Routing dispatcher — picks the per-kind handler based on
 * `row.kind`. Today only `event` is wired (T-A1 + T-A10 + T-A11);
 * media_artefact / time_entry / signing land alongside their feature
 * tasks and slot in here.
 */
export async function defaultDispatcher(row: QueueRow): Promise<DispatchResult> {
  switch (row.kind) {
    case 'event':
      return dispatchEventRow(row);
    case 'media_artefact':
    case 'time_entry':
    case 'signing_response':
      return { error: `dispatcher for kind '${row.kind}' not implemented` };
    default:
      return { error: `unknown kind: ${String(row.kind)}` };
  }
}

/**
 * Drain the queue serially.
 *
 * - Quits early if offline; the F16 indicator already tells the user
 *   so silent failure here is fine.
 * - Hands each row to the dispatcher with `Idempotency-Key: local_id`
 *   semantics enforced by the dispatcher (it sees row.local_id).
 *   Server-side dedup is the safety net for double-sends.
 * - Stops on the first row that hits MAX_ATTEMPTS — deliberately
 *   conservative; one stuck row doesn't block the rest in the next
 *   drain pass because nextQueued orders by created_at and the stuck
 *   row's status remains 'failed' between passes (we DON'T mark it
 *   syncing twice in one pass).
 *
 * Returns the count of rows successfully synced this pass; the F16
 * indicator can use this for a "synced N events" toast later.
 */
export async function drainQueue(dispatch: Dispatcher = defaultDispatcher): Promise<number> {
  if (!(await isOnline())) return 0;

  let synced = 0;
  while (true) {
    const row = await nextQueued();
    if (!row) break;

    if (row.retry_count >= MAX_ATTEMPTS) {
      // Don't loop forever on a poison row; leave it for manual retry
      break;
    }

    await sleep(backoffFor(row.retry_count));
    await markSyncing(row.local_id);

    try {
      const result = await dispatch(row);
      if (result.remote_id) {
        await markSynced(row.local_id, result.remote_id);
        synced += 1;
      } else {
        await markFailed(row.local_id, result.error ?? 'unknown dispatch error');
        break; // back off — try again on next drain pass
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await markFailed(row.local_id, msg);
      break;
    }
  }
  return synced;
}
