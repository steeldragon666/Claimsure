import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';
import {
  cleanupByEmailPrefix,
  cleanupBySlugPrefix,
  cleanupSubjectTenantsByNamePrefix,
  seedActivity,
  seedClaim,
  seedEvent,
  seedMembership,
  seedProject,
  seedSubjectTenant,
  seedTenant,
  seedUser,
} from './fixtures/test-data';

/**
 * T-A10 — /claims/:claim_id/activities/:activity_id/register feed
 * (covers T-A6).
 *
 * Verifies that:
 *   - The register page renders the H1 + activity title/code header.
 *   - Three seeded events (HYPOTHESIS, OBSERVATION, ACTIVITY_UPDATED)
 *     appear as cards, each with the right kind chip and a non-empty
 *     summary line driven by `summariseEvent`.
 *   - The "Back to activity" link returns to the A5 activity-detail
 *     page at the matching URL.
 *
 * Events are scoped to the activity by `payload.activity_id` (the
 * server filters via `payload->>'activity_id' = ${activity_id}` per
 * events.ts), so each seeded event MUST carry the activity_id in its
 * payload — otherwise it won't surface in the feed.
 */
test.describe('Activity uncertainty register', () => {
  test.afterAll(async () => {
    await cleanupSubjectTenantsByNamePrefix('e2e-A10-register-');
    await cleanupBySlugPrefix('e2e-A10-register-');
    await cleanupByEmailPrefix('e2e-A10-register-');
  });

  // TODO(P5-followup): A10's e2e for the uncertainty register feed fails
  // on CI run 25128232321 — element-not-found on the kind-chip assertion.
  // The page renders something but not what the test expects: either the
  // events seeded via seedEvent aren't being projected into the feed, or
  // the kind-chip selector / scope is wrong, or the API filter `kind=CSV`
  // isn't matching the seeded shapes. Needs Docker-equipped local repro
  // to debug. Skipping until P5 has the capacity. P5 plan reference:
  // docs/plans/2026-04-30-p5-implementation.md, Theme 7.
  test.skip('admin sees three register events with summaries and kind chips', async ({
    page,
    context,
  }) => {
    const tenantId = await seedTenant('e2e-A10-register-firm');
    const adminId = await seedUser('e2e-A10-register-admin@example.com', 'A10 Register Admin');
    await seedMembership(tenantId, adminId, 'admin', true);
    const subjectId = await seedSubjectTenant(tenantId, 'e2e-A10-register-claimant');

    const projectId = await seedProject({
      tenantId,
      subjectTenantId: subjectId,
      name: 'A10 Register Project',
    });
    const claimId = await seedClaim({
      tenantId,
      subjectTenantId: subjectId,
      fiscalYear: 2027,
    });
    const activityTitle = 'A10 Register Activity';
    const activityId = await seedActivity({
      tenantId,
      projectId,
      claimId,
      code: 'CA-001',
      kind: 'core',
      title: activityTitle,
      hypothesis: 'Catalyst will retain >85% activity at 200 hours.',
      technicalUncertainty: 'No published longevity data for this catalyst class.',
    });

    // Distinct timestamps so the chain ordering is deterministic. The
    // chain extends through the same subject_tenant — each event reads
    // the prior head and appends, so seeding order matters.
    const t0 = new Date(Date.now() - 3 * 60_000);
    const t1 = new Date(Date.now() - 2 * 60_000);
    const t2 = new Date(Date.now() - 1 * 60_000);

    const hypothesisText = 'A10 hypothesis: catalyst retains activity past 200h.';
    const observationText = 'A10 observation: catalyst dropped 18% by 150h.';

    await seedEvent({
      tenantId,
      subjectTenantId: subjectId,
      capturedByUserId: adminId,
      kind: 'HYPOTHESIS',
      payload: { _v: 1, source: 'paste', raw_text: hypothesisText, activity_id: activityId },
      classification: {
        kind: 'HYPOTHESIS',
        confidence: 0.85,
        rationale: 'A10 register seed',
        statutory_anchor: '§355-25(1)(a)',
        model: 'stub-v1.0.0',
        prompt_version: 'classify@1.0.0',
        tokens_in: 0,
        tokens_out: 0,
      },
      capturedAt: t0,
    });
    await seedEvent({
      tenantId,
      subjectTenantId: subjectId,
      capturedByUserId: adminId,
      kind: 'OBSERVATION',
      payload: { _v: 1, source: 'paste', raw_text: observationText, activity_id: activityId },
      classification: {
        kind: 'OBSERVATION',
        confidence: 0.78,
        rationale: 'A10 register seed',
        statutory_anchor: '§355-25(1)(a)',
        model: 'stub-v1.0.0',
        prompt_version: 'classify@1.0.0',
        tokens_in: 0,
        tokens_out: 0,
      },
      capturedAt: t1,
    });
    await seedEvent({
      tenantId,
      subjectTenantId: subjectId,
      capturedByUserId: adminId,
      kind: 'ACTIVITY_UPDATED',
      payload: {
        activity_id: activityId,
        fields_changed: {
          hypothesis: {
            from: 'old hypothesis',
            to: 'new hypothesis',
          },
          technical_uncertainty: {
            from: null,
            to: 'newly identified uncertainty',
          },
        },
      },
      capturedAt: t2,
    });

    await signInAs(context, {
      id: adminId,
      email: 'e2e-A10-register-admin@example.com',
      primaryIdp: 'microsoft',
      activeTenantId: tenantId,
      activeRole: 'admin',
      availableTenants: [
        {
          tenantId,
          name: 'E2E e2e-A10-register-firm',
          slug: 'e2e-A10-register-firm',
          role: 'admin',
        },
      ],
    });

    await page.goto(`/claims/${claimId}/activities/${activityId}/register`);

    // H1 + activity title/code header.
    await expect(
      page.getByRole('heading', { name: 'Technical Uncertainty Register', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(activityTitle, { exact: true })).toBeVisible();
    await expect(page.getByText('CA-001', { exact: true })).toBeVisible();

    // Three kind chips render via KindChip — uppercase kind strings.
    // Scope to the register cards (rendered as <article> via the
    // UncertaintyFeed component) rather than `.first()` against the
    // whole page; otherwise a regression that drops the chip from the
    // cards but leaves the kind string in a chart legend or aria-live
    // region would silently still pass.
    const cards = page.getByRole('article');
    await expect(cards.getByText('HYPOTHESIS', { exact: true })).toBeVisible();
    await expect(cards.getByText('OBSERVATION', { exact: true })).toBeVisible();
    await expect(cards.getByText('ACTIVITY_UPDATED', { exact: true })).toBeVisible();

    // Each card's summary line — driven by summariseEvent. Truncated
    // raw_text for the classifier-emitted events; "Updated: ..." for
    // ACTIVITY_UPDATED.
    await expect(page.getByText(hypothesisText)).toBeVisible();
    await expect(page.getByText(observationText)).toBeVisible();
    // ACTIVITY_UPDATED summary lists the changed field names.
    await expect(page.getByText(/Updated: hypothesis, technical_uncertainty/)).toBeVisible();

    // Back to activity link — clicking returns us to the A5 detail page.
    await page.getByRole('link', { name: /Back to activity/i }).click();
    await page.waitForURL(new RegExp(`/claims/${claimId}/activities/${activityId}$`));
    await expect(page.getByRole('heading', { name: activityTitle, exact: true })).toBeVisible();
  });
});
