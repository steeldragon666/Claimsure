import type { Event as ApiEvent } from '@cpa/schemas';

/**
 * Pure-function payload summariser shared between the technical-uncertainty
 * register feed (T-A6) and the project-detail timeline tab (T-A7).
 *
 * History: introduced in A6 under
 * `apps/web/src/app/claims/[claim_id]/activities/[activity_id]/register/_components/summarise-event.ts`
 * and promoted here in A7 once a second consumer (the project-timeline
 * tab) appeared. Two route folders importing it ⇒ shared lib.
 *
 * Coverage:
 *
 *   - HYPOTHESIS / UNCERTAINTY / EXPERIMENT / OBSERVATION /
 *     ITERATION / NEW_KNOWLEDGE: classifier-emitted narrative events.
 *     Their payload is the paste-source shape `{ _v, source, raw_text }`
 *     (see events.ts step 3 in apps/api). The summary is the truncated
 *     raw_text, with the classifier rationale falling back as a
 *     secondary signal if raw_text is somehow absent.
 *
 *   - ACTIVITY_UPDATED / PROJECT_UPDATED: state-transition events from
 *     PATCH /v1/activities and PATCH /v1/projects. Payload is
 *     `{ activity_id|project_id, fields_changed }` keyed by column name.
 *     The summary names the changed fields so consumers read as
 *     "Updated: name, started_at" rather than dumping a JSON diff.
 *
 *   - PROJECT_CREATED: payload is `{ project_id, name, started_at }`.
 *     The summary is the project name.
 *
 *   - PROJECT_ARCHIVED: payload is `{ project_id, archived_by_user_id,
 *     reason? }`. The summary is the optional reason or a static label.
 *
 *   - Any other kind (defensive, including the chain-only ARTEFACT_*
 *     and CLAIM_*): falls back to the kind label. Out of scope for the
 *     register but rendered safely if a future event widens the kind
 *     set without updating this helper.
 *
 * Truncation cap is 200 chars — the consumer card keeps the snippet
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

interface ProjectCreatedPayloadShape {
  project_id?: string;
  name?: string;
  started_at?: string;
}

interface ProjectUpdatedPayloadShape {
  project_id?: string;
  fields_changed?: Record<string, { from: unknown; to: unknown }>;
}

interface ProjectArchivedPayloadShape {
  project_id?: string;
  archived_by_user_id?: string;
  reason?: string;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

// The narrow returns are documentation: each shape interface is
// structurally compatible with `Record<string, unknown>` (all fields
// optional, value types are subsets of `unknown`), so TypeScript
// accepts the bare return without a cast. Keeping these as named
// helpers (rather than inlining `isObject(p) ? p : null`) localises any
// future tightening of the shapes — add a required field on a shape
// and the compile error lands at the helper, not at every call site.

const asPastePayload = (p: unknown): PastePayloadShape | null => {
  if (!isObject(p)) return null;
  return p;
};

const asActivityUpdatedPayload = (p: unknown): ActivityUpdatedPayloadShape | null => {
  if (!isObject(p)) return null;
  return p;
};

const asProjectCreatedPayload = (p: unknown): ProjectCreatedPayloadShape | null => {
  if (!isObject(p)) return null;
  return p;
};

const asProjectUpdatedPayload = (p: unknown): ProjectUpdatedPayloadShape | null => {
  if (!isObject(p)) return null;
  return p;
};

const asProjectArchivedPayload = (p: unknown): ProjectArchivedPayloadShape | null => {
  if (!isObject(p)) return null;
  return p;
};

/**
 * Summarise a single event. Returns a short human-readable string;
 * never null, never throws.
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
    case 'PROJECT_CREATED': {
      const payload = asProjectCreatedPayload(event.payload);
      if (payload?.name && payload.name.length > 0) {
        return `Project created: ${truncate(payload.name)}`;
      }
      return 'Project created';
    }
    case 'PROJECT_UPDATED': {
      const payload = asProjectUpdatedPayload(event.payload);
      const fields = payload?.fields_changed;
      if (fields && typeof fields === 'object') {
        const keys = Object.keys(fields);
        if (keys.length > 0) {
          return `Updated: ${keys.join(', ')}`;
        }
      }
      return 'Project updated';
    }
    case 'PROJECT_ARCHIVED': {
      const payload = asProjectArchivedPayload(event.payload);
      if (payload?.reason && payload.reason.length > 0) {
        return `Project archived: ${truncate(payload.reason)}`;
      }
      return 'Project archived';
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
 * so the register page can pass them as the `kind=` filter to
 * GET /v1/events.
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

/**
 * Kinds the project-detail Timeline tab surfaces (T-A7). Broader than
 * `REGISTER_KINDS` — adds the three PROJECT_* state-transition kinds
 * plus CLAIM_STAGE_ADVANCED / CLAIM_SUBMITTED / ACTIVITY_CREATED so
 * the timeline shows the project + its claims' lifecycle alongside
 * the narrative events.
 */
export const PROJECT_TIMELINE_KINDS = [
  'PROJECT_CREATED',
  'PROJECT_UPDATED',
  'PROJECT_ARCHIVED',
  'ACTIVITY_CREATED',
  'ACTIVITY_UPDATED',
  'CLAIM_STAGE_ADVANCED',
  'CLAIM_SUBMITTED',
  'HYPOTHESIS',
  'UNCERTAINTY',
  'EXPERIMENT',
  'OBSERVATION',
  'ITERATION',
  'NEW_KNOWLEDGE',
] as const satisfies ReadonlyArray<ApiEvent['kind']>;
export type ProjectTimelineKind = (typeof PROJECT_TIMELINE_KINDS)[number];
