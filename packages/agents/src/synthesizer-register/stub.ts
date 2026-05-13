import { createHash } from 'node:crypto';
import type {
  CompressedEvent,
  RegisterSynthesizer,
  SynthesizerInput,
  SynthesizerOutput,
} from './types.js';
import { MAX_PROPOSED_ACTIVITIES } from './types.js';

/**
 * Fixed namespace UUID for stub-derived `proposed_id`s. Hashing a bucket key
 * under a fixed namespace gives us a UUID-v5-style deterministic UUID without
 * pulling in the `uuid` package as a dependency (we have node:crypto available
 * for free).
 */
const STUB_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // RFC 4122 sample namespace

const STUB_MODEL = 'stub-v1.0.0';
const STUB_PROMPT_VERSION = 'synthesize-register@1.0.0';

/**
 * Compute the ISO 8601 week-number and week-numbering-year for an ISO date
 * string per RFC 3339 / WG 14 (Monday-first weeks; week 1 is the week that
 * contains the first Thursday of the calendar year).
 *
 * Returns:
 *   - `year` — the ISO week-numbering year (NOT necessarily the calendar year:
 *     e.g. 2024-12-30 is in week 1 of 2025).
 *   - `week` — 1..53.
 *   - `weekStartIso` — the Monday of that ISO week, as `YYYY-MM-DD`. Used in
 *     the activity name so the cluster's date range is human-readable.
 *
 * Implementation: standard "shift to Thursday" algorithm. Tested against
 * year-boundary edge cases:
 *
 *   - 2024-01-01 (Mon) → 2024-W01
 *   - 2024-12-30 (Mon) → 2025-W01
 *   - 2023-01-01 (Sun) → 2022-W52
 *   - 2020-12-31 (Thu) → 2020-W53
 */
