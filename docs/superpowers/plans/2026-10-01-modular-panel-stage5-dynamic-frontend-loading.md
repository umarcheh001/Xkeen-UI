# Modular Panel Stage 5 Dynamic Frontend Loading Implementation Plan

> **Status:** closed on 1 October 2026. Stage 6 is next.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Load only frontend assets and runtime behaviour owned by the active Module Registry set, with browser-enforced profile guardrails.

**Architecture:** Flask derives a stable `frontendModules` descriptor from module activation and panel composition. A panel-local loader maps its fixed bundle keys to local `import()` factories and is the only optional asset entrypoint. Isolated Playwright servers seed one profile before Flask starts and record browser network, WebSocket and console evidence.

**Tech Stack:** Flask/Jinja, Python 3.11/pytest, browser ESM, Vite 8, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-10-01-modular-panel-stage5-dynamic-frontend-loading-design.md`

## Global Constraints

- The server descriptor contains only static module IDs, bundle keys, roots, endpoint prefixes and CSS keys, never executable import paths or persisted free-form data.
- Full and legacy-full retain compatible public behaviour.
- Inactive, missing-root and unavailable-route requests are no-ops: no API/WS call, toast or repeated action replay.
- Active bundle import errors remain visible once in the console.
- `styles.css` and `panel-operator.css` remain shared compatibility CSS. `xterm.css` is the first lazy module stylesheet.
- E2E profile fixtures use their own state and ports, never the developer's running panel.

## Closure Evidence

- `python -m pytest -q` — 2733 passed.
- `npm run frontend:verify` — production build and static bridge checks passed.
- Profile browser checks — Full, Xray-minimal, Mihomo-minimal and core-only each passed their Network, WebSocket, console and lazy-CSS scenarios.
- The E2E fixture namespaces temporary state by profile and port; concurrent local profile servers cannot clear one another's state.
- `pageConfig.runtime.websocket` prevents the restart log from opening `/ws/events` when the serving runtime cannot handle WebSocket upgrades.

---

### Task 1: Publish the server frontend descriptor

**Files:**

- Modify: `xkeen-ui/routes/pages.py`
- Modify: `xkeen-ui/routes/ui_assets.py`
- Modify: `xkeen-ui/templates/panel/page_config.html`
- Create: `tests/test_modular_panel_stage5_frontend_contract.py`

**Interfaces:**

- Produces `build_panel_frontend_modules(active_module_ids: set[str] | None) -> dict[str, object]`.
- Publishes `pageConfig.frontendModules = {version, activeModuleIds, bundles}`.
- Every bundle payload has `key`, `moduleId`, `loadMode`, `views`, `domRoots`, `apiPrefixes`, `wsPrefixes`, `cssKeys`.

- [x] **Step 1: Write the failing descriptor test**

```python
def test_xray_minimal_page_config_excludes_mihomo_bundle(tmp_path):
    config = _panel_config(render_panel(XRAY_MINIMAL_MODULE_IDS, tmp_path))
    bundles = {bundle["key"] for bundle in config["frontendModules"]["bundles"]}
    assert {"panel-core", "panel-routing", "editor-runtime"} <= bundles
    assert "panel-mihomo" not in bundles
    assert all("path" not in item and "import" not in item for item in config["frontendModules"]["bundles"])
