import type { Activity, Claim, Event as ApiEvent, EvidenceKind, Project } from '@cpa/schemas';
import { apiFetch } from '@/lib/api';

/**
 * Typed fetch helpers for the /projects surfaces (T-A7).
 *
 * Mirrors the shape used by `apps/web/src/app/claims/[claim_id]/
 * activities/_lib/api.ts` and `apps/web/src/app/subject-tenants/_lib/
 * api.ts`: thin wrappers around `apiFetch` so every call sends the
 * cpa_session cookie and surfaces typed errors (UnauthenticatedError,
 * ConflictError, etc).
 *
 * URL prefix is `/v1/...` because `next.config.ts` rewrites `/v1/:path*`
 * to the Fastify API on localhost:3000. Endpoints exercised here:
 *   - GET `/v1/projects[?subject_tenant_id=...]`     (A1 list)
 *   - GET `/v1/projects/:id`                          (A1 detail)
 *   - GET `/v1/claims?subject_tenant_id=...`          (A2 — narrowed
 *      to the project's claimant; see TODO below for project-level
 *      filter)
 *   - GET `/v1/activities?claim_id=...`               (A3 — used to
 *      derive which claims actually belong to the project, since A2
 *      lacks a project_id filter)
 *   - GET `/v1/events?subject_tenant_id=...`          (A6 events feed —
 *      filtered client-side by project_id; see TODO)
 *
 * Lives at `_lib/` (route-local) rather than `apps/web/src/lib/`
 * because it's a feature-folder concern — same convention as
 * admin/apportionment/_lib, subject-tenants/_lib, claims/.../_lib.
 */

// =====================================================================
// Project list + detail
// =====================================================================

export interface ListProjectsOptions {
  subject_tenant_id?: string;
  // status / limit / cursor: NOT currently honored by the API.
  //
  // (a) GET /v1/projects has no `status` query param — the route hardcodes
  //     `WHERE archived_at IS NULL`. So the list endpoint cannot return
  //     archived projects at all today. The /projects list page filters
  //     the in-memory result set by Project.archived_at; the "Archived"
  //     and "All" status chips therefore render an empty list.
  //
  //     TODO(p4-a-followup): extend ListProjectsQuery + the route handler
  //     with `status?: 'active' | 'archived' | 'all'` so the Archived /
  //     All chips can do useful work. Out of scope for A7 (per the
  //     "do NOT modify A1/A2/A6 backend code" rule on this commit).
  //
  // (b) GET /v1/projects has no cursor/limit pagination. At P2/P4 scale
  //     (dozens of projects per firm) the bounded-page assumption is
  //     fine. If a firm crosses ~200 projects, revisit.
  status?: 'active' | 'archived' | 'all';
}

/**
 * GET /v1/projects[?subject_tenant_id=...]. Returns the wire shape
 * `{ projects: Project[] }` flattened to the array.
 *
 * Status filter currently happens client-side after the fetch — see
 * the TODO in {@link ListProjectsOptions}. The opts.status field is
 * accepted here so the page can pass it through unchanged once the
 * server-side filter lands.
 */
export async function listProjects(
  opts?: ListProjectsOptions,
  signal?: AbortSignal,
): Promise<Project[]> {
  const qs = new URLSearchParams();
  if (opts?.subject_tenant_id) qs.set('subject_tenant_id', opts.subject_tenant_id);
  const suffix = qs.toString();
  const path = suffix ? `/v1/projects?${suffix}` : '/v1/projects';
  const body = await apiFetch<{ projects: Project[] }>(path, { signal });
  return body.projects;
}

export async function getProject(id: string, signal?: AbortSignal): Promise<Project> {
  const body = await apiFetch<{ project: Project }>(`/v1/projects/${id}`, { signal });
  return body.project;
}

// =====================================================================
// Project claims
// =====================================================================

/**
 * Lightweight claim entry with its activity_count populated, for the
 * project-detail Claims tab. Mirrors the wire shape of GET /v1/claims/
 * :id (A2) but only the fields the tab actually renders.
 */
