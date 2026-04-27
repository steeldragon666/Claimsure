/**
 * Detox configuration for the CPA Scribe mobile app (T-F17 placeholder).
 *
 * Real wiring lands with D9-D10 — this file exists so the e2e test
 * framework choice is committed and the directory is part of the repo.
 * Until then `detox` itself isn't installed (see package.json devDeps:
 * the entry is present but `pnpm install` won't pull it because
 * .detoxrc.js is referenced only by the detox CLI, not Metro/Expo).
 *
 * Single configuration covered for v1: iOS sim debug. Android + EAS
 * cloud builds land with D9; the iOS sim is what local devs run before
 * pushing.
 */
module.exports = {
  testRunner: { args: { $0: 'jest', config: 'e2e/jest.config.js' } },
  apps: {
    'ios.sim.debug': {
      type: 'ios.app',
      binaryPath: 'ios/build/Build/Products/Debug-iphonesimulator/CpaScribe.app',
      build:
        'xcodebuild -workspace ios/CpaScribe.xcworkspace -scheme CpaScribe -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build',
    },
  },
  configurations: {
    'ios.sim.debug': { device: { type: 'iPhone 15' }, app: 'ios.sim.debug' },
  },
};
