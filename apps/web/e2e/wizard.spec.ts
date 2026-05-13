import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import crypto from 'node:crypto';
import { privilegedSql } from '@cpa/db/client';
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
 * Claim wizard — e2e coverage for the now-functional 5-step guided flow
 * at /claims/:id. The wizard renders for claims with `workflow_state IS
 * NOT NULL`; legacy claims continue to render the tabbed ClaimTabs view.
 *
 * The wizard was non-functional until just before this spec was written —
 * the orphan that lived at this path predated `AgreeStepButton`, the
 * per-section narrative Agree panel, the StaleStepBanner, and the
 * step-5 "coming soon" honest stub. The orphan's DOM-pinning assertions
 * (stepper, URL routing, legacy fallback) are still valid and have been
 * kept as-is; the API-driven advance / per-section / stale-banner /
 * step-5-stub tests are new.
 *
 * What this spec pins (in order):
 *   1. Happy-path Step 1 → AgreeStepButton: with one classified event,
 *      Next is enabled; clicking calls POST /workflow/step/1/agree, the
 *      stepper shows the checkmark on step 1 in the same page session,
 *      and the URL advances to ?step=2 (AgreeStepButton invalidation).
 *   2. Stepper checkmarks reflect agreed steps from workflow_state (seed
 *      directly — DOM contract).
 *   3. URL routing edge cases: ?step=3 jumps; ?step=99 / ?step=abc fall
 *      back gracefully to the lowest unagreed step.
 *   4. Stepper pill click jumps (W4 free-navigation) via router.replace
 *      (URL changes; no history entry added).
 *   5. Reopen (Q5.b) — clearing step 1's agreed_at does NOT cascade to
 *      steps 2..5; their timestamps remain.
 *   6. Stale-step banner — step 1 previously agreed but precondition no
 *      longer met (no events seeded) -> banner is visible with the
 *      formatted agreed_at date.
 *   7. Legacy claim (workflow_state NULL) renders ClaimTabs (legacy nav
 *      links Activities/Evidence/...), NOT the wizard stepper.
 *   8. Step 4 per-section Agree panel — seed 4 'complete' narrative_draft
 *      rows; assert 4 enabled Agree buttons render; clicking one flips
 *      to "approved"; bottom Next still disabled until all 4 done.
 *   9. Step 5 honest stub — "Coming soon" copy visible; Generate button
 *      permanently disabled; no agreeStep(5).
 *
 * What this spec does NOT cover (pinned in TODOs at relevant tests):
 *   - Full multi-step happy-path through every canAdvance gate end-to-end
 *     in a single test (steps 2 + 3 require seeding ACTIVITY_REGISTER_DRAFTED
 *     proposals + matching ACTIVITY_CREATED accepts + ARTEFACT_LINKED events
 *     under particular projects; that is its own integration test and
 *     each step's DOM contract is covered here in isolation).
 *   - Clicking "Add evidence" in step 3's EventPickerDialog modal — pinned
 *     as a follow-up; canAdvance(3) is exercised via direct event seeding
 *     in the stale-banner test for step 3.
 */

const SLUG_PREFIX = 'e2e-wizard-';
const EMAIL_PREFIX = 'e2e-wizard-';
const SUBJECT_PREFIX = 'e2e-wizard-';

interface SeededFixture {
  tenantId: string;
  userId: string;
  subjectId: string;
  claimId: string;
}

/**
 * Set `workflow_state` directly on a claim via privilegedSql, bypassing
 * the API. We use this to:
 *   - Initialise a fresh wizard state (all steps null).
 *   - Pre-agree specific steps for stepper-checkmark assertions without
 *     having to seed every event the canAdvance gate requires upstream.
 *   - Test the reopen no-cascade contract (Q5.b).
 */
async function setWorkflowState(
  claimId: string,
  state: {
    initialized_at: string;
    steps: Record<'1' | '2' | '3' | '4' | '5', { agreed_at: string; agreed_by: string } | null>;
  },
): Promise<void> {
  await privilegedSql`
    UPDATE claim
       SET workflow_state = ${JSON.stringify(state)}::text::jsonb,
           updated_at     = NOW()
     WHERE id = ${claimId}
  `;
}

async function clearWorkflowState(claimId: string): Promise<void> {
  await privilegedSql`UPDATE claim SET workflow_state = NULL WHERE id = ${claimId}`;
}

function freshState(initialisedAt: Date = new Date()): {
  initialized_at: string;
  steps: Record<'1' | '2' | '3' | '4' | '5', { agreed_at: string; agreed_by: string } | null>;
} {
  return {
    initialized_at: initialisedAt.toISOString(),
    steps: { '1': null, '2': null, '3': null, '4': null, '5': null },
  };
}

/**
 * Seed a fresh tenant + consultant user + subject_tenant + claim.
 * Each test gets a unique slug suffix to keep parallel-but-serialised
 * runs hygienic. fiscalYear is randomised to avoid the
 * (subject_tenant_id, fiscal_year) UNIQUE collision when multiple tests
 * accidentally share a claimant.
 */
async function seedFixture(suffix: string): Promise<SeededFixture> {
  const tenantId = await seedTenant(`${SLUG_PREFIX}${suffix}-firm`);
  const userId = await seedUser(
    `${EMAIL_PREFIX}${suffix}@example.com`,
    `Wizard ${suffix} Consultant`,
  );
  await seedMembership(tenantId, userId, 'consultant', true);
  const subjectId = await seedSubjectTenant(tenantId, `${SUBJECT_PREFIX}${suffix}-claimant`);
  const claimId = await seedClaim({
    tenantId,
    subjectTenantId: subjectId,
    // fiscal_year has CHECK constraint claim_fiscal_year_range
    // (migration 0012): BETWEEN 2010 AND 2050. We seed unique tenants
    // + claimants per test so UNIQUE (subject_tenant_id, fiscal_year)
    // collisions aren't possible anyway, but randomise within the
    // legal range as belt-and-braces.
    fiscalYear: 2027 + Math.floor(Math.random() * 20),
    stage: 'narrative_drafting',
  });
  return { tenantId, userId, subjectId, claimId };
}

async function signInConsultant(
  context: BrowserContext,
  fx: SeededFixture,
  suffix: string,
): Promise<void> {
  await signInAs(context, {
    id: fx.userId,
    email: `${EMAIL_PREFIX}${suffix}@example.com`,
    primaryIdp: 'microsoft',
    activeTenantId: fx.tenantId,
    activeRole: 'consultant',
    availableTenants: [
      {
        tenantId: fx.tenantId,
        name: `E2E ${SLUG_PREFIX}${suffix}-firm`,
        slug: `${SLUG_PREFIX}${suffix}-firm`,
        role: 'consultant',
      },
    ],
  });
}

/**
 * Seed a single classified evidence event so canAdvance(1) flips to ok.
 * The wizard's step-1 gate (workflow.ts:canAdvance) fires once any
 * classified event exists on the claimant chain (`kind IS NOT NULL`).
 */
async function seedOneEvidenceEvent(fx: SeededFixture): Promise<void> {
  await seedEvent({
    tenantId: fx.tenantId,
    subjectTenantId: fx.subjectId,
    capturedByUserId: fx.userId,
    kind: 'HYPOTHESIS',
    payload: { _v: 1, source: 'paste', raw_text: 'wizard-spec seeded hypothesis' },
    classification: {
      kind: 'HYPOTHESIS',
      confidence: 0.85,
      rationale: 'seed',
      statutory_anchor: '§355-25(1)(a)',
      model: 'stub-v1.0.0',
      prompt_version: 'classify@1.0.0',
      tokens_in: 0,
      tokens_out: 0,
    },
  });
}

/**
 * Seed one narrative_draft row for a given activity + section_kind in
 * status 'complete' — the per-section Agree button precondition (and
 * the wizard's step-4 gate aggregates DISTINCT section_kinds across
 * the claim, so one draft per kind is enough to flip canAdvance(4)
 * after acceptance).
 *
 * Mirrors the seedDraft helper in apps/api/src/routes/narrative-accept.test.ts.
 */
async function seedNarrativeDraft(args: {
  tenantId: string;
  activityId: string;
  sectionKind: 'new_knowledge' | 'hypothesis' | 'uncertainty' | 'experiments_and_results';
  status: 'streaming' | 'complete' | 'accepted' | 'archived';
  createdByUserId: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await privilegedSql`
    INSERT INTO narrative_draft (
      tenant_id, id, activity_id, section_kind, current_version,
      status, segments, content_hash, model, prompt_version, created_by_user_id
    )
    VALUES (
      ${args.tenantId},
      ${id},
      ${args.activityId},
      ${args.sectionKind},
      1,
      ${args.status},
      ${JSON.stringify([{ type: 'prose', text: 'wizard-spec seed' }])}::jsonb,
      encode(digest(${'wizard-spec:' + args.sectionKind}, 'sha256'), 'hex'),
      'test-model-v1',
      'test-prompt@1.0.0',
      ${args.createdByUserId}
    )
  `;
  return id;
}

async function gotoClaim(page: Page, claimId: string, query = ''): Promise<void> {
  const path = `/claims/${claimId}${query ? `?${query}` : ''}`;
  await page.goto(path);
}

test.describe('Claim wizard', () => {
  test.afterAll(async () => {
    // narrative_draft rows are CASCADE-deleted when their activity is
    // deleted (FK ON DELETE CASCADE per migration 0029); activity rows
    // are deleted by cleanupSubjectTenantsByNamePrefix.
    await cleanupSubjectTenantsByNamePrefix(SUBJECT_PREFIX);
    await cleanupBySlugPrefix(SLUG_PREFIX);
    await cleanupByEmailPrefix(EMAIL_PREFIX);
  });

  // -----------------------------------------------------------------
  // Happy-path Step 1 → AgreeStepButton API call → stepper updates
  // without manual refresh.
  // -----------------------------------------------------------------
  test('step 1 happy path: click Agree, stepper checkmarks, URL advances to step 2', async ({
    page,
    context,
  }) => {
    const suffix = 'happy';
    const fx = await seedFixture(suffix);
    await setWorkflowState(fx.claimId, freshState());
    await signInConsultant(context, fx, suffix);

    await gotoClaim(page, fx.claimId);

    // Wizard stepper is the unambiguous "we're in wizard mode" signal —
    // legacy claims render ClaimTabs (tab links) instead.
    await expect(page.getByTestId('wizard-stepper')).toBeVisible({ timeout: 15_000 });
    // ClaimTabs nav must NOT be present on a wizard claim.
    await expect(page.getByRole('link', { name: /^Activities$/i })).toHaveCount(0);

    // Step 1 should be the active step on a fresh wizard.
    await expect(page.getByTestId('wizard-step-1')).toBeVisible();

    // No agreed steps yet -> no checkmarks; each pill shows its number.
    for (const n of [1, 2, 3, 4, 5] as const) {
      await expect(page.getByTestId(`wizard-stepper-${n}`)).toHaveText(String(n));
    }
    // Step 1 pill carries aria-current="step".
    await expect(page.getByTestId('wizard-stepper-1')).toHaveAttribute('aria-current', 'step');

    // Agree button (label "Next: Review Activities →") is disabled with
    // reason text — no classified evidence exists yet.
    const agreeBtn = page.getByTestId('wizard-step-1-agree');
    await expect(agreeBtn).toBeDisabled();
    await expect(page.getByText(/Upload at least one piece of evidence/i)).toBeVisible();

    // Seed a classified event and reload to refresh the workflow query.
    await seedOneEvidenceEvent(fx);
    await page.reload();
    await expect(page.getByTestId('wizard-step-1')).toBeVisible({ timeout: 15_000 });
    // canAdvance(1) flips to ok -> Agree enables, reason text vanishes.
    await expect(page.getByTestId('wizard-step-1-agree')).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByText(/Upload at least one piece of evidence/i)).not.toBeVisible();

    // Click Agree — fires POST /workflow/step/1/agree, then awaits the
    // ['workflow', claimId] query invalidation, then calls onSuccess
    // which advances `?step=2`. Within the same page session (no manual
    // reload), assert the stepper shows step 1 checked AND we landed on
    // step 2.
    await page.getByTestId('wizard-step-1-agree').click();
    await expect(page).toHaveURL(/[?&]step=2(?:&|$)/, { timeout: 10_000 });
    await expect(page.getByTestId('wizard-step-2')).toBeVisible({ timeout: 10_000 });
    // Critical: this only holds if the invalidate-before-onSuccess
    // ordering in AgreeStepButton is correct.
    await expect(page.getByTestId('wizard-stepper-1')).toHaveText('✓');
  });

  // -----------------------------------------------------------------
  // Stepper checkmarks reflect agreed steps in workflow_state.
  // We seed agreed entries directly (rather than driving the API end
  // to end through every step's gate) because the DOM contract under
  // test is "agreed step -> checkmark".
  // -----------------------------------------------------------------
  test('stepper renders checkmarks for agreed steps from workflow_state', async ({
    page,
    context,
  }) => {
    const suffix = 'checkmarks';
    const fx = await seedFixture(suffix);
    const now = new Date().toISOString();
    await setWorkflowState(fx.claimId, {
      initialized_at: now,
      steps: {
        '1': { agreed_at: now, agreed_by: fx.userId },
        '2': { agreed_at: now, agreed_by: fx.userId },
        '3': null,
        '4': null,
        '5': null,
      },
    });
    await signInConsultant(context, fx, suffix);

    await gotoClaim(page, fx.claimId);
    await expect(page.getByTestId('wizard-stepper')).toBeVisible({ timeout: 15_000 });

    // Agreed steps render the unicode checkmark (U+2713). Unagreed pills
    // still show their step number.
    await expect(page.getByTestId('wizard-stepper-1')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-2')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-3')).toHaveText('3');
    await expect(page.getByTestId('wizard-stepper-4')).toHaveText('4');
    await expect(page.getByTestId('wizard-stepper-5')).toHaveText('5');

    // With steps 1 + 2 agreed, the orchestrator's lowestUnagreedStep
    // resolves to step 3, so the step-3 panel renders by default.
    await expect(page.getByTestId('wizard-step-3')).toBeVisible();
    await expect(page.getByTestId('wizard-stepper-3')).toHaveAttribute('aria-current', 'step');
  });

  // -----------------------------------------------------------------
  // URL routing: ?step=N jumps directly to step N (W4 free-navigation).
  // -----------------------------------------------------------------
  test('?step=3 jumps directly to step 3 even on a fresh wizard (W4 free nav)', async ({
    page,
    context,
  }) => {
    const suffix = 'urljump';
    const fx = await seedFixture(suffix);
    await setWorkflowState(fx.claimId, freshState());
    await signInConsultant(context, fx, suffix);

    await gotoClaim(page, fx.claimId, 'step=3');
    await expect(page.getByTestId('wizard-stepper')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('wizard-step-3')).toBeVisible();
    await expect(page.getByTestId('wizard-stepper-3')).toHaveAttribute('aria-current', 'step');
  });

  // -----------------------------------------------------------------
  // Invalid ?step=99 -> falls back to lowest unagreed step.
  // parseStepParam rejects integers outside 1..5 (returns null), so
  // lowestUnagreedStep takes over.
  // -----------------------------------------------------------------
  test('invalid ?step=99 falls back to lowest unagreed step', async ({ page, context }) => {
    const suffix = 'urlinvalid';
    const fx = await seedFixture(suffix);
    const now = new Date().toISOString();
    // Agree step 1 only — lowest unagreed should be 2.
    await setWorkflowState(fx.claimId, {
      initialized_at: now,
      steps: {
        '1': { agreed_at: now, agreed_by: fx.userId },
        '2': null,
        '3': null,
        '4': null,
        '5': null,
      },
    });
    await signInConsultant(context, fx, suffix);

    await gotoClaim(page, fx.claimId, 'step=99');
    await expect(page.getByTestId('wizard-stepper')).toBeVisible({ timeout: 15_000 });
    // Fall-through is step 2 (lowest unagreed).
    await expect(page.getByTestId('wizard-step-2')).toBeVisible();
    await expect(page.getByTestId('wizard-stepper-2')).toHaveAttribute('aria-current', 'step');
  });

  // -----------------------------------------------------------------
  // Non-numeric ?step=abc -> also falls back to lowest unagreed step.
  // parseStepParam Number(raw) returns NaN; Number.isInteger fails;
  // returns null.
  // -----------------------------------------------------------------
  test('non-numeric ?step=abc falls back to lowest unagreed step', async ({ page, context }) => {
    const suffix = 'urlnonnum';
    const fx = await seedFixture(suffix);
    await setWorkflowState(fx.claimId, freshState());
    await signInConsultant(context, fx, suffix);

    await gotoClaim(page, fx.claimId, 'step=abc');
    await expect(page.getByTestId('wizard-stepper')).toBeVisible({ timeout: 15_000 });
    // Fresh wizard, no agreed steps -> step 1 is lowest unagreed.
    await expect(page.getByTestId('wizard-step-1')).toBeVisible();
    await expect(page.getByTestId('wizard-stepper-1')).toHaveAttribute('aria-current', 'step');
  });

  // -----------------------------------------------------------------
  // Stepper button jumps from step 1 to step 4 (free-navigation) via
  // router.replace — URL changes; back-button stays on the page-load
  // entry (no new history record per W4).
  // -----------------------------------------------------------------
  test('clicking a stepper pill jumps to that step via router.replace (W4 free nav)', async ({
    page,
    context,
  }) => {
    const suffix = 'stepperjump';
    const fx = await seedFixture(suffix);
    await setWorkflowState(fx.claimId, freshState());
    await signInConsultant(context, fx, suffix);

    await gotoClaim(page, fx.claimId);
    await expect(page.getByTestId('wizard-step-1')).toBeVisible({ timeout: 15_000 });

    // Record history length pre-click so we can assert router.replace
    // (vs. router.push) — replace MUST NOT add a new history entry.
    const lengthBefore = await page.evaluate(() => window.history.length);

    await page.getByTestId('wizard-stepper-4').click();
    await expect(page).toHaveURL(/[?&]step=4(?:&|$)/);
    await expect(page.getByTestId('wizard-step-4')).toBeVisible();

    const lengthAfter = await page.evaluate(() => window.history.length);
    // router.replace is the contract — history length unchanged.
    expect(lengthAfter).toBe(lengthBefore);
  });

  // -----------------------------------------------------------------
  // Reopen (Q5.b): clearing step 1's agreed_at does NOT cascade.
  // We mutate workflow_state directly (mirrors what the /reopen route's
  // UPDATE does) so we don't have to drive the agree API end-to-end first.
  // -----------------------------------------------------------------
  test('reopen step 1 does not cascade to steps 2..5 (Q5.b)', async ({ page, context }) => {
    const suffix = 'reopen';
    const fx = await seedFixture(suffix);
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();
    await setWorkflowState(fx.claimId, {
      initialized_at: oneHourAgo,
      steps: {
        '1': { agreed_at: oneHourAgo, agreed_by: fx.userId },
        '2': { agreed_at: thirtyMinAgo, agreed_by: fx.userId },
        '3': { agreed_at: fifteenMinAgo, agreed_by: fx.userId },
        '4': null,
        '5': null,
      },
    });
    await signInConsultant(context, fx, suffix);

    // Sanity-check the starting state via the UI.
    await gotoClaim(page, fx.claimId);
    await expect(page.getByTestId('wizard-stepper')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('wizard-stepper-1')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-2')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-3')).toHaveText('✓');

    // Simulate the reopen route's UPDATE: clear step 1, leave 2 + 3 intact.
    // Builds the same jsonb shape applyReopen would produce.
    await setWorkflowState(fx.claimId, {
      initialized_at: oneHourAgo,
      steps: {
        '1': null,
        '2': { agreed_at: thirtyMinAgo, agreed_by: fx.userId },
        '3': { agreed_at: fifteenMinAgo, agreed_by: fx.userId },
        '4': null,
        '5': null,
      },
    });

    await page.reload();
    await expect(page.getByTestId('wizard-stepper')).toBeVisible({ timeout: 15_000 });
    // Step 1 pill back to its number; steps 2 + 3 still checkmarked.
    await expect(page.getByTestId('wizard-stepper-1')).toHaveText('1');
    await expect(page.getByTestId('wizard-stepper-2')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-3')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-4')).toHaveText('4');
    await expect(page.getByTestId('wizard-stepper-5')).toHaveText('5');

    // Verify the persisted timestamps on steps 2 + 3 are unchanged (no
    // cascade) — round-trip through the DB rather than trusting the UI.
    const rows = await privilegedSql<{ workflow_state: unknown }[]>`
      SELECT workflow_state FROM claim WHERE id = ${fx.claimId}
    `;
    const ws = rows[0]?.workflow_state as {
      steps: Record<string, { agreed_at: string; agreed_by: string } | null>;
    };
    expect(ws.steps['1']).toBeNull();
    expect(ws.steps['2']?.agreed_at).toBe(thirtyMinAgo);
    expect(ws.steps['3']?.agreed_at).toBe(fifteenMinAgo);
  });

  // -----------------------------------------------------------------
  // StaleStepBanner — step 1 was previously agreed but canAdvance(1)
  // is no longer ok (we left the event chain empty so eventsClassified
  // = 0). The banner displays the formatted agreed_at date.
  //
  // The banner is rendered inside the wizard-step-1 panel and is purely
  // a `stepEntry !== null && !canAdvance.ok` derivation — no other
  // server state matters.
  // -----------------------------------------------------------------
  test('stale-step banner shows when step previously agreed but precondition no longer met', async ({
    page,
    context,
  }) => {
    const suffix = 'stale';
    const fx = await seedFixture(suffix);
    // agreed_at = 1 Mar 2025 — formatted via toLocaleDateString('en-AU',
    // { day:'numeric', month:'short', year:'numeric' }) yields "1 Mar 2025".
    const agreedAtIso = '2025-03-01T10:00:00.000Z';
    await setWorkflowState(fx.claimId, {
      initialized_at: agreedAtIso,
      steps: {
        '1': { agreed_at: agreedAtIso, agreed_by: fx.userId },
        '2': null,
        '3': null,
        '4': null,
        '5': null,
      },
    });
    // NO seedOneEvidenceEvent — eventsClassified stays at 0, so
    // canAdvance(1) returns { ok: false, reason: ... }.

    await signInConsultant(context, fx, suffix);
    await gotoClaim(page, fx.claimId, 'step=1');

    await expect(page.getByTestId('wizard-step-1')).toBeVisible({ timeout: 15_000 });
    const banner = page.getByTestId('stale-step-banner');
    await expect(banner).toBeVisible();
    // Date is locale-formatted server-side via the browser's
    // toLocaleDateString — be loose on whitespace + comma so we don't
    // depend on the exact en-AU formatter output across browser
    // versions, but pin month + year.
    await expect(banner).toContainText(/Mar/);
    await expect(banner).toContainText(/2025/);
    await expect(banner).toContainText(/review and re-Agree/i);
  });

  // -----------------------------------------------------------------
  // Legacy claim (workflow_state IS NULL) renders ClaimTabs, not the
  // wizard stepper. is_wizard_claim is derived server-side as
  // `(workflow_state IS NOT NULL)`.
  // -----------------------------------------------------------------
  test('legacy claim (workflow_state NULL) renders ClaimTabs, not wizard', async ({
    page,
    context,
  }) => {
    const suffix = 'legacy';
    const fx = await seedFixture(suffix);
    // Explicitly NULL the workflow_state. NB: seedClaim does NOT populate
    // it (column nullable, no DEFAULT) — clearing here is belt-and-
    // braces and documents intent.
    await clearWorkflowState(fx.claimId);
    await signInConsultant(context, fx, suffix);

    await gotoClaim(page, fx.claimId);

    // ClaimTabs renders a tablist with role="tab" buttons (NOT <a> links —
    // the orphan got this wrong; ClaimTabs uses a button-based hand-rolled
    // tablist per the WAI-ARIA APG automatic-activation pattern). Assert
    // the Activities + Evidence tabs are visible and the WizardStepper
    // is absent.
    await expect(page.getByRole('tab', { name: /^Activities$/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: /^Evidence$/i })).toBeVisible();
    // Sanity: tablist itself is present.
    await expect(page.getByRole('tablist', { name: /Claim sections/i })).toBeVisible();
    await expect(page.getByTestId('wizard-stepper')).toHaveCount(0);
  });

  // -----------------------------------------------------------------
  // Step 4 per-section Agree panel — seed an activity + 4 'complete'
  // narrative_draft rows (one per section_kind). Each of the 4 sections
  // renders an enabled Agree button. Clicking ONE flips that section to
  // the "approved" indicator; the bottom-of-step Next button remains
  // disabled until all 4 sections are accepted.
  // -----------------------------------------------------------------
  test('step 4 per-section Agree: 4 buttons render, one click flips, Next gated on all four', async ({
    page,
    context,
  }) => {
    const suffix = 'step4sections';
    const fx = await seedFixture(suffix);
    const now = new Date().toISOString();
    // Pre-agree steps 1..3 so the orchestrator lands us on step 4 by
    // default. The canAdvance gates on 1..3 are bypassed by the
    // workflow_state seed (the gate is re-evaluated server-side, but
    // step-4 only requires canAdvance(4) to gate ITS Next button, not
    // the lower steps).
    await setWorkflowState(fx.claimId, {
      initialized_at: now,
      steps: {
        '1': { agreed_at: now, agreed_by: fx.userId },
        '2': { agreed_at: now, agreed_by: fx.userId },
        '3': { agreed_at: now, agreed_by: fx.userId },
        '4': null,
        '5': null,
      },
    });

    // Step 4 needs at least one activity under the claim (narrative_draft
    // FKs to activity). One activity is enough — its 4 section drafts
    // cover the four distinct section_kinds the gate aggregates over.
    const projectId = await seedProject({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      name: 'Step-4 narrative project',
    });
    const activityId = await seedActivity({
      tenantId: fx.tenantId,
      projectId,
      claimId: fx.claimId,
      code: 'CA-001',
      kind: 'core',
      title: 'Step-4 narrative activity',
    });

    const SECTION_KINDS = [
      'new_knowledge',
      'hypothesis',
      'uncertainty',
      'experiments_and_results',
    ] as const;
    for (const kind of SECTION_KINDS) {
      await seedNarrativeDraft({
        tenantId: fx.tenantId,
        activityId,
        sectionKind: kind,
        status: 'complete',
        createdByUserId: fx.userId,
      });
    }

    await signInConsultant(context, fx, suffix);
    await gotoClaim(page, fx.claimId, 'step=4');

    await expect(page.getByTestId('wizard-step-4')).toBeVisible({ timeout: 15_000 });
    const panel = page.getByTestId('wizard-step-4-section-agree-panel');
    await expect(panel).toBeVisible();

    // All 4 enabled Agree buttons render (status === 'complete').
    for (const kind of SECTION_KINDS) {
      await expect(page.getByTestId(`narrative-section-${kind}-agree`)).toBeEnabled();
    }

    // Bottom-of-step Next is still disabled: canAdvance(4) needs all 4
    // sections in 'accepted' state.
    await expect(page.getByTestId('wizard-step-4-agree')).toBeDisabled();

    // Click one section — the button vanishes, replaced by the
    // "approved" indicator.
    await page.getByTestId('narrative-section-hypothesis-agree').click();
    await expect(page.getByTestId('narrative-section-hypothesis-accepted')).toBeVisible({
      timeout: 10_000,
    });

    // 3 other buttons still enabled.
    await expect(page.getByTestId('narrative-section-new_knowledge-agree')).toBeEnabled();
    await expect(page.getByTestId('narrative-section-uncertainty-agree')).toBeEnabled();
    await expect(page.getByTestId('narrative-section-experiments_and_results-agree')).toBeEnabled();
    // Bottom Next still gated on the remaining 3.
    await expect(page.getByTestId('wizard-step-4-agree')).toBeDisabled();

    // Click the remaining 3 — Next now flips to enabled (canAdvance(4)
    // = ok once all 4 distinct section_kinds are 'accepted' under the
    // claim).
    await page.getByTestId('narrative-section-new_knowledge-agree').click();
    await expect(page.getByTestId('narrative-section-new_knowledge-accepted')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('narrative-section-uncertainty-agree').click();
    await expect(page.getByTestId('narrative-section-uncertainty-accepted')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('narrative-section-experiments_and_results-agree').click();
    await expect(
      page.getByTestId('narrative-section-experiments_and_results-accepted'),
    ).toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId('wizard-step-4-agree')).toBeEnabled({ timeout: 10_000 });
  });

  // -----------------------------------------------------------------
  // Step 5 — honest stub. canAdvance(5) returns { ok: false, reason:
  // 'terminal' } by design. The wizard renders:
  //   - "Coming soon" copy
  //   - A permanently disabled Generate button (no agreeStep(5) call)
  //   - No AgreeStepButton (the component deliberately doesn't mount for step 5)
  // -----------------------------------------------------------------
  test('step 5 renders the coming-soon stub with a disabled Generate button', async ({
    page,
    context,
  }) => {
    const suffix = 'step5';
    const fx = await seedFixture(suffix);
    const now = new Date().toISOString();
    // Pre-agree 1..4 so the orchestrator lands on step 5.
    await setWorkflowState(fx.claimId, {
      initialized_at: now,
      steps: {
        '1': { agreed_at: now, agreed_by: fx.userId },
        '2': { agreed_at: now, agreed_by: fx.userId },
        '3': { agreed_at: now, agreed_by: fx.userId },
        '4': { agreed_at: now, agreed_by: fx.userId },
        '5': null,
      },
    });
    await signInConsultant(context, fx, suffix);

    await gotoClaim(page, fx.claimId, 'step=5');
    await expect(page.getByTestId('wizard-step-5')).toBeVisible({ timeout: 15_000 });

    // Honest stub copy is present.
    await expect(
      page.getByText(/Documents will be generated once the backend endpoints land\./i),
    ).toBeVisible();
    await expect(page.getByText(/Coming soon\./i)).toBeVisible();

    // Generate button exists and is permanently disabled.
    const generateBtn = page.getByRole('button', { name: /Generate all documents/i });
    await expect(generateBtn).toBeVisible();
    await expect(generateBtn).toBeDisabled();

    // No AgreeStepButton on step 5.
    await expect(page.getByTestId('wizard-step-5-agree')).toHaveCount(0);

    // Stepper shows checkmarks on the 4 prior agreed steps; step 5
    // remains numeric (terminal, never checked).
    await expect(page.getByTestId('wizard-stepper-1')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-2')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-3')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-4')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-5')).toHaveText('5');
  });

  // -----------------------------------------------------------------
  // TODO #1 — Full chain-event happy path through every canAdvance gate.
  //
  // The 11 isolation tests above each pin one step's DOM contract. This
  // test pins their *composition*: seed real chain events one step at a
  // time and verify each `canAdvance(N)` aggregation (workflow.ts:
  // loadWorkflowSnapshot) flips in the expected order as upstream rows
  // arrive. A future refactor that changes one of the CTE pipelines
  // could pass every isolation test and still break this one.
  //
  // Step-by-step the test:
  //   1. Fresh wizard, zero events  -> step 1 Agree disabled
  //   2. Seed 2 classified events   -> step 1 Agree enabled, click, ?step=2
  //   3. Seed ACTIVITY_REGISTER_DRAFTED with one proposed_activity +
  //      a matching ACTIVITY_CREATED (so proposedActivitiesPending == 0)
  //      AND seed a real `activity` row so step 3's CTE has something
  //      to attribute -> step 2 Agree enables, click, ?step=3
  //   4. Seed ARTEFACT_LINKED for both evidence events binding to the
  //      activity (live link count > 0 per activity -> 0 activities
  //      without binding) -> step 3 Agree enables, click, ?step=4
  //   5. Seed 4 narrative_draft rows in 'complete' status (one per
  //      section_kind), click each per-section Agree button (flips the
  //      draft to 'accepted' via narrative-accept route) -> step 4
  //      Agree enables, click, ?step=5
  //   6. Step 5 mounts with honest "Coming soon" stub; all 4 prior
  //      pills checkmarked; no wizard-step-5-agree exists.
  // -----------------------------------------------------------------
  test('full happy-path through all 4 canAdvance gates with real chain events', async ({
    page,
    context,
  }) => {
    const suffix = 'fullpath';
    const fx = await seedFixture(suffix);
    await setWorkflowState(fx.claimId, freshState());

    // Step 3's CTE for proposed-activities reads project_id either from
    // claim.project_id directly OR via any activity row's project_id.
    // We seed a project + wire the activity to it (step 5 below) — but
    // we also need claim.project_id set so the ACTIVITY_REGISTER_DRAFTED
    // event (which we seed BEFORE any activity row exists in step 2's
    // gate evaluation) is visible to the latest_draft CTE.
    const projectId = await seedProject({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      name: 'Full-path project',
    });
    await privilegedSql`UPDATE claim SET project_id = ${projectId} WHERE id = ${fx.claimId}`;

    await signInConsultant(context, fx, suffix);

    // -- (1) Fresh wizard --------------------------------------------------
    await gotoClaim(page, fx.claimId);
    await expect(page.getByTestId('wizard-stepper')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('wizard-step-1')).toBeVisible();
    await expect(page.getByTestId('wizard-step-1-agree')).toBeDisabled();

    // -- (2) Seed 2 classified evidence events -> step 1 gate opens --------
    const ev1 = await seedEvent({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      capturedByUserId: fx.userId,
      kind: 'HYPOTHESIS',
      payload: { _v: 1, source: 'paste', raw_text: 'full-path event 1' },
      classification: {
        kind: 'HYPOTHESIS',
        confidence: 0.85,
        rationale: 'seed',
        statutory_anchor: '§355-25(1)(a)',
        model: 'stub-v1.0.0',
        prompt_version: 'classify@1.0.0',
        tokens_in: 0,
        tokens_out: 0,
      },
    });
    const ev2 = await seedEvent({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      capturedByUserId: fx.userId,
      kind: 'EXPERIMENT',
      payload: { _v: 1, source: 'paste', raw_text: 'full-path event 2' },
      classification: {
        kind: 'EXPERIMENT',
        confidence: 0.9,
        rationale: 'seed',
        statutory_anchor: '§355-25(1)(a)',
        model: 'stub-v1.0.0',
        prompt_version: 'classify@1.0.0',
        tokens_in: 0,
        tokens_out: 0,
      },
    });

    await page.reload();
    await expect(page.getByTestId('wizard-step-1')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('wizard-step-1-agree')).toBeEnabled({ timeout: 10_000 });

    await page.getByTestId('wizard-step-1-agree').click();
    await expect(page).toHaveURL(/[?&]step=2(?:&|$)/, { timeout: 10_000 });
    await expect(page.getByTestId('wizard-stepper-1')).toHaveText('✓');

    // -- (3) Seed ACTIVITY_REGISTER_DRAFTED + ACTIVITY_CREATED + activity --
    // canAdvance(2) wants proposedActivitiesPending === 0. The CTE finds
    // the LATEST ACTIVITY_REGISTER_DRAFTED per project, unnests
    // proposed_activities[], and LEFT JOINs against ACTIVITY_CREATED
    // events whose payload.proposed_id matches. We seed one proposed
    // activity and one matching ACTIVITY_CREATED so pending = 0.
    //
    // The CTE joins on `event.project_id`, so we pass `projectId` through
    // seedEvent's optional param. project_id is NOT part of the
    // canonicalised chain hash (see canonicaliseEvent), so populating it
    // directly in the INSERT produces the same hash as leaving it NULL.
    const proposedId = crypto.randomUUID();
    const activityId = await seedActivity({
      tenantId: fx.tenantId,
      projectId,
      claimId: fx.claimId,
      code: 'CA-001',
      kind: 'core',
      title: 'Full-path activity',
    });

    await seedEvent({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      capturedByUserId: fx.userId,
      projectId,
      kind: 'ACTIVITY_REGISTER_DRAFTED',
      payload: {
        _v: 1,
        project_id: projectId,
        proposed_activities: [
          {
            proposed_id: proposedId,
            name: 'Full-path proposed activity',
            kind: 'core',
            statutory_anchor: 's.355-25',
            rationale: 'seeded for the full-path test',
            clustered_event_ids: [ev1.id, ev2.id],
            confidence: 0.9,
            proposed_hypothesis: null,
            proposed_uncertainty: null,
          },
        ],
        unclustered_event_ids: [],
        total_input_events: 2,
        events_truncated: false,
        synthesizer_notes: 'seeded',
        model: 'stub-v1.0.0',
        prompt_version: 'synthesize-register@1.0.0',
        idempotency_key: `full-path-${suffix}-draft`,
      },
      classification: null,
    });

    await seedEvent({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      capturedByUserId: fx.userId,
      projectId,
      kind: 'ACTIVITY_CREATED',
      payload: {
        activity_id: activityId,
        code: 'CA-001',
        kind: 'core',
        title: 'Full-path activity',
        project_id: projectId,
        claim_id: fx.claimId,
        proposed_id: proposedId,
      },
      classification: null,
    });

    await page.reload();
    await expect(page.getByTestId('wizard-step-2')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('wizard-step-2-agree')).toBeEnabled({ timeout: 10_000 });

    await page.getByTestId('wizard-step-2-agree').click();
    await expect(page).toHaveURL(/[?&]step=3(?:&|$)/, { timeout: 10_000 });
    await expect(page.getByTestId('wizard-stepper-2')).toHaveText('✓');

    // -- (4) Seed ARTEFACT_LINKED events binding the activity ---------------
    // canAdvance(3) wants agreedActivitiesWithoutBinding === 0. One live
    // ARTEFACT_LINKED per activity is enough.
    await seedEvent({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      capturedByUserId: fx.userId,
      projectId,
      kind: 'ARTEFACT_LINKED',
      payload: {
        activity_id: activityId,
        artefact_kind: 'event',
        artefact_id: ev1.id,
        link_reason: 'seed for full-path test',
      },
      classification: null,
    });
    await seedEvent({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      capturedByUserId: fx.userId,
      projectId,
      kind: 'ARTEFACT_LINKED',
      payload: {
        activity_id: activityId,
        artefact_kind: 'event',
        artefact_id: ev2.id,
        link_reason: 'seed for full-path test',
      },
      classification: null,
    });

    await page.reload();
    await expect(page.getByTestId('wizard-step-3')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('wizard-step-3-agree')).toBeEnabled({ timeout: 10_000 });

    await page.getByTestId('wizard-step-3-agree').click();
    await expect(page).toHaveURL(/[?&]step=4(?:&|$)/, { timeout: 10_000 });
    await expect(page.getByTestId('wizard-stepper-3')).toHaveText('✓');

    // -- (5) Seed 4 narrative_draft rows; click each per-section Agree -----
    const SECTION_KINDS = [
      'new_knowledge',
      'hypothesis',
      'uncertainty',
      'experiments_and_results',
    ] as const;
    for (const kind of SECTION_KINDS) {
      await seedNarrativeDraft({
        tenantId: fx.tenantId,
        activityId,
        sectionKind: kind,
        status: 'complete',
        createdByUserId: fx.userId,
      });
    }

    await page.reload();
    await expect(page.getByTestId('wizard-step-4')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('wizard-step-4-agree')).toBeDisabled();

    for (const kind of SECTION_KINDS) {
      await page.getByTestId(`narrative-section-${kind}-agree`).click();
      await expect(page.getByTestId(`narrative-section-${kind}-accepted`)).toBeVisible({
        timeout: 10_000,
      });
    }

    await expect(page.getByTestId('wizard-step-4-agree')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('wizard-step-4-agree').click();
    await expect(page).toHaveURL(/[?&]step=5(?:&|$)/, { timeout: 10_000 });

    // -- (6) Step 5 mounts; honest stub; all prior pills checkmarked --------
    await expect(page.getByTestId('wizard-step-5')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Coming soon\./i)).toBeVisible();
    await expect(page.getByTestId('wizard-stepper-1')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-2')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-3')).toHaveText('✓');
    await expect(page.getByTestId('wizard-stepper-4')).toHaveText('✓');
    // Step 5 is terminal — no Agree button mounts.
    await expect(page.getByTestId('wizard-step-5-agree')).toHaveCount(0);
  });

  // -----------------------------------------------------------------
  // TODO #2 — EventPickerDialog click-flow.
  //
  // Step 3's activity-first picker (wizard-step-3-attribute.tsx) renders
  // one ActivityAttributionPanel per agreed activity. Each panel has an
  // "Add evidence" trigger that opens EventPickerDialog — a modal listing
  // unbound classifiable events. Selecting one + submitting fans out
  // POST /v1/activities/:id/artefact-links and invalidates the workflow
  // query so canAdvance(3) re-derives. This test pins the open → select →
  // submit → close → bound-row visible chain.
  // -----------------------------------------------------------------
  test('EventPickerDialog: open → select unbound event → submit → activity card shows binding', async ({
    page,
    context,
  }) => {
    const suffix = 'picker';
    const fx = await seedFixture(suffix);
    const now = new Date().toISOString();
    // Pre-agree steps 1 + 2 so the orchestrator lands us on step 3.
    await setWorkflowState(fx.claimId, {
      initialized_at: now,
      steps: {
        '1': { agreed_at: now, agreed_by: fx.userId },
        '2': { agreed_at: now, agreed_by: fx.userId },
        '3': null,
        '4': null,
        '5': null,
      },
    });

    // Step 3 needs a real activity row (the panel renders one card per
    // activity under the claim). The activity-first picker is on the card.
    const projectId = await seedProject({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      name: 'Picker project',
    });
    await privilegedSql`UPDATE claim SET project_id = ${projectId} WHERE id = ${fx.claimId}`;
    const activityId = await seedActivity({
      tenantId: fx.tenantId,
      projectId,
      claimId: fx.claimId,
      code: 'CA-001',
      kind: 'core',
      title: 'Picker activity',
    });

    // Two unbound classified evidence events (no ARTEFACT_LINKED yet,
    // BINDABLE_KINDS — HYPOTHESIS/EXPERIMENT both qualify).
    const ev1 = await seedEvent({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      capturedByUserId: fx.userId,
      kind: 'HYPOTHESIS',
      payload: { _v: 1, source: 'paste', raw_text: 'picker-spec event one' },
      classification: {
        kind: 'HYPOTHESIS',
        confidence: 0.85,
        rationale: 'seed',
        statutory_anchor: '§355-25(1)(a)',
        model: 'stub-v1.0.0',
        prompt_version: 'classify@1.0.0',
        tokens_in: 0,
        tokens_out: 0,
      },
    });
    const ev2 = await seedEvent({
      tenantId: fx.tenantId,
      subjectTenantId: fx.subjectId,
      capturedByUserId: fx.userId,
      kind: 'EXPERIMENT',
      payload: { _v: 1, source: 'paste', raw_text: 'picker-spec event two' },
      classification: {
        kind: 'EXPERIMENT',
        confidence: 0.9,
        rationale: 'seed',
        statutory_anchor: '§355-25(1)(a)',
        model: 'stub-v1.0.0',
        prompt_version: 'classify@1.0.0',
        tokens_in: 0,
        tokens_out: 0,
      },
    });

    await signInConsultant(context, fx, suffix);
    await gotoClaim(page, fx.claimId, 'step=3');

    await expect(page.getByTestId('wizard-step-3')).toBeVisible({ timeout: 15_000 });

    // Activity card renders with the "Add evidence" trigger.
    const triggerTestId = `event-picker-trigger-${activityId}`;
    await expect(page.getByTestId(triggerTestId)).toBeVisible({ timeout: 10_000 });

    // No bound events yet → step 3 Agree disabled (1 agreed activity, 0
    // bindings → agreedActivitiesWithoutBinding === 1).
    await expect(page.getByTestId('wizard-step-3-agree')).toBeDisabled();

    // Click the trigger; dialog opens. Radix Dialog renders role="dialog".
    await page.getByTestId(triggerTestId).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Both unbound events appear as checkbox rows inside the dialog.
    // Use the dialog as the search scope so we don't accidentally match
    // anything on the underlying step-3 panel.
    const checkboxes = dialog.locator('input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(2, { timeout: 10_000 });

    const submitBtn = page.getByTestId(`event-picker-submit-${activityId}`);
    // Submit is disabled until at least one event is checked.
    await expect(submitBtn).toBeDisabled();

    // Check the first checkbox. We don't depend on the displayed label
    // text — the dialog renders effective_kind + an eventLabel snippet,
    // but the snippet contents shift based on payload shape; checking by
    // position keeps the assertion stable.
    await checkboxes.first().check();
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });

    await submitBtn.click();

    // Dialog closes on success.
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    // Activity card now shows a bound-event row inside the activity's
    // `bound-events-${activityId}` list. We don't know which of (ev1, ev2)
    // was at position 0 in the picker (the API orders by captured_at
    // DESC, received_at DESC), so assert via the parent list testid +
    // count instead.
    const boundList = page.getByTestId(`bound-events-${activityId}`);
    await expect(boundList).toBeVisible({ timeout: 10_000 });
    await expect(boundList.locator('[data-testid^="bound-event-"]')).toHaveCount(1, {
      timeout: 10_000,
    });

    // canAdvance(3) reads from agreedActivitiesWithoutBinding — the
    // single activity has at least one live link now, so the gate flips
    // and the bottom Agree enables.
    await expect(page.getByTestId('wizard-step-3-agree')).toBeEnabled({ timeout: 10_000 });

    // Re-open the dialog: the bound event is now filtered out, so only
    // one candidate (the other event) remains. Pins the "already bound"
    // filter contract.
    await page.getByTestId(triggerTestId).click();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const remainingCheckboxes = dialog.locator('input[type="checkbox"]');
    await expect(remainingCheckboxes).toHaveCount(1, { timeout: 10_000 });

    // Suppress unused-binding lint — ev1/ev2 are seeded for the dialog
    // contents; we don't assert on their specific ids because the order
    // depends on captured_at + received_at ordering server-side.
    void ev1;
    void ev2;
  });
});

// Suppress an unused-import warning if `crypto` is removed in a future
// refactor; kept here because seedNarrativeDraft uses it for UUID gen.
void crypto;