```

- [x] **Step 2: Confirm the test is red**

Run: `python -m pytest -q tests/test_modular_panel_stage5_frontend_contract.py -k descriptor`

Expected: FAIL because `frontendModules` is not published.

- [x] **Step 3: Add immutable descriptor definitions**

```python
PANEL_FRONTEND_MODULES = (
    PanelFrontendModule("panel-core", ("core",), "startup", (), ("view-xkeen",), ("/api/",), (), ()),
    PanelFrontendModule("panel-routing", ("engine.xray",), "startup", ("routing", "xray-logs"), ("view-routing", "view-xray-logs"), ("/api/routing", "/api/xray"), ("/ws/xray-logs",), ()),
    PanelFrontendModule("panel-mihomo", ("engine.mihomo",), "startup", ("mihomo",), ("view-mihomo",), ("/api/mihomo",), ("/ws/mihomo-clash",), ()),
    PanelFrontendModule("terminal-lazy", ("tool.terminal",), "view", ("commands",), ("view-commands",), ("/api/terminal",), ("/ws/pty",), ("xterm",)),
)
```

Pass the generated mapping through the existing `frontend_page_config` script and structurally normalise it in `ui_assets.py`; do not create another global script.

- [x] **Step 4: Verify the descriptor boundary**

Run: `python -m pytest -q tests/test_modular_panel_stage5_frontend_contract.py tests/test_modular_panel_stage4_5_composition.py tests/test_modular_panel_stage4_6_compatibility.py`

Expected: PASS.

- [x] **Step 5: Commit the descriptor**

```bash
git add xkeen-ui/routes/pages.py xkeen-ui/routes/ui_assets.py xkeen-ui/templates/panel/page_config.html tests/test_modular_panel_stage5_frontend_contract.py
git commit -m "feat(panel): publish frontend module descriptor"
```

### Task 2: Introduce the panel module loader and remove startup imports

**Files:**

- Create: `xkeen-ui/static/js/pages/panel.module_loader.js`
- Modify: `xkeen-ui/static/js/pages/panel.screen.bootstrap.js`
- Modify: `xkeen-ui/static/js/pages/panel.init.js`
- Modify: `tests/test_modular_panel_stage5_frontend_contract.py`
- Modify: `tests/test_frontend_migration_guardrails.py`

**Interfaces:**

- Consumes `window.XKeen.pageConfig.frontendModules` and a fixed local loader map.
- Produces `ensurePanelModule(key, reason)`, `ensurePanelModuleForView(view)`, `getPanelModuleApi(key)` and `isPanelModuleActive(key)`.
- Returns `{status: "ready" | "inactive" | "missing-root" | "failed", key, api}`.

- [x] **Step 1: Write loader and bootstrap red tests**

```python
def test_loader_uses_local_allowlist_not_server_import_specifiers():
    source = _read("xkeen-ui/static/js/pages/panel.module_loader.js")
    assert "const BUNDLE_LOADERS = Object.freeze" in source
    assert "await import(" in source
    assert "import(descriptor" not in source

def test_bootstrap_delegates_engine_bundles_to_loader():
    source = _read("xkeen-ui/static/js/pages/panel.screen.bootstrap.js")
    assert "ensurePanelModule('panel-routing', 'startup')" in source
    assert "ensurePanelModule('panel-mihomo', 'startup')" in source
    assert "await import('./panel.routing.bundle.js')" not in source
```

- [x] **Step 2: Confirm the tests are red**

Run: `python -m pytest -q tests/test_modular_panel_stage5_frontend_contract.py -k 'loader or bootstrap'`

Expected: FAIL because loader source is absent and bootstrap owns the imports.

- [x] **Step 3: Implement promise-deduplicated loading**

```javascript
const BUNDLE_LOADERS = Object.freeze({
  'panel-routing': () => import('./panel.routing.bundle.js'),
  'panel-mihomo': () => import('./panel.mihomo.bundle.js'),
  'terminal-lazy': () => import('./terminal.lazy.entry.js'),
  'file-manager-lazy': () => import('./file_manager.lazy.entry.js'),
  'diagnostics-panel': () => import('./panel.diagnostics.bundle.js'),
  'editor-runtime': () => import('./panel.editor.bundle.js'),
});

