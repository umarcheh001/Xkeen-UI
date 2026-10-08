# Module Manager UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core-owned `/modules` screen that safely manages official
modules, panel updates, profile transitions, restart, and recovery through the
existing Stage 8 Lifecycle API.

**Architecture:** Add a sixth canonical top-level screen with a small,
core-owned template and a lazy lifecycle controller. The controller owns only
browser state and calls the existing Lifecycle and registry APIs; the server
continues to own catalog trust, plans, apply, status, cancellation, recovery,
and restart. Stable DevTools update UI becomes a navigation pointer to this
screen, while the development-only `main` UI remains in DevTools.

**Tech Stack:** Flask/Jinja, vanilla ES2022 modules, Vite 8 build bridges,
existing top-level screen host/router, existing shared UI primitives, pytest,
Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-modular-panel-stage8-6-manager-ui-design.md`

## Global Constraints

- `/modules` is core-owned and must render for `core-only`, Xray-only,
  Mihomo-only, Full, and legacy activation states.
- Initial entry may request only `GET /api/modules/installed` and
  `GET /api/modules/operations/status`; it must not fetch the catalog or
  probe DevTools update endpoints.
- `GET /api/modules/available` runs only after the Available tab is opened.
  A panel version check is `POST /api/modules/operations/plan` with
  `{"operation":"panel-update"}`.
- Lifecycle actions always follow server plan -> explicit confirmation ->
  apply using the returned `plan_id`. The browser never sends URLs, hashes,
  file lists, dependency lists, or free-space values.
- The manager imports no `features/devtools/*`, `features/compat/devtools.js`,
  or advanced-diagnostics bundle. It may reuse core primitives only.
- No catalog background polling is added. The update badge is per-tab
  `sessionStorage` state written only after an explicit panel-update plan.
- In the stable channel, DevTools has no separate check/apply/status/cancel/
  restart/rollback UI. In the `main` channel its existing development UI and
  notifier behavior remain operational.
- Keep the existing Lifecycle API, registry API, and DevTools compatibility
  endpoints backward-compatible. This stage adds a page route and frontend
  behavior, not a second lifecycle backend.
- Use red-green-refactor and create a small focused commit after every task.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `xkeen-ui/routes/pages.py` | Core `/modules` page route and panel navigation entry. |
| `xkeen-ui/templates/modules.html` | Manager DOM shell, tabs, lifecycle placeholders, plan dialog, and top-level header. |
| `xkeen-ui/static/modules-manager.css` | Responsive manager-specific presentation using existing operator tokens. |
| `xkeen-ui/static/js/pages/modules.entry.js` | Thin sixth canonical entry wrapper. |
| `xkeen-ui/static/js/pages/modules.screen.bootstrap.js` | Page bootstrap and top-level runtime adapter. |
| `xkeen-ui/static/js/pages/modules.init.js` | DOM-ready manager startup and top-level navigation wiring. |
| `xkeen-ui/static/js/pages/top_level_modules_screen.js` | Lazy snapshot/mount/activate/deactivate adapter matching Backups. |
| `xkeen-ui/static/js/pages/top_level_screen_registry.js` | `/modules` route registry entry. |
| `xkeen-ui/static/js/pages/top_level_panel_mihomo.shared.js` | Registers the modules screen from every canonical entrypoint. |
| `xkeen-ui/static/js/features/module_manager/api.js` | Strict public-Lifecycle fetch adapter and normalized safe errors. |
| `xkeen-ui/static/js/features/module_manager/badge.js` | Per-tab explicit update badge persistence and DOM synchronization. |
| `xkeen-ui/static/js/features/module_manager/render.js` | Escaped rendering for cards, plan details, errors, status, and log. |
| `xkeen-ui/static/js/features/module_manager/controller.js` | Local state, tab/actions, plan/apply flow, operation polling, cancel/recovery/restart. |
| `xkeen-ui/static/js/features/update_notifier.js` | Disables legacy stable-channel probing; preserves `main` notifier behavior. |
| `xkeen-ui/templates/devtools.html` | Stable manager notice plus retained hidden/legacy `main` updater surface. |
| `xkeen-ui/static/js/features/devtools/update.js` | Chooses the stable pointer or the existing `main` updater after local channel detection. |
| `xkeen-ui/templates/{panel/navigation,backups,devtools,xkeen,mihomo_generator}.html` | Core-owned navigation link and shared badge host. |
| `vite.config.mjs`, `xkeen-ui/routes/ui_assets.py`, `scripts/verify_frontend_build.mjs` | Sixth canonical frontend source/build/bridge entry. |
| `scripts/generate_frontend_inventory.py`, `scripts/generate_modular_panel_inventory.py` | Include the core manager page in generated inventories. |
| `tests/test_module_manager_ui.py` | Flask/template, source-graph, ownership, and channel-boundary contracts. |
| `e2e/modules_manager.spec.mjs` | Browser lifecycle UI, explicit-fetch, confirmation, recovery, responsive, and keyboard flows. |
| Existing frontend inventory/build/guardrail tests | Update fixed five-page assertions to the six-page core contract. |
| `docs/modular-panel-stage8-manager-ui.md` | Operator guide for the manager and safe recovery boundaries. |
| Stage 8 and frontend inventory documents | Mark 8.6 closed and record the sixth top-level screen. |

### Task 1: Add The Core Route And Sixth Top-Level Screen Contract

**Files:**
- Create: `xkeen-ui/templates/modules.html`
- Create: `xkeen-ui/static/modules-manager.css`
- Create: `xkeen-ui/static/js/pages/modules.entry.js`
- Create: `xkeen-ui/static/js/pages/modules.screen.bootstrap.js`
- Create: `xkeen-ui/static/js/pages/modules.init.js`
- Create: `xkeen-ui/static/js/pages/top_level_modules_screen.js`
- Modify: `xkeen-ui/routes/pages.py`
- Modify: `xkeen-ui/static/js/pages/top_level_screen_registry.js`
- Modify: `xkeen-ui/static/js/pages/top_level_panel_mihomo.shared.js`
- Modify: `xkeen-ui/templates/panel/navigation.html`
- Modify: `xkeen-ui/templates/backups.html`
- Modify: `xkeen-ui/templates/devtools.html`
- Modify: `xkeen-ui/templates/xkeen.html`
- Modify: `xkeen-ui/templates/mihomo_generator.html`
- Test: `tests/test_module_manager_ui.py`
- Test: `tests/test_frontend_runtime_hotfixes.py`

**Interfaces:**
- Produces the unconditional Flask endpoint `modules_page` at `/modules`.
- Produces top-level screen name `modules` with route `/modules`.
- Produces `bootModulesScreen()` and `getModulesTopLevelApi()`; Task 2 adds
  Lifecycle behavior behind this same adapter.

- [ ] **Step 1: Write failing Flask and source-graph tests**

  Create `tests/test_module_manager_ui.py` with a core-only render test and
  add `modules` expectations to the existing top-level guardrail tests:

  ```python
  def test_modules_page_is_core_owned_and_uses_its_canonical_entry(tmp_path):
      app = build_panel_app(["core"], tmp_path)
      response = app.test_client().get("/modules")

      assert response.status_code == 200
      html = response.get_data(as_text=True)
      assert 'data-xk-top-level-screen="modules"' in html
      assert 'window.XKeen.pageConfig = pageConfig;' in html
      assert "frontend_page_entry_url('modules')" in html
      assert "devtools.screen.bootstrap.js" not in html

  def test_top_level_registry_exposes_modules_route_and_core_navigation():
      registry = (PAGES / "top_level_screen_registry.js").read_text(encoding="utf-8")
      panel_routes = (ROOT / "xkeen-ui/routes/pages.py").read_text(encoding="utf-8")

      assert "modules: '/modules'" in registry
      assert 'href_endpoint="modules_page", top_nav=True' in panel_routes
  ```

  Extend `test_frontend_runtime_hotfixes.py` so the canonical registrar list,
  source-entry thin-wrapper assertions, and route map expect `modules` rather
  than the frozen five-screen set.

- [ ] **Step 2: Run the targeted tests to verify they fail**

  Run:

  ```powershell
  python -m pytest tests/test_module_manager_ui.py tests/test_frontend_runtime_hotfixes.py -q
  ```

  Expected: FAIL because `/modules`, the `modules` route entry, and all
  modules screen files do not yet exist.

- [ ] **Step 3: Implement the page shell and navigation registration**

  Add an unconditional `modules_page` alongside `index` in
  `register_pages_routes`; render `modules.html` through `_no_cache` and use
  endpoint name `modules_page`.

  Make `modules.html` follow the top-level host partial contract used by
  Backups: publish only `pageConfig` with `page: "modules"`, set
  `body.modules-page data-xk-top-level-screen="modules"`, include
  `styles.css` and `modules-manager.css`, global spinner, accessible header,
  Installed/Available tab buttons, an operation region with `aria-live`, an
  empty card host, a native dialog/modal-style plan confirmation with explicit
  Cancel/Apply buttons, and the modules entry script. Do not put API data in
  the template.

  Add the thin entry and screen adapters using the Backups naming/lifecycle
  pattern:

  ```js
  // modules.entry.js
  void bootTopLevelShell({
    initialScreen: 'modules',
    bootstrap() { return bootModulesScreen(); },
  }).then(() => { registerPanelMihomoTopLevelScreens(); });
  ```

  `top_level_modules_screen.js` must validate `#xk-modules-manager` as its
  snapshot marker, use `createScreenActivationTracker()`, and detach the
  snapshot on deactivation. `modules.init.js` must call
  `wireTopLevelNavigation(document)` before booting the manager. Until Task 2
  adds the controller, `modules.screen.bootstrap.js` returns a no-op
  top-level API with `activate`, `deactivate`, `serializeState`, and
  `restoreState`, so this task's direct page and in-place navigation work on
  their own.

  Add the route to `TOP_LEVEL_SCREEN_ROUTES`, import/register it in
  `top_level_panel_mihomo.shared.js`, and add a `PanelNavigationEntry` owned
  by `core`. Add an equivalent `data-xk-top-nav="1"` link to the four
  standalone headers. The manager header links back to `/` and shows DevTools
  only when `ui_endpoint_available('devtools_page')` is true.

- [ ] **Step 4: Run the targeted tests to verify they pass**

  Run:

  ```powershell
  python -m pytest tests/test_module_manager_ui.py tests/test_frontend_runtime_hotfixes.py -q
  ```

  Expected: PASS. A core-only render returns the modules shell and all six
  routes can be registered by the top-level router.

- [ ] **Step 5: Commit the page shell contract**

  ```powershell
  git add xkeen-ui/routes/pages.py xkeen-ui/templates/modules.html xkeen-ui/templates/panel/navigation.html xkeen-ui/templates/backups.html xkeen-ui/templates/devtools.html xkeen-ui/templates/xkeen.html xkeen-ui/templates/mihomo_generator.html xkeen-ui/static/modules-manager.css xkeen-ui/static/js/pages/modules.entry.js xkeen-ui/static/js/pages/modules.screen.bootstrap.js xkeen-ui/static/js/pages/modules.init.js xkeen-ui/static/js/pages/top_level_modules_screen.js xkeen-ui/static/js/pages/top_level_screen_registry.js xkeen-ui/static/js/pages/top_level_panel_mihomo.shared.js tests/test_module_manager_ui.py tests/test_frontend_runtime_hotfixes.py
  git commit -m "feat: add core modules manager screen shell"
  ```

### Task 2: Implement Explicit Lifecycle Loading, Tabs, And Per-Tab Badge

**Files:**
- Create: `xkeen-ui/static/js/features/module_manager/api.js`
- Create: `xkeen-ui/static/js/features/module_manager/badge.js`
- Create: `xkeen-ui/static/js/features/module_manager/render.js`
- Create: `xkeen-ui/static/js/features/module_manager/controller.js`
- Modify: `xkeen-ui/static/js/pages/modules.init.js`
- Modify: `xkeen-ui/static/js/pages/modules.screen.bootstrap.js`
- Modify: `xkeen-ui/static/js/pages/top_level_nav.shared.js`
- Modify: `xkeen-ui/templates/modules.html`
- Modify: `xkeen-ui/templates/panel/navigation.html`
- Modify: `xkeen-ui/templates/backups.html`
- Modify: `xkeen-ui/templates/devtools.html`
- Modify: `xkeen-ui/templates/xkeen.html`
- Modify: `xkeen-ui/templates/mihomo_generator.html`
- Modify: `xkeen-ui/static/modules-manager.css`
- Test: `e2e/modules_manager.spec.mjs`
- Test: `tests/test_module_manager_ui.py`

**Interfaces:**
- `createModuleLifecycleClient(fetchImpl)` returns
  `loadInstalled()`, `loadStatus()`, `loadAvailable()`, `plan(operation,
  moduleId)`, `apply(operation, moduleId, planId)`, `cancel(operationId)`,
  `recover()`, and `restart()`.
- `setModuleEnabled(moduleId, enabled)` issues the existing registry request
  `PATCH /api/modules/${moduleId}` with `{ enabled }`; it is separate from a
  lifecycle plan and returns the registry's updated snapshot.
- `createModuleManagerController({root, api, pollMs})` returns `init()`,
  `activate()`, `deactivate()`, `serializeState()`, and `restoreState(state)`.
- `setModulesUpdateBadge({sourceVersion, targetVersion})`,
  `clearModulesUpdateBadge()`, and `syncModulesUpdateBadges(scope)` store and
  render explicit per-tab state without network I/O.

- [ ] **Step 1: Write failing browser tests for initial-load and Available-tab boundaries**

  Create the first describe block in `e2e/modules_manager.spec.mjs`. Install
  handlers before opening `/modules` and count requests:

  ```js
  test('opens installed state without downloading the catalog', async ({ page }) => {
    let availableCalls = 0;
    const enabledBodies = [];
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installedSnapshot }));
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: idleStatus }));
    await page.route('**/api/modules/available', (route) => {
      availableCalls += 1;
      return route.fulfill({ json: availableSnapshot });
    });
    await page.route('**/api/modules/engine.mihomo', (route) => {
      enabledBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: installedSnapshot });
    });

    await page.goto('/modules');
    await expect(page.getByRole('heading', { name: 'Модули и обновления' })).toBeVisible();
    await expect(page.getByText('Xkeen UI 2.10.0')).toBeVisible();
    expect(availableCalls).toBe(0);

    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByText('Терминал')).toBeVisible();
    expect(availableCalls).toBe(1);

    await page.getByRole('tab', { name: 'Установленные' }).click();
    await page.getByRole('switch', { name: 'Включить Mihomo' }).click();
    await expect.poll(() => enabledBodies).toEqual([{ enabled: true }]);
  });
  ```

  Add a source-contract test asserting that manager source imports neither
  `features/devtools/` nor `features/compat/devtools.js` and that
  `modules.entry.js` remains a thin shell wrapper.

- [ ] **Step 2: Run the new test to verify it fails**

  Run:

  ```powershell
  npx playwright test e2e/modules_manager.spec.mjs --project=chromium
  ```

  Expected: FAIL because no controller issues the two initial requests or
  renders tab content.

- [ ] **Step 3: Implement strict API and local controller state**

  In `api.js`, centralize `fetch` with `credentials: 'same-origin'`,
  `Cache-Control: no-store`, JSON-object validation, and a normalized thrown
  object `{ code, message, status }`. `plan` and `apply` must construct only:

  ```js
  { operation, ...(moduleId ? { module_id: moduleId } : {}) }
  { operation, ...(moduleId ? { module_id: moduleId } : {}), plan_id: planId }
  ```

  In `controller.js`, initialize the view by `Promise.all` of installed and
  status only. Keep `{installed, status, catalog: null, selectedTab:
  'installed', plan: null}` locally. Fetch the catalog only from the Available
  tab activation. Render panel/profile first, followed by installed module
  rows and catalog cards through escaped DOM creation/text content rather than
  interpolating server fields into HTML. Installed rows include the existing
  registry enabled switch, which calls `setModuleEnabled(moduleId, enabled)`,
  then refreshes only the installed snapshot; it never synthesizes a lifecycle
  plan. Available cards show declared dependencies/conflicts and only the
  server-provided lifecycle actions.

  Add `badge.js` using a versioned `sessionStorage` record. The record is set
  only after an applicable `panel-update` plan has a different target version;
  it is cleared for `panel_version_current`, a terminal committed update, or
  an installed snapshot whose version no longer matches its source version.
  `top_level_nav.shared.js` calls `syncModulesUpdateBadges(document)` when it
  wires a newly attached top-level screen. Add one hidden
  `[data-xk-modules-update-badge]` child to every Modules navigation control.

  `modules.screen.bootstrap.js` adapts the controller's methods to the
  top-level screen API and preserves selected tab plus scroll position, but
  not unreviewed plans.

- [ ] **Step 4: Run the loading and isolation tests to verify they pass**

  Run:

  ```powershell
  npx playwright test e2e/modules_manager.spec.mjs --project=chromium
  python -m pytest tests/test_module_manager_ui.py tests/test_frontend_migration_guardrails.py -q
  ```

  Expected: PASS. Initial navigation has exactly installed/status requests,
  Available causes one catalog request, and the source graph contains no
  DevTools import.

- [ ] **Step 5: Commit explicit loading and card rendering**

  ```powershell
  git add xkeen-ui/static/js/features/module_manager xkeen-ui/static/js/pages/modules* xkeen-ui/static/js/pages/top_level_nav.shared.js xkeen-ui/templates xkeen-ui/static/modules-manager.css tests/test_module_manager_ui.py e2e/modules_manager.spec.mjs
  git commit -m "feat: load module lifecycle state in manager"
  ```

### Task 3: Add Plan Confirmation, Apply, And Operation Monitoring

**Files:**
- Modify: `xkeen-ui/static/js/features/module_manager/api.js`
- Modify: `xkeen-ui/static/js/features/module_manager/render.js`
- Modify: `xkeen-ui/static/js/features/module_manager/controller.js`
- Modify: `xkeen-ui/templates/modules.html`
- Modify: `xkeen-ui/static/modules-manager.css`
- Test: `e2e/modules_manager.spec.mjs`
- Test: `tests/test_module_manager_ui.py`

**Interfaces:**
- The controller's `requestPlan(operation, moduleId)` stores only a successful
  public plan response and renders a confirmation.
- `applyReviewedPlan()` sends the stored `plan_id`, assigns the returned
  `operation_id` to status state, and starts polling only for `result:
  'running'`.
- `refreshInstalledAfterTerminal()` refetches installed/status and clears the
  plan/catalog after a terminal lifecycle result.

- [ ] **Step 1: Write failing plan/apply browser tests**

  Extend `e2e/modules_manager.spec.mjs` with an intercepted install flow and
  an intercepted panel-update flow:

  ```js
  test('requires a reviewed server plan before apply', async ({ page }) => {
    const planBodies = [];
    const applyBodies = [];
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/plan', async (route) => {
      planBodies.push(route.request().postDataJSON());
      await route.fulfill({ json: installPlan });
    });
    await page.route('**/api/modules/operations/apply', async (route) => {
      applyBodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, json: runningStatus });
    });

    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await page.getByRole('button', { name: 'Установить Терминал' }).click();
    await expect(page.getByRole('dialog', { name: 'План установки' })).toContainText('Нужно места: 12 МБ');
    expect(planBodies).toEqual([{ operation: 'install', module_id: 'tool.terminal' }]);

    await page.getByRole('button', { name: 'Применить план' }).click();
    expect(applyBodies).toEqual([{ operation: 'install', module_id: 'tool.terminal', plan_id: 'a'.repeat(64) }]);
  });
  ```

  Add cases for an `applicable: false` plan (no Apply button),
  `module_plan_stale`/`operation_plan_stale` (discard plan and require a
  new review), and `panel_version_current` (clear the manager badge and show
  a no-update result).

- [ ] **Step 2: Run the new tests to verify they fail**

  Run:

  ```powershell
  npx playwright test e2e/modules_manager.spec.mjs --project=chromium
  ```

  Expected: FAIL because operation action buttons do not yet request plans or
  construct lifecycle apply payloads.

- [ ] **Step 3: Implement plan dialog and operation status area**

  Render actions strictly from `lifecycle_actions` for modules plus the known
  full-scope actions `panel-update`, `panel-rollback` when
  `previous_version.available`, and `profile-transition` when
  `transition_required`. For every plan show scope/action, affected modules,
  source/target release where supplied, add/remove counts, required bytes,
  dependency diff, blockers, and restart requirement. A blocked plan remains
  visible but cannot be applied.

  On apply, disable duplicate action controls, retain the server operation id,
  and make the pinned operation region render `step`, `result`, safe
  `error_code`/`error`, timestamps, and ordered log records. Poll
  `/api/modules/operations/status` only while it reports `running`; stop the
  timer in `deactivate()` and on terminal results. Re-fetch installed/status
  once after a terminal transition and discard the catalog/plan snapshot.

  Implement explicit cancel through
  `POST /api/modules/operations/${operationId}/cancel`; it is a request and
  the UI stays in monitoring mode until status becomes terminal. Use the
  existing confirmation primitive/focus conventions: confirmation focuses its
  heading, Cancel closes without an API mutation, and focus returns to the
  invoking action.

- [ ] **Step 4: Run plan/apply tests to verify they pass**

  Run:

  ```powershell
  npx playwright test e2e/modules_manager.spec.mjs --project=chromium
  python -m pytest tests/test_module_manager_ui.py -q
  ```

  Expected: PASS. The only apply request contains a reviewed server `plan_id`,
  blocked/stale plans cannot mutate the panel, and operation state survives a
  view refresh through the status endpoint.

- [ ] **Step 5: Commit lifecycle interaction flow**

  ```powershell
  git add xkeen-ui/static/js/features/module_manager xkeen-ui/templates/modules.html xkeen-ui/static/modules-manager.css tests/test_module_manager_ui.py e2e/modules_manager.spec.mjs
  git commit -m "feat: add module lifecycle plan and operation UI"
  ```

### Task 4: Complete Recovery, Restart, Offline, And Responsive States

**Files:**
- Modify: `xkeen-ui/static/js/features/module_manager/render.js`
- Modify: `xkeen-ui/static/js/features/module_manager/controller.js`
- Modify: `xkeen-ui/templates/modules.html`
- Modify: `xkeen-ui/static/modules-manager.css`
- Modify: `e2e/modules_manager.spec.mjs`
- Test: `tests/test_module_manager_ui.py`

**Interfaces:**
- `requestRecovery()` calls `POST /api/modules/recovery` only when status
  permits it, then renders returned status without implicit restart.
- `requestRestart()` calls `POST /api/modules/restart` only when
  `restart_required` is true and no active/recovery/profile guard applies.
- `describeLifecycleFailure({code, message})` maps public errors to safe
  Russian guidance without printing a raw exception or private path.

- [ ] **Step 1: Write failing recovery/error/responsive browser tests**

  Add explicit fixtures for running, interrupted, restart-required,
  `profile_transition_required`, stale catalog, trust failure, disk blocker,
  and `rollback_failed` statuses. Assert the recovery/restart payloads and
  lockout behavior:

  ```js
  test('locks mutations after rollback_failed and exposes manual recovery boundary', async ({ page }) => {
    await installLifecycleRoutes(page, { status: rollbackFailedStatus });
    await page.goto('/modules');

    await expect(page.getByText('Восстановление файлов не завершилось')).toBeVisible();
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: 'Установить Терминал' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Восстановить операцию' })).toHaveCount(0);
  });
  ```

  Add an accessibility assertion that dialog focus moves to its heading and
  returns to the source button on cancellation. Run the manager suite at
  desktop `1440x960` and mobile `390x844`, capturing a screenshot after the
  operation area expands; assert that the controls are visible and neither
  horizontal overflow nor clipped dialog text appears.

- [ ] **Step 2: Run the new tests to verify they fail**

  Run:

  ```powershell
  npx playwright test e2e/modules_manager.spec.mjs --project=chromium
  ```

  Expected: FAIL because recovery guards, safe error mapping, and mobile
  layout behavior are not implemented yet.

- [ ] **Step 3: Implement guarded recovery and safe presentation**

  Render server-authorized recovery and restart controls separately. Never
  call restart after recovery automatically. Hide/disable restart while the
  manager has `transition_required`, active status, recovery requirement, or
  `rollback_failed`; for profile mismatch offer the profile-transition plan
  action instead. For `rollback_failed`, disable every new lifecycle action
  and show the documented manual-recovery boundary without retry advice.

  Map `catalog_unavailable`, stale catalog, trust/archive failures, blockers,
  active operation, stale plan, profile transition guard, and rollback failure
  to concise Russian text plus the public code. Preserve known installed cards
  when subsequent catalog/status requests fail. Never assign remote messages with
  `innerHTML`.

  Add responsive grid rules: panel/module cards can collapse to one column;
  metadata values wrap; plan dialog is `min(760px, calc(100vw - 24px))` wide;
  log details use a scrollable code block; controls retain stable min heights.
  Use `aria-live="polite"` for operation changes and `aria-live="assertive"`
  only for newly surfaced blocking errors.

- [ ] **Step 4: Run recovery, accessibility, and viewport tests to verify they pass**

  Run:

  ```powershell
  npx playwright test e2e/modules_manager.spec.mjs --project=chromium
  python -m pytest tests/test_module_manager_ui.py -q
  ```

  Expected: PASS. The UI does not offer unsafe retries, recovery never
  restarts implicitly, and the desktop/mobile screenshots show a readable
  single-column fallback with no overlapping controls.

- [ ] **Step 5: Commit recovery and responsive behavior**

  ```powershell
  git add xkeen-ui/static/js/features/module_manager xkeen-ui/templates/modules.html xkeen-ui/static/modules-manager.css tests/test_module_manager_ui.py e2e/modules_manager.spec.mjs
  git commit -m "feat: handle module lifecycle recovery states"
  ```

### Task 5: Make Stable DevTools A Manager Pointer And Preserve Main

**Files:**
- Modify: `xkeen-ui/templates/devtools.html`
- Modify: `xkeen-ui/static/js/features/devtools/update.js`
- Modify: `xkeen-ui/static/js/features/update_notifier.js`
- Modify: `xkeen-ui/static/devtools.css`
- Modify: `tests/test_module_manager_ui.py`
- Modify: `tests/test_devtools_update_smoke.py`
- Modify: `e2e/modules_manager.spec.mjs`

**Interfaces:**
- `update.js` must choose `stable` versus `main` only after its local
  `GET /api/devtools/update/info` response.
- Stable mode exposes an ordinary top-level navigation link to `/modules` and
  performs no `POST /api/devtools/update/check`, `GET .../status`, or mutation
  request.
- Main mode continues to initialize the pre-existing updater unchanged after
  channel selection.

- [ ] **Step 1: Write failing channel-boundary tests**

  Add a browser test that intercepts `update/info` as stable, opens DevTools,
  then asserts the manager notice link works in-place and that no legacy
  stable check/status/run endpoints were requested. Add the reciprocal `main`
  fixture asserting that the existing Check button is visible and initiates
  the legacy check endpoint.

  Add a Python source-level contract:

  ```python
  def test_stable_devtools_update_is_a_modules_link_not_a_second_runner():
      source = (ROOT / "xkeen-ui/static/js/features/devtools/update.js").read_text(encoding="utf-8")
      notifier = (ROOT / "xkeen-ui/static/js/features/update_notifier.js").read_text(encoding="utf-8")

      assert "openModulesManager" in source
      assert "startLegacyMainUpdater" in source
      assert "stable" in notifier and "_stopSchedule" in notifier
  ```

- [ ] **Step 2: Run channel-boundary tests to verify they fail**

  Run:

  ```powershell
  npx playwright test e2e/modules_manager.spec.mjs --project=chromium
  python -m pytest tests/test_module_manager_ui.py tests/test_devtools_update_smoke.py -q
  ```

  Expected: FAIL because DevTools immediately initializes stable check/status
  work and renders the legacy update controls for all channels.

- [ ] **Step 3: Gate updater startup by channel without changing compatibility APIs**

  Keep the existing legacy markup in a `data-dt-main-update-controls` region
  that is hidden until `info.settings.channel` resolves to `main`. Add a
  visible, compact stable `data-dt-modules-manager-notice` with a
  `data-xk-top-nav="1"` `/modules` link. Refactor `update.js` so `init()`
  calls `loadInfo()` first; stable renders the notice and returns before
  `loadStatus`, `checkLatest`, auto-check controls, polling, or action wiring.
  Extract the old initialization into `startLegacyMainUpdater()` and call it
  only for `main`.

  Update `update_notifier.js` to call the local info endpoint before any
  GitHub/catalog check. On stable it hides any legacy `#xk-update-link`, clears
  its timer, and returns; on `main` it keeps the current cached-badge and
  schedule behavior. Do not change the backend DevTools routes or their
  compatibility tests.

