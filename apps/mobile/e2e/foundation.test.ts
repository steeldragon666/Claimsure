// Placeholder Detox smoke test — actual test infra wired in D9-D10.
// This file exists so the e2e/ directory is part of the repo and the
// test framework choice (Detox) is committed.

describe('Foundation smoke', () => {
  it.skip('launches app and shows login screen', async () => {
    // TODO: wire after EAS internal build artefacts available
    // await device.launchApp();
    // await expect(element(by.text('CPA Scribe'))).toBeVisible();
  });
});
