import type { DeepgramTranscript } from './types.js';

/**
 * Configuration for a single Deepgram transcription call.
 *
 * `api_key` is required — passed as `Authorization: Token <key>`.
 * `base_url` defaults to the production Deepgram listen endpoint;
 * tests override it via nock to `https://api.deepgram.com/v1/listen`.
 *
 * `model` defaults to `nova-3`, the current best-quality model with
 * AU English coverage. `language` defaults to `en-AU` so transcripts
 * favour Australian English vocabulary (e.g. "GST", "carry-back",
 * "ATO" rather than US-English false-positives).
 */
export type DeepgramClientOptions = {
  api_key: string;
  base_url?: string;
  model?: string;
  language?: string;
};

/**
 * Upstream response shape we depend on. Deepgram returns a large object
 * with channels[] and many alternatives; we only read the first
 * channel's first alternative + the metadata.duration.
 *
 * Typed locally rather than imported from a Deepgram SDK because:
 *   1. The official SDK pulls a heavy stack (axios, FormData polyfills)
 *      we don't need for a 30-second voice note.
 *   2. We only call one endpoint with one shape — duplicating the slice
 *      we read keeps the dependency surface tiny.
 */
type DeepgramListenResponse = {
  results: {
    channels: Array<{
      alternatives: Array<{ transcript: string; confidence: number }>;
    }>;
  };
  metadata: { duration: number };
};

const DEFAULT_BASE_URL = 'https://api.deepgram.com/v1/listen';
const DEFAULT_MODEL = 'nova-3';
const DEFAULT_LANGUAGE = 'en-AU';

/**
 * Transcribe a buffer of audio bytes via Deepgram's listen API.
 *
 * Throws on:
 *   - Non-2xx HTTP (the message includes the status + body for the
 *     route's error handler to log). Callers are expected to wrap
 *     this in `withRetry` from runtime/retry.ts when wiring into the
 *     pg-boss job — Deepgram does occasional 429/503 that retry
 *     handles cleanly.
 *   - Empty alternatives array (rare, only seen with all-silence
 *     uploads). Surfaces as `deepgram returned no transcript` so the
 *     A3 job can mark the event as needs-review rather than 500.
 *
 * The HTTP body is the audio bytes verbatim — Deepgram negotiates the
 * codec from the `Content-Type` header (e.g. `audio/m4a`,
 * `audio/wav`, `audio/webm`).
 */
export async function transcribe(
  opts: DeepgramClientOptions,
  audioBytes: Buffer,
  audioMimeType: string,
): Promise<DeepgramTranscript> {
  const url = new URL(opts.base_url ?? DEFAULT_BASE_URL);
  url.searchParams.set('model', opts.model ?? DEFAULT_MODEL);
  url.searchParams.set('language', opts.language ?? DEFAULT_LANGUAGE);
  // Punctuation + smart-format produce comma-and-capitalisation cleanup
  // out of the box. Cheap toggles, big readability win on the assurance
  // report side.
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'true');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${opts.api_key}`,
      'Content-Type': audioMimeType,
    },
    body: audioBytes,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`deepgram: ${res.status} ${body}`);
  }

  const j = (await res.json()) as DeepgramListenResponse;
  const alt = j.results.channels[0]?.alternatives[0];
  if (!alt) {
    throw new Error('deepgram returned no transcript');
  }
  return {
    text: alt.transcript,
    confidence: alt.confidence,
    duration_seconds: j.metadata.duration,
  };
}
