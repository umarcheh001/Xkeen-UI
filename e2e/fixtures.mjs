import { test as base, expect } from '@playwright/test';


// The application persists UI preferences server-side. Individual browser tests
// may switch the editor backend or toggle schema help, but those preferences
// are not part of a test's precondition. Keep that mutable API state in the
// browser context so one spec cannot alter the next spec's initial UI.
//
// The persistence API itself is covered by the Python contract tests. E2E
// tests cover consumers of this API and need a fresh, realistic snapshot.
const DEFAULT_UI_SETTINGS = {
  schemaVersion: 2,
  editor: {
    engine: 'codemirror',
    codemirrorFontScale: 100,
    monacoFontScale: 100,
    schemaHoverEnabled: true,
    beginnerModeEnabled: true,
    expertModeEnabled: false,
  },
  format: {
    preferPrettier: false,
    tabWidth: 2,
    printWidth: 80,
  },
  logs: {
    ansi: false,
    ws2: false,
    view: {},
  },
  routing: {
    guiEnabled: true,
    autoApply: false,
    showActiveOutbound: false,
    showScenarioCard: true,
  },
};


function clone(value) {
  return JSON.parse(JSON.stringify(value));
}


function merge(baseValue, patchValue) {
  const base = baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue)
    ? baseValue
    : {};
  const patch = patchValue && typeof patchValue === 'object' && !Array.isArray(patchValue)
    ? patchValue
    : {};
  const result = clone(base);

  for (const [key, value] of Object.entries(patch)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(result[key], value)
      : clone(value);
  }

  return result;
}


export const test = base.extend({
  page: async ({ page }, use) => {
    let settings = clone(DEFAULT_UI_SETTINGS);

    // A previous browser context can leave the last selected panel view in
    // origin storage. Tests navigate to '/', but they do not all declare the
    // remembered view as part of their setup. Reset only test-owned UI
    // preferences before application scripts observe localStorage.
    await page.addInitScript(() => {
      localStorage.removeItem('xkeen.panel.last_view.v1');
      localStorage.removeItem('xkeen.routing.editor.engine');
      localStorage.removeItem('xkeen.outbounds.fragment');
      localStorage.removeItem('xkeen_inbounds_open');
      localStorage.removeItem('xkeen_outbounds_open');
      localStorage.removeItem('xk.routing.scenario.open.v1');
      localStorage.removeItem('xk.routing.dat.open.v3');
      localStorage.removeItem('xk.routing.backups.open.v1');
      localStorage.removeItem('xk.routing.help.open.v1');
      localStorage.removeItem('xk.routing.rules.open.v2');
      localStorage.removeItem('xk.routing.focus-mode.v1');
      localStorage.removeItem('xkeen.fm.panels.v1');
    });

    await page.route('**/api/ui-settings', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({ json: { ok: true, settings } });
        return;
      }

      if (request.method() === 'PATCH') {
        let patch = {};
        try {
          patch = request.postDataJSON() || {};
        } catch (error) {
          patch = {};
        }
        settings = merge(settings, patch);
        await route.fulfill({ json: { ok: true, settings } });
        return;
      }

      await route.fallback();
    });

    await use(page);
  },
});


export { expect };