export async function ensurePanelModule(key, reason) {
  const descriptor = descriptorFor(key);
  if (!descriptor) return { status: 'inactive', key, api: null };
  if (!hasOwnedRoot(descriptor.domRoots)) return { status: 'missing-root', key, api: null };
  return loadOnce(key, descriptor, reason);
}
```

Replace engine imports in `loadPanelFeatureBundles()` with loader calls. The loader logs a failing active key once; it must not invoke `fetch`, WebSocket or toast in inactive branches.

- [x] **Step 4: Verify loader and source graph**

Run: `python -m pytest -q tests/test_modular_panel_stage5_frontend_contract.py tests/test_frontend_migration_guardrails.py`

Expected: PASS.

- [x] **Step 5: Commit loader migration**

```bash
git add xkeen-ui/static/js/pages/panel.module_loader.js xkeen-ui/static/js/pages/panel.screen.bootstrap.js xkeen-ui/static/js/pages/panel.init.js tests/test_modular_panel_stage5_frontend_contract.py tests/test_frontend_migration_guardrails.py
git commit -m "feat(panel): load feature bundles through module loader"
```

### Task 3: Gate optional views, facades and terminal CSS

**Files:**

- Create: `xkeen-ui/static/js/pages/panel.editor.bundle.js`
- Create: `xkeen-ui/static/js/pages/panel.diagnostics.bundle.js`
- Modify: `xkeen-ui/static/js/pages/panel.view_runtime.js`
- Modify: `xkeen-ui/static/js/pages/panel.core_ui_watch.runtime.js`
- Modify: `xkeen-ui/static/js/pages/panel_shell.shared.js`
- Modify: `xkeen-ui/static/js/pages/config_shell.shared.js`
- Modify: `xkeen-ui/static/js/pages/logs_shell.shared.js`
- Modify: `xkeen-ui/static/js/pages/panel.lazy_bindings.runtime.js`
- Modify: `xkeen-ui/templates/panel/head.html`
- Modify: `tests/test_modular_panel_stage5_frontend_contract.py`

**Interfaces:**

- Views call `ensurePanelModuleForView(viewName)` before optional API work.
- Xray/Mihomo/files/diagnostics/editor facades use loader APIs instead of static implementation imports.
- `ensurePanelModuleStyles("terminal-lazy")` adds one `data-xk-module-css="xterm"` link only on terminal load.

- [x] **Step 1: Write failing graph and CSS tests**

```python
def test_view_runtime_gates_feature_loading_through_loader():
    source = _read("xkeen-ui/static/js/pages/panel.view_runtime.js")
    assert "ensurePanelModuleForView(viewName)" in source
    assert "../features/mihomo_panel.js" not in source
    assert "../features/file_manager.js" not in source

def test_terminal_css_is_not_initial_html_and_is_loader_owned(tmp_path):
    assert "xterm/xterm.css" not in render_panel(FULL_MODULE_IDS, tmp_path)
    loader = _read("xkeen-ui/static/js/pages/panel.module_loader.js")
    assert "xterm/xterm.css" in loader
    assert "data-xk-module-css" in loader
```

- [x] **Step 2: Confirm the tests are red**

Run: `python -m pytest -q tests/test_modular_panel_stage5_frontend_contract.py -k 'view_runtime or terminal_css'`

Expected: FAIL because views retain direct optional imports and xterm CSS is eager.

- [x] **Step 3: Replace direct feature imports with lazy facades**

```javascript
export async function applyPanelViewRuntime(viewName) {
  const result = await ensurePanelModuleForView(viewName);
  if (result.status !== 'ready') return result;
  return activateLoadedView(viewName, result.api);
}