- [ ] **Step 4: Run stable/main behavior tests to verify they pass**

  Run:

  ```powershell
  npx playwright test e2e/modules_manager.spec.mjs --project=chromium
  python -m pytest tests/test_module_manager_ui.py tests/test_devtools_update_smoke.py -q
  ```

  Expected: PASS. Stable has exactly one management destination, while main
  retains the existing development-only updater.

- [ ] **Step 5: Commit DevTools migration**

  ```powershell
  git add xkeen-ui/templates/devtools.html xkeen-ui/static/devtools.css xkeen-ui/static/js/features/devtools/update.js xkeen-ui/static/js/features/update_notifier.js tests/test_module_manager_ui.py tests/test_devtools_update_smoke.py e2e/modules_manager.spec.mjs
  git commit -m "feat: route stable updates through modules manager"
  ```

### Task 6: Synchronize Build, Inventory, Ownership, And Operator Docs

**Files:**
- Modify: `vite.config.mjs`
- Modify: `xkeen-ui/routes/ui_assets.py`
- Modify: `scripts/verify_frontend_build.mjs`
- Modify: `scripts/generate_frontend_inventory.py`
- Modify: `scripts/generate_modular_panel_inventory.py`
- Modify: `tests/test_frontend_page_inventory.py`
- Modify: `tests/test_frontend_migration_guardrails.py`
- Modify: `tests/test_frontend_build_fallback.py`
- Modify: `tests/test_frontend_build_toolchain.py`
- Modify: `tests/test_modular_panel_ownership_map.py`
- Modify: `docs/frontend-page-inventory.json`
- Modify: `docs/frontend-page-inventory.md`
- Modify: `docs/frontend-target-architecture.md`
- Modify: `docs/README_frontend_migration_plan.md`
- Modify: `docs/top-level-navigation-plan.md`
- Create: `docs/modular-panel-stage8-manager-ui.md`
- Modify: `docs/modular-panel-stage8-official-module-manager.md`
- Modify: `docs/README.md`
- Modify: `README-modular-panel-plan.md`

