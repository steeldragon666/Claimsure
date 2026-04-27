import { enqueue } from '../sync/queue.js';

/**
 * Mobile-side payload for a queued hypothesis-prompt event.
 *
 * Wire-format-equivalent to the hypothesis variant accepted by
 * /v1/mobile/events (T-A11). Mirrors what the voice path enqueues —
 * the dispatcher unpacks the payload and posts the discriminated-union
 * variant determined by `kind`.
 *
 * `captured_at` is the device-clock ms epoch — server stores as
 * `captured_at_local` in the event payload + uses NOW() for the row's
 * canonical captured_at. The pre-experiment framing (Body by Michael)
 * relies on this being captured BEFORE the work starts; the timestamp
 * is what makes it auditable.
 */
export type EnqueueHypothesisPayload = {
  kind: 'hypothesis_prompt';
  predicted_outcome: string;
  success_criteria: string;
  uncertainty: string;
  captured_at: number;
};

/**
 * Locally enqueue a hypothesis_prompt event.
 *
 * Same shape contract as enqueueVoiceEvent — returns the local_id
 * which doubles as the Idempotency-Key when the row eventually flushes
 * via the F14 sync worker.
 *
 * No network call here — pure SQLite write. Failing the redeem of
 * push notifications doesn't break this path; the screen route doesn't
 * touch network at all.
 */
export async function enqueueHypothesisEvent(p: {
  predicted_outcome: string;
  success_criteria: string;
  uncertainty: string;
  captured_at: number;
}): Promise<string> {
  const local_id = globalThis.crypto.randomUUID();
  const payload: EnqueueHypothesisPayload = {
    kind: 'hypothesis_prompt',
    predicted_outcome: p.predicted_outcome,
    success_criteria: p.success_criteria,
    uncertainty: p.uncertainty,
    captured_at: p.captured_at,
  };
  await enqueue({
    local_id,
    kind: 'event',
    payload: JSON.stringify(payload),
  });
  return local_id;
}
