/**
 * Public output of the Deepgram client. Wraps the slice of the
 * upstream response we actually persist on the event row — full
 * upstream payloads aren't kept (they're large + the Deepgram dashboard
 * already has them for any debugging the team needs).
 *
 * `confidence` is the model's per-utterance score in [0,1]; a low
 * value here is what the A3 transcribe job will use to mark the
 * event for human review (mirrors the classifier's confidence
 * threshold).
 *
 * `duration_seconds` comes from Deepgram's metadata.duration and
 * is what we surface to the user as "voice note: 12s".
 */
export type DeepgramTranscript = {
  text: string;
  confidence: number;
  duration_seconds: number;
};