**Interfaces:**
- Every registry has the same sixth canonical entry: `modules` ->
  `js/pages/modules.entry.js`.
- The profile/release ownership map classifies modules template, stylesheet,
  page modules, and manager feature directory as `core`.

- [ ] **Step 1: Write failing build/inventory/ownership assertions**

  Extend fixed sets so they explicitly contain:

  ```python
  EXPECTED_PAGES["modules"] = "static/js/pages/modules.entry.js"
  assert "static/js/pages/modules.entry.js" in ownership["core"]
  assert "static/js/features/module_manager/controller.js" in ownership["core"]
  assert "templates/modules.html" in ownership["core"]
  ```

  Extend the Node verifier's `EXPECTED_PAGE_ENTRIES` with `modules`, and make
  frontend inventory tests expect six canonical routes and the modules
  bootstrap/screen/controller files. Add rendered modules-page assertions to
  source-fallback tests so production build bridge and development source
  fallback both resolve the same entry.

- [ ] **Step 2: Run generator/build/ownership tests to verify they fail**

  Run:

  ```powershell
  python -m pytest tests/test_frontend_page_inventory.py tests/test_frontend_build_fallback.py tests/test_frontend_build_toolchain.py tests/test_modular_panel_ownership_map.py -q
  npm run frontend:verify:static
  ```

  Expected: FAIL because all canonical-page registries and generated snapshots
  still encode five entries.

