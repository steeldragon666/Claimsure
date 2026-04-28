import type { Event as ApiEvent } from '@cpa/schemas';

/**
 * Pure-function payload summariser for the technical-uncertainty
 * register feed (T-A6).
 *
 * The register surfaces seven event kinds — the six classifier-emitted
 * R&D narrative kinds plus ACTIVITY_UPDATED for chain-of-custody on
 * narrative edits. Each kind carries a different payload shape, so we
 * dispatch on `kind` and pull a short human-readable summary out:
 *
 *   - HYPOTHESIS / UNCERTAINTY / EXPERIMENT / OBSERVATION /
 *     ITERATION / NEW_KNOWLEDGE: classifier-emitted narrative events.
 *     Their payload is the paste-source shape `{ _v, source, raw_text }`
 *     (see events.ts step 3 in apps/api). The summary is the truncated
 *     raw_text, with the classifier rationale falling back as a
 *     secondary signal if raw_text is somehow absent.
 *
 *   - ACTIVITY_UPDATED: state-transition event from PATCH /v1/activities.
 *     Its payload is `ActivityUpdatedPayload` — `{ activity_id,
 *     fields_changed }` keyed by column name. The summary names the
 *     changed fields so the register reads as "Updated:
 *     hypothesis, technical_uncertainty" rather than dumping a JSON
 *     diff.
 *
 *   - Any other kind (defensive, including the chain-only ARTEFACT_*
 *     and CLAIM_*): falls back to the kind label. Out of scope for the
 *     register but rendered safely if a future event widens the kind
 *     set without updating this helper.
 *
 * Truncation cap is 200 chars — the register card keeps the snippet
 * compact; readers click through to the original event for the full
 * text.
 *
 * Pure: no React, no fetch, no closures over time. Easily unit-testable
 * via apps/web's node:test runner without jsdom.
 */

const MAX_LEN = 200;

const truncate = (s: string, max = MAX_LEN): string => {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + '…';
};

interface PastePayloadShape {
  _v?: number;
  source?: string;
  raw_text?: string;
  // Hypothesis-prompt mobile variant (apps/api/src/routes/mobile-events.ts)
  // emits a synthesised payload — keep these accessible for richer fallback.
  predicted_outcome?: string;
  success_criteria?: string;
  uncertainty?: string;
}

interface ActivityUpdatedPayloadShape {
  activity_id?: string;
  fields_changed?: Record<string, { from: unknown; to: unknown }>;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

const asPastePayload = (p: unknown): PastePayloadShape | null => {
  if (!isObject(p)) return null;
  // After the `isObject` narrow `p` is `Record<string, unknown>`, which
  // is structurally assignable to `PastePayloadShape` (all-optional
  // fields whose value types are subsets of `unknown`). The explicit
  // cast is documentation rather than a runtime narrowing — it locks in
  // the shape callers see, so a future required field on
  // `PastePayloadShape` produces a compile error here instead of
  // silently propagating a half-typed object. The eslint-disable is
  // accepting the cost of that explicit assertion (TypeScript's own
  // structural rule already accepts the bare return).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return p as PastePayloadShape;
};

const asActivityUpdatedPayload = (p: unknown): ActivityUpdatedPayloadShape | null => {
  if (!isObject(p)) return null;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return p as ActivityUpdatedPayloadShape;
};

/**
 * Summarise a single event for the register feed. Returns a short
 * human-readable string; never null, never throws.
 */
export function summariseEvent(event: ApiEvent): string {
  switch (event.kind) {
    case 'HYPOTHESIS':
    case 'UNCERTAINTY':
    case 'EXPERIMENT':
    case 'OBSERVATION':
    case 'ITERATION':
    case 'NEW_KNOWLEDGE': {
      const payload = asPastePayload(event.payload);
      if (payload?.raw_text && payload.raw_text.length > 0) {
        return truncate(payload.raw_text);
      }
      // Hypothesis-prompt mobile variant carries structured fields
      // instead of raw_text — concatenate the most informative one.
      if (payload?.predicted_outcome) {
        return truncate(payload.predicted_outcome);
      }
      if (payload?.uncertainty) {
        return truncate(payload.uncertainty);
      }
      // Last resort: classifier rationale (always populated for
      // classifier-emitted events).
      if (event.classification?.rationale) {
        return truncate(event.classification.rationale);
      }
      return event.kind;
    }
    case 'ACTIVITY_UPDATED': {
      const payload = asActivityUpdatedPayload(event.payload);
      const fields = payload?.fields_changed;
      if (fields && typeof fields === 'object') {
        const keys = Object.keys(fields);
        if (keys.length > 0) {
          return `Updated: ${keys.join(', ')}`;
        }
      }
      return 'Activity updated';
    }
    default:
      // Defensive fallback for any other kind that slips through. The
      // register page filters server-side to the seven supported kinds,
      // so this branch is theoretical — but keep the surface stable in
      // case a future widening of the kind filter lands without
      // updating this helper.
      return event.kind;
  }
}

/**
 * The seven kinds the technical-uncertainty register surfaces. Exported
 * so the page can pass them as the `kind=` filter to GET /v1/events.
 */
export const REGISTER_KINDS = [
  'HYPOTHESIS',
  'UNCERTAINTY',
  'EXPERIMENT',
  'OBSERVATION',
  'ITERATION',
  'NEW_KNOWLEDGE',
  'ACTIVITY_UPDATED',
] as const satisfies ReadonlyArray<ApiEvent['kind']>;
export type RegisterKind = (typeof REGISTER_KINDS)[number];
