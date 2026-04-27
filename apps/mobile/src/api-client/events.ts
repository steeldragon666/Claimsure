import { enqueue } from '../sync/queue.js';

/**
 * Mobile-side payload for a queued voice event.
 *
 * Wire-format-equivalent to what the F14 sync worker will eventually
 * POST to /v1/mobile/events (A4) — keeping the local shape aligned
 * means the dispatcher is a near-identity mapping rather than a
 * translator.
 *
 * `audio_uri` is the local file:// returned by Audio.Recording.getURI().
 * The dispatcher reads bytes from disk + uploads to S3 before posting
 * the API call. Pre-A4, the dispatcher is unimplemented and the row
 * sits in the queue with status='queued'.
 *
 * `captured_at` is ms epoch on the device clock. The server stores it
 * as `captured_at_local` (renamed in transit) so future backdate-detection
 * has a clear local-vs-server-clock split.
 */
export type EnqueueEventPayload = {
  kind: 'voice';
  audio_uri: string;
  audio_mime_type: string;
  duration_ms: number;
  captured_at: number;
};

/**
 * Locally enqueue a voice event. Returns the local_id that the F16
 * indicator + future status screens use to show queue progress.
 *
 * No network call here — this is a pure SQLite write. The F14 sync
 * worker (already wired) will pick the row up on its next drain pass
 * once the per-kind dispatcher for `event` lands (Swimlane-A later).
 *
 * The local_id is a randomUUID() — it doubles as the
 * Idempotency-Key header value when the row eventually flushes, so
 * server-side dedup catches double-sends across drain passes.
 */
export async function enqueueVoiceEvent(p: EnqueueEventPayload): Promise<string> {
  const local_id = globalThis.crypto.randomUUID();
  await enqueue({
    local_id,
    kind: 'event',
    payload: JSON.stringify(p),
  });
  return local_id;
}