- [ ] **Step 3: Synchronize the sixth entry and generated artifacts**

  Add `modules` to Vite canonical inputs, `_SOURCE_ENTRIES`, frontend inventory
  page specs, module inventory core-page mapping/list, and frontend verifier
  expectations. Confirm the Stage 7 `owner()` logic resolves the new
  `static/js/features/module_manager/*`, `static/js/pages/modules*`,
  `templates/modules.html`, and `modules-manager.css` to `core`; add a narrow
  owner override only if the existing conservative rules do not do so.

  Regenerate committed snapshots rather than hand-editing them:

  ```powershell
  node scripts/run_python.mjs scripts/generate_frontend_inventory.py --root . --json-out docs/frontend-page-inventory.json
  npm run inventory:modular-panel
  npm run frontend:build
  ```

  Update the human frontend docs from "five canonical" to "six canonical"
  routes and list `/modules` as a core screen. Write
  `docs/modular-panel-stage8-manager-ui.md` with initial-load behavior, plan
  review, cancel/recovery/restart, offline/trust/rollback boundaries, and the
  stable DevTools pointer. Keep Stage 8.6 in an awaiting-final-verification
  state in this task; the final task alone closes the roadmap and advances the
  next stage to 8.7.

- [ ] **Step 4: Run build, inventory, and ownership tests to verify they pass**

  Run:

  ```powershell
  python -m pytest tests/test_frontend_page_inventory.py tests/test_frontend_build_fallback.py tests/test_frontend_build_toolchain.py tests/test_frontend_migration_guardrails.py tests/test_modular_panel_ownership_map.py -q
  npm run frontend:verify
  ```

  Expected: PASS. The source, build bridge, manifests, inventories, profile
  ownership map, and documentation all agree on the six core screen entries.