export interface ProjectClaim extends Claim {
  /**
   * Number of activities under this claim that belong to the project
   * we're showing. Computed client-side via GET /v1/activities?claim_id=...
   * because no API endpoint exposes "activities for project p in claim
   * c" directly. See {@link listProjectClaims} for the fan-out.
   */
  project_activity_count: number;
}

export interface ListProjectClaimsResponse {
  claims: ProjectClaim[];
  /**
   * `true` when the firm has more than {@link MAX_CLAIMS_FANOUT} claims
   * under the project's subject tenant. The first
   * {@link MAX_CLAIMS_FANOUT} claims (in the API's `fiscal_year DESC,
   * created_at DESC` order) are returned; the rest are dropped to keep
   * round-trips bounded. The Claims tab renders a banner when this is
   * set so the consultant knows the list isn't exhaustive.
   */
  truncated: boolean;
  /**
   * Total number of pre-filter claims under the subject tenant — i.e.
   * the count returned by /v1/claims before we fanned out into per-claim
   * activity probes. Useful for the truncation banner ("Showing first
   * 100 claims of 137").
   */
  total_claims_seen: number;
}

/**
 * Hard cap on the per-project claims fan-out. With one round-trip per
 * claim to /v1/activities, going beyond ~100 starts to feel slow even
 * on a fast network and increases the chance of a stuck "Loading
 * claims" state on refetch. At P4 scale (≤ 10 claims per claimant) this
 * is well above the realistic ceiling; the cap exists to put a
 * deterministic upper bound on round-trips rather than to gate normal
 * use.
 */
export const MAX_CLAIMS_FANOUT = 100;

/**
 * Lists claims belonging to a project.
 *
 * The API has no `?project_id=...` filter on `GET /v1/claims` (A2) — a
 * claim has no direct project FK; it relates to projects only through
 * `activity.project_id` and `activity.claim_id`. So we fan out:
 *
 *   1. Fetch the project (need its `subject_tenant_id` to scope claims).
 *   2. List all claims for that subject_tenant_id (A2).
 *   3. For each claim, list activities by claim_id (A3) and check
 *      whether any activity has `project_id === projectId`.
 *   4. Return the claims that pass, with the per-claim count of
 *      project-matching activities.
 *
 * At P4 scale (≤ 10 claims per claimant, ≤ 20 activities per claim)
 * this is a bounded fan-out — Promise.all of N+1 small reads. If
 * either dimension grows materially, the right fix is server-side: add
 * `project_id` to ListClaimsQuery and join against activity in the
 * route handler.
 *
 * Caps the fan-out at {@link MAX_CLAIMS_FANOUT} claims to bound the
 * round-trip count; threads `signal` through every leg so React
 * Query's auto-cancellation on unmount/refetch propagates to the
 * in-flight fetches and they don't pin the loading state.
 *
 * TODO(p4-a-followup): extend GET /v1/claims with `project_id` so this
 * fan-out becomes a single round-trip. Out of scope for A7 (no
 * back-end edits per the brief).
 */
export async function listProjectClaims(
  project: Pick<Project, 'id' | 'subject_tenant_id'>,
  signal?: AbortSignal,
): Promise<ListProjectClaimsResponse> {
  const claimsResp = await apiFetch<{ claims: Claim[] }>(
    `/v1/claims?subject_tenant_id=${encodeURIComponent(project.subject_tenant_id)}`,
    { signal },
  );
  const allClaims = claimsResp.claims;
  const totalClaimsSeen = allClaims.length;
  const truncated = totalClaimsSeen > MAX_CLAIMS_FANOUT;
  const claimsToProbe = truncated ? allClaims.slice(0, MAX_CLAIMS_FANOUT) : allClaims;

  // For each claim, fetch its activities and count the ones belonging to
  // this project. Run in parallel — at P4 scale this is a small fan-out.
  const enriched = await Promise.all(
    claimsToProbe.map(async (claim) => {
      const actsResp = await apiFetch<{ activities: Activity[] }>(
        `/v1/activities?claim_id=${encodeURIComponent(claim.id)}`,
        { signal },
      );
      const matching = actsResp.activities.filter((a) => a.project_id === project.id);
      return matching.length > 0
        ? ({ ...claim, project_activity_count: matching.length } satisfies ProjectClaim)
        : null;
    }),
  );

  // Filter out claims that don't touch this project. The order from
  // /v1/claims is `fiscal_year DESC, created_at DESC` (A2 route handler);
  // preserve that.
  const claims = enriched.filter((c): c is ProjectClaim => c !== null);
  return { claims, truncated, total_claims_seen: totalClaimsSeen };
}

