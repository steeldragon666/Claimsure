import type { AutoAllocator, AutoAllocatorInput, AutoAllocatorOutput } from './types.js';

/**
 * Deterministic stub auto-allocator for CI and local dev without an API key.
 *
 * Resolution rules (ordered):
 *   1. INELIGIBLE classification → always unallocated.
 *   2. No activities provided → unallocated.
 *   3. Find the first activity whose title contains a word from the evidence text
 *      (case-insensitive intersection). If found, allocate with confidence 0.72.
 *   4. Otherwise allocate to the first activity in the list with confidence 0.60
 *      so tests always produce a deterministic allocation.
 *
 * Zero API calls, zero I/O.
 */
export class StubAutoAllocator implements AutoAllocator {
  // eslint-disable-next-line @typescript-eslint/require-await
  async allocate(input: AutoAllocatorInput): Promise<AutoAllocatorOutput> {
    // Test-only hook: when ALLOCATOR_STUB_THROW_ON_EVENT_ID matches the
    // incoming event_id, throw synchronously to exercise the
    // partial-failure isolation path in claim-evidence-binding (F4).
    // Production never sets this env var.
    if (process.env.ALLOCATOR_STUB_THROW_ON_EVENT_ID === input.event_id) {
      throw new Error(`Synthetic stub failure for event ${input.event_id}`);
    }

    const base = {
      model: 'stub-allocator-v1.0.0',
      prompt_version: 'allocate@1.0.0',
      tokens_in: 0,
      tokens_out: 0,
    };

    if (input.classification.kind === 'INELIGIBLE') {
      return {
        ...base,
        unallocated: true,
        rationale: 'Stub: INELIGIBLE evidence is never allocated.',
      };
    }

    if (input.activities.length === 0) {
      return {
        ...base,
        unallocated: true,
        rationale: 'Stub: no activities available to allocate to.',
      };
    }

    // Try to match by shared vocabulary.
    const evidenceWords = new Set(
      input.raw_text
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 4),
    );

    for (const activity of input.activities) {
      const titleWords = activity.title.toLowerCase().split(/\W+/);
      const hasMatch = titleWords.some((w) => w.length > 4 && evidenceWords.has(w));
      if (hasMatch) {
        return {
          ...base,
          unallocated: false,
          activity_id: activity.id,
          activity_code: activity.code,
          confidence: 0.72,
          rationale: `Stub: vocabulary match between evidence and activity "${activity.title}".`,
        };
      }
    }

    // Default: allocate to first activity.
    const first = input.activities[0]!;
    return {
      ...base,
      unallocated: false,
      activity_id: first.id,
      activity_code: first.code,
      confidence: 0.6,
      rationale: `Stub: default allocation to first activity "${first.title}".`,
    };
  }
}