- [ ] **Step 5: Commit generated/build/documentation synchronization**

  ```powershell
  git add vite.config.mjs xkeen-ui/routes/ui_assets.py scripts/generate_frontend_inventory.py scripts/generate_modular_panel_inventory.py scripts/verify_frontend_build.mjs tests/test_frontend_page_inventory.py tests/test_frontend_build_fallback.py tests/test_frontend_build_toolchain.py tests/test_frontend_migration_guardrails.py tests/test_modular_panel_ownership_map.py docs/frontend-page-inventory.json docs/frontend-page-inventory.md docs/frontend-target-architecture.md docs/README_frontend_migration_plan.md docs/top-level-navigation-plan.md docs/modular-panel-stage8-manager-ui.md docs/modular-panel-stage8-official-module-manager.md docs/README.md README-modular-panel-plan.md xkeen-ui/static/frontend-build
  git commit -m "docs: record module manager UI contract"
  ```

### Task 7: Verify The Integrated Feature And Review The Diff

**Files:**
- Verify: all Task 1-6 files
- Modify after successful verification: `README-modular-panel-plan.md`,
  `docs/modular-panel-stage8-official-module-manager.md`,
  `docs/modular-panel-stage8-manager-ui.md`, `docs/README.md`, and
  `tests/test_modular_panel_stage8_contract.py`.