// =====================================================================
// Project events / timeline
// =====================================================================

export interface ListProjectEventsOptions {
  /** The project we're showing. */
  project: Pick<Project, 'id' | 'subject_tenant_id'>;
  /** Optional kind filter; same shape as listEventsQuery.kind. */
  kinds?: EvidenceKind[];
  /** Per-page cap. Defaults to API max (200). */
  limit?: number;
}

export interface ListProjectEventsResponse {
  events: ApiEvent[];
  next_cursor: string | null;
}

/**
 * Fetches the project's timeline by hitting `GET /v1/events
 * ?subject_tenant_id=...&kind=...` and filtering client-side to the
 * rows whose `project_id` (column on the event view) matches.
 *
 * Why client-side: GET /v1/events accepts `subject_tenant_id` OR
 * `activity_id`, but no `project_id` filter. The event row carries a
 * `project_id` column (set by the PROJECT_x/ARTEFACT_x/etc emitters
 * when relevant), so the predicate is local — we just have to do it
 * after the fetch.
 *
 * Trade-offs of this approach (cf. extending the events route):
 *
 *   - Pro: zero backend churn; the "do NOT modify A6 backend" rule on
 *     A7 is honoured. The events route already returns project_id on
 *     every row.
 *   - Con: we ship rows the client filters out. At P4 scale (dozens of
 *     events per claimant per project) this is fine. If a single
 *     subject_tenant produces thousands of events, the noise grows
 *     linearly.
 *
 * TODO(p4-a-followup): extend `listEventsQuery` and the events route
 * with a `project_id` filter so this becomes a precise server-side
 * narrow. Trivial schema + WHERE clause edit; flagged here so it lands
 * in its own commit when A6 territory is open. Out of scope for A7
 * (the brief explicitly says: prefer client-side merge over schema
 * extension).
 */
export async function listProjectEvents(
  opts: ListProjectEventsOptions,
  signal?: AbortSignal,
): Promise<ListProjectEventsResponse> {
  const { project, kinds, limit = 200 } = opts;
  const qs = new URLSearchParams();
  qs.set('subject_tenant_id', project.subject_tenant_id);
  if (kinds && kinds.length > 0) qs.set('kind', kinds.join(','));
  qs.set('limit', String(limit));
  const body = await apiFetch<{ events: ApiEvent[]; next_cursor: string | null }>(
    `/v1/events?${qs.toString()}`,
    { signal },
  );

  // Client-side narrow to the project. Two ways an event is "for" the
  // project we're showing:
  //   (a) The event row has `project_id === project.id` (PROJECT_*
  //       events set this; chain-events emitted from activity
  //       routes set it too via the ACTIVITY_CREATED/ARTEFACT_LINKED/
  //       etc payloads).
  //   (b) The event row's project_id is null but the payload carries
  //       a matching project_id (defensive — older event shapes don't
  //       always populate the column).
  //
  // Most of the project lifecycle (PROJECT_CREATED / PROJECT_UPDATED /
  // PROJECT_ARCHIVED) goes through path (a). Path (b) is a safety net
  // for narrative events emitted before the column was wired up — at
  // current schema state it's a no-op, but cheap to keep.
  const filtered = body.events.filter((e) => {
    if (e.project_id === project.id) return true;
    if (
      typeof e.payload === 'object' &&
      e.payload !== null &&
      'project_id' in e.payload &&
      (e.payload as Record<string, unknown>).project_id === project.id
    ) {
      return true;
    }
    return false;
  });

  return { events: filtered, next_cursor: body.next_cursor };
}
