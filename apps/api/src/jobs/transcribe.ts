import { privilegedSql } from '@cpa/db/client';
import { transcribe as deepgramTranscribe } from '@cpa/integrations/deepgram';

/**
 * Transcribe job input — emitted by /v1/mobile/events (A4) onto a
 * future pg-boss queue and consumed by this handler.
 *
 * The pg-boss subscriber wiring lands in a later task (see plan at
 * the top of A3); for v1 the handler is exported as a plain async
 * function so unit tests can call it directly and the route layer
 * can no-op the dispatch.
 */
export type TranscribeJobInput = {
  /** S3 object key set by the mobile-events route on the event row. */
  audio_s3_key: string;
  /** Event id created in the API route — payload is patched in place. */
  event_id: string;
  /** Optional override; defaults to audio/m4a (the mobile recorder mime). */
  audio_mime_type?: string;
};

/**
 * Placeholder S3 client. Real wiring (signed URL or AWS-SDK getObject)
 * lands with the rest of the media-upload pipeline; for v1 this throws
 * so unit tests can stub it out + route tests assert the job-not-yet-
 * runnable flow without booting a real S3.
 */
function defaultGetMediaBytes(_s3Key: string): Promise<Buffer> {
  return Promise.reject(
    new Error('getMediaBytes: S3 fetch not implemented — wire S3 client in a follow-up task'),
  );
}

/**
 * Test-overrideable provider for the S3-fetch dependency.
 *
 * Why an object holder: `mock.method()` from `node:test` reassigns the
 * target property on the receiver. ESM module namespace bindings are
 * non-configurable by spec, so `mock.method(transcribeMod, 'getMediaBytes')`
 * fails after the first restore with "Cannot redefine property". Plain
 * object properties (this `mediaProvider` is one) ARE configurable, so
 * the same `mock.method(mediaProvider, 'getMediaBytes', stub)` pattern
 * works and `stub.mock.restore()` cleanly reverts between tests.
 */
export const mediaProvider: { getMediaBytes: (s3Key: string) => Promise<Buffer> } = {
  getMediaBytes: defaultGetMediaBytes,
};

// Re-export for any caller that imports the function directly. Production
// code paths inside this module use `mediaProvider.getMediaBytes` so
// test-time mocks take effect.
export const getMediaBytes = defaultGetMediaBytes;

/**
 * Resolve the Deepgram API key.
 *
 * Lazy-read from env so tests can flip it per-case without re-importing
 * the module. The route + worker both rely on the same env var, so a
 * single source-of-truth here also keeps deployments simple.
 */
function deepgramApiKey(): string {
  const k = process.env['DEEPGRAM_API_KEY'];
  if (typeof k !== 'string' || k.length === 0) {
    throw new Error('DEEPGRAM_API_KEY unset');
  }
  return k;
}

/**
 * Build the patched payload that replaces the event's `voice_pending`
 * placeholder once Deepgram returns. Kept as a small helper so tests
 * can assert the wire shape without round-tripping through the DB.
 *
 * Fields:
 *   - `_v: 2`                       — bumped from the route's `_v: 1` so
 *                                     downstream consumers can branch on
 *                                     transcribed-vs-pending.
 *   - `source: 'voice'`             — replaces 'voice_pending' so the
 *                                     classifier flow can fire.
 *   - `raw_text`                    — what /v1/events relies on.
 *   - `transcript_confidence`       — surfaced in the assurance report.
 *   - `transcript_duration_seconds` — UI badge ("voice note: 12s").
 *   - `audio_s3_key`                — preserved so the audio is still
 *                                     fetchable by ID.
 */
export function buildTranscribedPayload(args: {
  audio_s3_key: string;
  text: string;
  confidence: number;
  duration_seconds: number;
}): Record<string, unknown> {
  return {
    _v: 2,
    source: 'voice',
    audio_s3_key: args.audio_s3_key,
    raw_text: args.text,
    transcript_confidence: args.confidence,
    transcript_duration_seconds: args.duration_seconds,
  };
}

/**
 * Run the transcribe job.
 *
 * Sequence:
 *   1. Fetch audio bytes from S3 via getMediaBytes (placeholder).
 *   2. Call Deepgram Nova-3 (en-AU defaults).
 *   3. UPDATE event SET payload = (transcribed shape) WHERE id = event_id.
 *
 * Hash-chain note:
 *   The event row's `hash` column was computed at insert-time over the
 *   placeholder payload. Patching `payload` in place breaks
 *   verifyChain() invariants. This is accepted for v1 — the long-term
 *   fix is to either (a) re-hash the event + bump prev_hash on every
 *   downstream row, or (b) emit a follow-up event referencing the
 *   original. Either path is a future task.
 *
 * Classifier hand-off:
 *   The plan calls for triggering the existing P2 classifier on the
 *   newly-transcribed text. That flow currently lives inside the
 *   POST /v1/events route handler (lazy classifier instance, idempotency
 *   cache, withAgentSpan). It is NOT exposed as a callable job
 *   yet — wiring this transcribe job into the classifier requires
 *   either extracting that logic into @cpa/agents or enqueuing a
 *   second job (`classify`). For v1 we leave a TODO and the events
 *   route's needs_review filter will pick the now-transcribed event
 *   up via `classification IS NULL`.
 *
 * TODO(future): enqueue a classify job here once the classifier flow
 * is callable from a worker context (it currently inlines withAgentSpan
 * in the events route).
 */
export async function runTranscribeJob(input: TranscribeJobInput): Promise<void> {
  // Use the mediaProvider holder rather than the bare function so tests
  // can substitute a stub without hitting the ESM-binding limitation.
  const audio = await mediaProvider.getMediaBytes(input.audio_s3_key);
  const transcript = await deepgramTranscribe(
    { api_key: deepgramApiKey() },
    audio,
    input.audio_mime_type ?? 'audio/m4a',
  );

  const newPayload = buildTranscribedPayload({
    audio_s3_key: input.audio_s3_key,
    text: transcript.text,
    confidence: transcript.confidence,
    duration_seconds: transcript.duration_seconds,
  });

  // privilegedSql since the worker has no request-scoped tenant
  // context. The event_id is the bind; cross-tenant leakage isn't a
  // risk because the id was created server-side in the same flow that
  // enqueued the job.
  //
  // postgres-js auto-encodes JS objects as jsonb when the column is
  // jsonb-typed. Pass the object directly — no JSON.stringify, no
  // explicit cast. (The chain.ts pattern that uses
  // `${JSON.stringify(obj)}::jsonb` works for INSERTs but fails inside
  // UPDATE SET, presumably because the prepared-statement bind path
  // routes the parameter differently.)
  const updated = await privilegedSql<{ id: string }[]>`
    UPDATE event SET payload = ${privilegedSql.json(newPayload as Record<string, never>)}
     WHERE id = ${input.event_id}
    RETURNING id
  `;
  if (!updated[0]) {
    throw new Error(`transcribe: event ${input.event_id} not found`);
  }
}