**Interfaces:**
- Verifies the public UI against unchanged Lifecycle API routes and every
  supported top-level runtime path.

- [ ] **Step 1: Run the targeted lifecycle and page suites**

  ```powershell
  python -m pytest tests/test_module_lifecycle_routes.py tests/test_module_lifecycle.py tests/test_panel_profile_transactions.py tests/test_panel_rollback_to_previous_version.py tests/test_module_manager_ui.py tests/test_module_backend_gates.py -q
  ```

  Expected: PASS. No lifecycle route contract, profile guard, rollback model,
  or core ownership guarantee regresses.

- [ ] **Step 2: Run browser and viewport verification**

  ```powershell
  npx playwright test e2e/modules_manager.spec.mjs e2e/top_level_back_before_bundle_screens.spec.mjs --project=chromium
  ```

  Inspect the saved desktop and `390x844` manager screenshots from the manager
  spec. Verify the plan dialog is centered, the operation area remains usable,
  text wraps, and no visual overlay obscures actions.

- [ ] **Step 3: Run complete repository verification**

  ```powershell
  npm run frontend:verify
  python -m pytest -q
  npm run e2e
  ```

  Expected: PASS. If a command fails, use `superpowers:systematic-debugging`
  before changing code; rerun the exact failing command and then the complete
  suite.

