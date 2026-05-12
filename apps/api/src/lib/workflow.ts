/**
 * Pure-function gating logic for the claim wizard. Computes "can the
 * consultant advance from step N to N+1?" from a snapshot of underlying
 * data — no DB access here; the caller (the route handler) loads the
 * snapshot once and asks per step.
 *
 * Per Q5.b (revision flow), this is always computed live from current
 * data, so editing a prior step's data (e.g. adding new evidence) can
 * cause `canAdvance` on a later step to flip from ok=true back to
 * ok=false with a reason — the wizard surfaces this as a "data changed
 * since you last agreed" banner.
 */

export type WorkflowSnapshot = {
  eventsClassified: number;
  proposedActivitiesPending: number;
  proposedActivitiesTotal: number;
  agreedActivitiesTotal: number;
  agreedActivitiesWithoutBinding: number;
  narrativeSectionsApproved: number;
};

export type CanAdvanceResult = { ok: true } | { ok: false; reason: string };

export function canAdvance(step: 1 | 2 | 3 | 4 | 5, snap: WorkflowSnapshot): CanAdvanceResult {
  switch (step) {
    case 1:
      return snap.eventsClassified > 0
        ? { ok: true }
        : { ok: false, reason: 'Upload at least one piece of evidence to advance.' };
    case 2:
      return snap.proposedActivitiesPending === 0
        ? { ok: true }
        : {
            ok: false,
            reason: `${snap.proposedActivitiesPending} proposed activit${snap.proposedActivitiesPending === 1 ? 'y' : 'ies'} still pending — Agree or Reject each one.`,
          };
    case 3:
      return snap.agreedActivitiesWithoutBinding === 0
        ? { ok: true }
        : {
            ok: false,
            reason: `${snap.agreedActivitiesWithoutBinding} agreed activit${snap.agreedActivitiesWithoutBinding === 1 ? 'y has' : 'ies have'} no bound evidence yet.`,
          };
    case 4:
      return snap.narrativeSectionsApproved >= 4
        ? { ok: true }
        : {
            ok: false,
            reason: `Only ${snap.narrativeSectionsApproved} of 4 narrative sections approved.`,
          };
    case 5:
      return { ok: false, reason: 'Step 5 is terminal — no further advance.' };
  }
}