export function isoYearWeek(iso: string): { year: number; week: number; weekStartIso: string } {
  // Parse the date portion only — we explicitly drop the time-of-day so two
  // events captured 12 hours apart on the same calendar day always bucket
  // identically regardless of timezone notation in the input.
  const datePart = iso.slice(0, 10);
  const d = new Date(`${datePart}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`isoYearWeek: invalid ISO date: ${iso}`);
  }
  // UTC day-of-week: 0=Sun..6=Sat → ISO 1=Mon..7=Sun
  const dayNum = ((d.getUTCDay() + 6) % 7) + 1;
  // Shift to the Thursday of the same ISO week (which fixes the week-year).
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + (4 - dayNum));
  const year = thursday.getUTCFullYear();
  // Jan 4 is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = ((jan4.getUTCDay() + 6) % 7) + 1;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const week = 1 + Math.round((thursday.getTime() - week1Monday.getTime()) / (7 * 86400_000));
  // Monday of THIS week = the date minus (dayNum - 1) days.
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (dayNum - 1));
  const weekStartIso = monday.toISOString().slice(0, 10);
  return { year, week, weekStartIso };
}

/**
 * Deterministic UUID derived from `(namespace, name)`, stamped as a v4 so it
 * passes the `Uuid` schema in `@cpa/schemas` (which enforces v4 only).
 *
 * We SHA-1 the concatenation of the namespace bytes and the name bytes, take
 * the first 16 bytes, and stamp version=4 + the RFC 4122 variant nibble. The
 * result is structurally indistinguishable from a `crypto.randomUUID()`
 * output but reproducible across runs — which is the property the stub needs
 * for fixture stability. We avoid pulling in the `uuid` package for this
 * because node:crypto is enough.
 */
function deterministicUuid(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const buf = Buffer.concat([nsBytes, nameBytes]);
  const hash = createHash('sha1').update(buf).digest();
  // SHA-1 always produces 20 bytes, so subarray(0, 16) is guaranteed-length 16.
  // Buffer indexed access is `number | undefined` under noUncheckedIndexedAccess,
  // but `hash[6]`/`hash[8]` are provably defined here.
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40; // version 4 (matches @cpa/schemas Uuid regex)
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

type Bucket = {
  key: string;
  subjectTenantId: string;
  year: number;
  week: number;
  weekStartIso: string;
  events: CompressedEvent[];
};

/**
 * Stub synthesizer: deterministic clustering by `(subject_tenant_id, ISO-week)`.
 *
 * Used in CI and when `ACTIVITY_REGISTER_SYNTHESIZER_IMPL=stub`. Produces a
 * predictable, non-empty register so downstream code can be tested without
 * Anthropic credentials.
 *
 * Algorithm:
 *   1. Bucket events by `(subject_tenant_id, ISO-week-of-captured_at)`.
 *   2. Each bucket → one proposed activity:
 *        - name: `Activity for week of <week-start-date> (<subject_tenant_id>)`
 *        - kind: `'core'`, anchor: `'s.355-25'` (deterministic placeholder —
 *          the stub does not attempt to make a real core/supporting call)
 *        - rationale: `Stub: clustered N events captured in ISO week W of YYYY`
 *        - clustered_event_ids: the event IDs in the bucket
 *        - confidence: 0.50 (always — stub is unconfident by design)
 *        - proposed_hypothesis / proposed_uncertainty: null
 *   3. Cap at MAX_PROPOSED_ACTIVITIES; the events from any overflow buckets
 *      go into `unclustered_event_ids`.
 *   4. Bucket ordering is stable: sorted by `(year, week, subject_tenant_id)`
 *      so identical input always produces identical output (including the
 *      derived `proposed_id` UUIDs, which are deterministic per bucket key).
 *
 * Determinism is a hard requirement: tests assert that running the stub twice
 * on the same input produces byte-identical output, so other parts of the
 * pipeline can fixture against stub outputs.
 */
export class StubRegisterSynthesizer implements RegisterSynthesizer {
  // Async signature is required by the RegisterSynthesizer interface even
  // though this implementation never awaits — keeps the interface symmetric
  // with SonnetRegisterSynthesizer.
  // eslint-disable-next-line @typescript-eslint/require-await
  async synthesize(input: SynthesizerInput): Promise<SynthesizerOutput> {
    // Test-only hook: when SYNTHESIZER_STUB_THROW=1, throw synchronously to
    // exercise the transient-failure throw path in
    // runClaimActivityProposalJob (Fix 2). Production never sets this env
    // var. Mirrors the ALLOCATOR_STUB_THROW_ON_EVENT_ID hook in
    // packages/agents/src/auto-allocator/stub.ts.
    if (process.env.SYNTHESIZER_STUB_THROW === '1') {
      throw new Error('Synthetic stub synthesizer failure');
    }

    const buckets = new Map<string, Bucket>();

    for (const ev of input.events) {
      const { year, week, weekStartIso } = isoYearWeek(ev.captured_at);
      const key = `${ev.subject_tenant_id}::${year}-W${String(week).padStart(2, '0')}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          key,
          subjectTenantId: ev.subject_tenant_id,
          year,
          week,
          weekStartIso,
          events: [],
        };
        buckets.set(key, bucket);
      }
      bucket.events.push(ev);
    }

    // Stable ordering for deterministic output. Sort by (year, week,
    // subject_tenant_id) — chronological then alphabetical within a week.
    const ordered = [...buckets.values()].sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      if (a.week !== b.week) return a.week - b.week;
      return a.subjectTenantId.localeCompare(b.subjectTenantId);
    });

    const accepted = ordered.slice(0, MAX_PROPOSED_ACTIVITIES);
    const overflow = ordered.slice(MAX_PROPOSED_ACTIVITIES);

    const proposed_activities = accepted.map((bucket) => ({
      proposed_id: deterministicUuid(STUB_NAMESPACE, bucket.key),
      name: `Activity for week of ${bucket.weekStartIso} (${bucket.subjectTenantId})`,
      kind: 'core' as const,
      statutory_anchor: 's.355-25' as const,
      rationale:
        `Stub: clustered ${bucket.events.length} event(s) captured in ` +
        `ISO week ${bucket.week} of ${bucket.year}.`,
      clustered_event_ids: bucket.events.map((ev) => ev.id),
      confidence: 0.5,
      proposed_hypothesis: null,
      proposed_uncertainty: null,
    }));

    const unclustered_event_ids = overflow.flatMap((bucket) => bucket.events.map((ev) => ev.id));

    return {
      proposed_activities,
      unclustered_event_ids,
      total_input_events: input.events.length,
      events_truncated: input.events_truncated,
      synthesizer_notes:
        proposed_activities.length === 0
          ? 'Stub: no events provided; empty register.'
          : `Stub: deterministic clustering by (subject_tenant_id, ISO-week). ` +
            `Produced ${proposed_activities.length} proposed activity bucket(s) ` +
            `from ${input.events.length} input event(s)` +
            (overflow.length > 0
              ? `; ${overflow.length} bucket(s) over the ${MAX_PROPOSED_ACTIVITIES}-cap moved to unclustered_event_ids.`
              : '.'),
      model: STUB_MODEL,
      prompt_version: STUB_PROMPT_VERSION,
      tokens_in: 0,
      tokens_out: 0,
    };
  }
}