- [ ] **Step 4: Close Stage 8.6 only after verification evidence exists**

  After Steps 1-3 pass, update the roadmap and Stage 8 documentation to state
  that 8.6 is closed, identify 8.7 as next, and link the manager operator
  guide from the documentation index. Add an assertion to
  `tests/test_modular_panel_stage8_contract.py` that requires the closed date,
  `/modules`, `GET /api/modules/installed`, plan/apply, recovery, the stable
  DevTools pointer, and the absence of a dependency on advanced diagnostics.

  Run:

  ```powershell
  python -m pytest tests/test_modular_panel_stage8_contract.py -q
  ```

  Expected: PASS. The documented closure is now backed by the already-passing
  implementation and verification commands.

- [ ] **Step 5: Review final diff and generated state**

  ```powershell
  git diff --check
  git status --short
  git log --oneline --decorate -6
  ```

  Expected: no whitespace errors, no untracked generated output, and only the
  planned commits/files. Verify the manager entry graph does not contain a
  DevTools import with:

  ```powershell
  rg -n "features/devtools|compat/devtools" xkeen-ui/static/js/pages/modules* xkeen-ui/static/js/features/module_manager
  ```

  Expected: no matches.

- [ ] **Step 6: Commit the evidence-backed closure and preserve a clean worktree**

  Commit only the Stage 8.6 closure documentation/test after the preceding
  checks pass:

  ```powershell
  git add README-modular-panel-plan.md docs/modular-panel-stage8-official-module-manager.md docs/modular-panel-stage8-manager-ui.md docs/README.md tests/test_modular_panel_stage8_contract.py
  git commit -m "docs: close stage 8.6 module manager UI"
  ```

  Then run:

  ```powershell
  git status --short
  ```

  Expected: no unexpected modified or untracked files.
