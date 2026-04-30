// Placeholder Detox smoke test — actual test infra wired in D9-D10.
// This file exists so the e2e/ directory is part of the repo and the
// test framework choice (Detox) is committed.

describe('Foundation smoke', () => {
  // SKIP-POLICY (see /SKIP-POLICY.md): the Detox runner is not yet
  // wired up — the framework choice is committed but the simulator
  // config + EAS internal build artefacts arrive in D9-D10. Re-test
  // trigger: when `apps/mobile/.detoxrc.js` lands and an EAS internal
  // build is available, drop the `.skip` and run `pnpm --filter
  // @cpa/mobile e2e`. P5 plan reference (Theme 7 Task 7.2): docs/
  // plans/2026-04-30-p5-implementation.md. A9 precedent: f111458.
  it.skip('launches app and shows login screen', async () => {
    // await device.launchApp();
    // await expect(element(by.text('CPA Scribe'))).toBeVisible();
  });
});