const STYLE_URLS = Object.freeze({
  xterm: new URL('../../xterm/xterm.css', import.meta.url).href,
});
```

Create narrow editor/diagnostics activation files. Keep current exported feature APIs, IDs, events and endpoint URLs. Core watcher may query optional dirty state only after that module is loaded. Keep `styles.css` and `panel-operator.css` in `<head>` with a comment naming them shared compatibility CSS.

- [x] **Step 4: Verify runtime and terminal regressions**

Run: `python -m pytest -q tests/test_modular_panel_stage5_frontend_contract.py tests/test_frontend_runtime_hotfixes.py tests/test_terminal_lite_mode_regressions.py tests/test_modular_panel_stage4_3_routing_screen.py tests/test_modular_panel_stage4_3_mihomo_screen.py`

Expected: PASS.

- [x] **Step 5: Commit optional-boundary migration**

```bash
git add xkeen-ui/static/js/pages xkeen-ui/templates/panel/head.html tests/test_modular_panel_stage5_frontend_contract.py tests/test_frontend_runtime_hotfixes.py
git commit -m "refactor(panel): gate optional runtime imports"
```

### Task 4: Profile E2E, generated contract and Stage 5 closure

**Files:**

- Modify: `scripts/run_e2e_server.py`
- Create: `e2e/modular_panel_dynamic_loading.spec.mjs`
- Create: `scripts/generate_modular_panel_stage5_frontend_loading.py`
- Create: `docs/modular-panel-stage5-frontend-loading.json`
- Create: `docs/modular-panel-stage5-frontend-loading.md`
- Modify: `README-modular-panel-plan.md`
- Modify: `docs/README.md`
- Modify: `tests/test_modular_panel_stage5_frontend_contract.py`
- Modify: `docs/modular-panel-stage0-inventory.json`
- Modify: `docs/modular-panel-stage0-inventory.md`
- Modify: `xkeen-ui/module-sizes.json`

**Interfaces:**

- `XKEEN_E2E_MODULE_PROFILE` accepts `full`, `xray-minimal`, `mihomo-minimal`, `core-only`.
- Fixture writes exact `modules.json` before Flask starts.
- The generator emits a deterministic profile matrix with bundle, roots, API/WS and lazy-CSS contracts.

- [x] **Step 1: Write failing E2E shape and snapshot tests**

```python
def test_e2e_fixture_seeds_profile_before_flask_starts():
    source = _read("scripts/run_e2e_server.py")
    assert "XKEEN_E2E_MODULE_PROFILE" in source
    assert 'STATE_DIR / "modules.json"' in source

def test_stage5_snapshot_is_current(tmp_path):
    assert json.loads(SNAPSHOT.read_text(encoding="utf-8")) == _generate(tmp_path)
```

- [x] **Step 2: Confirm the tests are red**

Run: `python -m pytest -q tests/test_modular_panel_stage5_frontend_contract.py -k 'e2e or snapshot'`

Expected: FAIL because neither profile fixture nor Stage 5 snapshot exists.

- [x] **Step 3: Seed profiles, assert browser Network/Console and generate the contract**

```python
E2E_MODULE_PROFILES = {
    "full": set(MODULE_IDS),
    "xray-minimal": {"core", "tool.editor", "engine.xray"},
    "mihomo-minimal": {"core", "tool.editor", "engine.mihomo"},
    "core-only": {"core"},
}
```

```javascript
const requests = [];
const consoleErrors = [];
page.on('request', (request) => requests.push(new URL(request.url()).pathname));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('websocket', (socket) => websockets.push(new URL(socket.url()).pathname));
```

Run each profile as a fresh process/port. Assert inactive bundles, roots, CSS and API/WS paths are absent; assert terminal CSS appears only after terminal activation; assert Full and legacy descriptors match. Document that shared CSS remains intentionally unsplit, regenerate inventories sequentially, then mark Stage 5 closed and Stage 6 next.

- [x] **Step 4: Run browser and generated-artifact verification**

Run:

```bash
python scripts/generate_modular_panel_stage5_frontend_loading.py --root .
python scripts/generate_modular_panel_inventory.py --root .
python scripts/generate_panel_operator_inventory.py --root .
python scripts/sync_module_sizes.py --root .
npm run frontend:verify
XKEEN_E2E_MODULE_PROFILE=full XKEEN_E2E_PORT=18189 npm exec playwright test e2e/modular_panel_dynamic_loading.spec.mjs --project=chromium
```

Repeat the Playwright command with `xray-minimal`/`18190`, `mihomo-minimal`/`18191`, and `core-only`/`18192`.

Expected: all commands exit 0, no profile reports unexpected console errors, and a second generation pass leaves no diff.

- [x] **Step 5: Run full verification and commit closure**

Run:

```bash
python -m pytest -q
git diff --check
```

Expected: PASS and clean diff check.

```bash
git add README-modular-panel-plan.md docs scripts e2e tests xkeen-ui/module-sizes.json
git commit -m "docs(panel): close stage 5 dynamic loading"
```
