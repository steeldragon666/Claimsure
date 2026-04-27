import { enqueue } from '../sync/queue.js';

/**
 * Mobile-side payload for a queued hypothesis-prompt event.
 *
 * Wire-format-aligned with A11's discriminated-union body for
 * POST /v1/mobile/events — `payload.source` selects the variant.
 * The dispatcher reads the queued envelope verbatim and POSTs it.
 *
 * `captured_at_local` is the device-clock ms epoch — server stores it
 * verbatim in the event payload + uses NOW() for the row's canonical
 * captured_at. The pre-experiment framing (Body by Michael) relies on
 * this being captured BEFORE the work starts; the timestamp is what
 * makes it auditable.
 */
export type HypothesisEventVariant = {
  source: 'hypothesis_prompt';
  predicted_outcome: string;
  success_criteria: string;
  uncertainty: string;
};

/**
 * Envelope persisted in mobile_event_queue.payload (as JSON). Mirrors
 * `CreateMobileEventBody` from @cpa/schemas. `subject_tenant_id` is
 * omitted — the API derives it from the mobile JWT (see events.ts for
 * the rationale).
 */
export type EnqueueHypothesisEnvelope = {
  captured_at_local: number;
  payload: HypothesisEventVariant;
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
  captured_at_local: number;
}): Promise<string> {
  const local_id = globalThis.crypto.randomUUID();
  const envelope: EnqueueHypothesisEnvelope = {
    captured_at_local: p.captured_at_local,
    payload: {
      source: 'hypothesis_prompt',
      predicted_outcome: p.predicted_outcome,
      success_criteria: p.success_criteria,
      uncertainty: p.uncertainty,
    },
  };
  await enqueue({
    local_id,
    kind: 'event',
    payload: JSON.stringify(envelope),
  });
  return local_id;
}
