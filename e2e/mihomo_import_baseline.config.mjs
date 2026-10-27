// Opt-in historical capture: not part of the normal regression suite.
import baseConfig from '../playwright.config.mjs';

export default {
  ...baseConfig,
  testDir: '.',
  testMatch: 'mihomo_import_stage0_baseline.capture.mjs',
  workers: 1,
};
