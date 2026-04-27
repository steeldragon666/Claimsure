import { enqueue } from '../sync/queue.js';

/**
 * Mobile-side payload for a queued voice event.
 *
 * Wire-format-aligned with A11's discriminated-union body for
 * POST /v1/mobile/events. Storing the envelope shape (not a bag of
 * voice-specific fields) means the F14 dispatcher can do a near-
 * identity hand-off instead of translating between local and remote
 * keys.
 *
 * `audio_uri` is the local file:// returned by Audio.Recording.getURI().
 * The dispatcher reads bytes from disk + uploads to S3 (via the
 * presigned-upload route) and replaces `audio_uri` with the canonical
 * `audio_s3_key` before POSTing. Pre-S3 wiring, the dispatcher's
 * upload swallows the placeholder URL error so the row still flushes.
 *
 * `captured_at_local` is ms epoch on the device clock — server stores
 * verbatim alongside its own NOW() so future backdate-detection has a
 * clear local-vs-server-clock split.
 */
export type VoiceEventVariant = {
  source: 'voice';
  audio_uri: string;
  audio_mime_type: string;
  duration_ms: number;
};

/**
 * Envelope persisted in mobile_event_queue.payload (as JSON). Mirrors
 * `CreateMobileEventBody` from @cpa/schemas — the dispatcher reads this
 * verbatim, swaps audio_uri → audio_s3_key for voice variants, and
 * POSTs to /v1/mobile/events.
 *
 * `subject_tenant_id` is omitted: the API derives it from the mobile
 * JWT's bound subject. Including it would require a session lookup at
 * enqueue time, which would couple the offline-clean enqueue path to
 * the auth store unnecessarily.
 */
export type EnqueueVoiceEventEnvelope = {
  captured_at_local: number;
  payload: VoiceEventVariant;
};

/**
 * Caller-facing input — flat shape for the screen, internally wrapped
 * into the envelope before persisting.
 */
export type EnqueueEventInput = {
  audio_uri: string;
  audio_mime_type: string;
  duration_ms: number;
  captured_at_local: number;
};

/**
 * Locally enqueue a voice event. Returns the local_id that the F16
 * indicator + future status screens use to show queue progress.
 *
 * No network call here — pure SQLite write. The F14 sync worker
 * picks the row up on its next drain pass; its event-kind dispatcher
 * unpacks the envelope, uploads the audio to S3, and POSTs the
 * `{captured_at_local, payload}` body to /v1/mobile/events.
 *
 * The local_id is a randomUUID() — it doubles as the
 * Idempotency-Key header value when the row eventually flushes, so
 * server-side dedup catches double-sends across drain passes.
 */
export async function enqueueVoiceEvent(p: EnqueueEventInput): Promise<string> {
  const local_id = globalThis.crypto.randomUUID();
  const envelope: EnqueueVoiceEventEnvelope = {
    captured_at_local: p.captured_at_local,
    payload: {
      source: 'voice',
      audio_uri: p.audio_uri,
      audio_mime_type: p.audio_mime_type,
      duration_ms: p.duration_ms,
    },
  };
  await enqueue({
    local_id,
    kind: 'event',
    payload: JSON.stringify(envelope),
  });
  return local_id;
}
