# Core Management Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop core-topology reload loops and consolidate engine source management into the shared core dialog.

**Architecture:** The browser watcher treats the first successful physical-core response as its runtime baseline, so a static module registry cannot trigger a self-reloading page. The existing `core-modal` becomes the shared owner of engine-scoped source controllers; their source/install dialogs remain top-level overlays, while routing and Mihomo keep their editor-only screen markup.

**Tech Stack:** Python pytest source-contract tests, Jinja, native ESM, CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-10-01-core-management-dialog-design.md`

## Global Constraints

- Preserve all existing verified source-selection, prepare and install API calls.
- The no-installed-core state is supported and does not hide source management.
- Use one `data-core-source` root for each enabled engine; render its unique source/install dialogs as top-level overlays and never duplicate modal IDs or event listeners.
- Use operator theme variables for surfaces and preserve icon-plus-label horizontal controls.

---

### Task 1: Stabilize Runtime Core Watching

**Files:**
- Modify: `xkeen-ui/static/js/pages/panel.core_ui_watch.runtime.js`
- Create: `tests/test_panel_core_ui_watch_contract.py`

**Interfaces:**
- Consumes: `GET /api/xkeen/core` and page-config module topology.
- Produces: one baseline probe before topology changes can prompt a panel refresh.

- [x] **Step 1: Write a failing regression test**

```python
def test_first_successful_runtime_probe_primes_the_baseline_without_reload():
    assert "let coreUiLiveTopologyInitialized = false;" in RUNTIME
    assert "primeCoreUiTopologyFromLiveStatus(nextCores)" in RUNTIME
    assert "if (!coreUiLiveTopologyInitialized)" in RUNTIME
```

- [x] **Step 2: Run it and confirm RED**

Run: `python -m pytest -q tests/test_panel_core_ui_watch_contract.py`

Expected: FAIL because the live-baseline guard does not exist.

- [x] **Step 3: Implement the minimal live-baseline guard**

Add a boolean and a small helper that copies the first successful probe into
`coreUiKnownDetectedCores` and `coreUiKnownSignature`, then returns true. Call
it after `fetchDetectedCores()` succeeds and before comparison. Later probes
keep the existing change notification semantics.

- [x] **Step 4: Run the focused test and confirm GREEN**

Run: `python -m pytest -q tests/test_panel_core_ui_watch_contract.py`

Expected: PASS.

### Task 2: Move Source Management Into the Shared Core Dialog

**Files:**
- Modify: `xkeen-ui/templates/panel/core_source.html`
- Modify: `xkeen-ui/templates/panel.html`
- Modify: `xkeen-ui/templates/panel/screens/routing.html`
- Modify: `xkeen-ui/templates/panel/screens/mihomo.html`
- Modify: `xkeen-ui/static/panel-operator.css`
- Create: `tests/test_core_management_dialog_contract.py`

**Interfaces:**
- Consumes: `initCoreSources(document, engineId)` from active engine bundles.
- Produces: source roots inside the shared `core-modal` and one source/install
  overlay pair per enabled Xray/Mihomo module.

- [x] **Step 1: Write failing ownership and layout tests**

```python
def test_source_controls_are_owned_by_the_shared_core_modal():
    modal = TEMPLATE[TEMPLATE.index('id="core-modal"'):TEMPLATE.index('id="confirm-modal"')]
    assert 'data-core-source data-core-engine="xray"' in modal
    assert 'data-core-source data-core-engine="mihomo"' in modal
    assert 'xk-core-source-actions' in modal

def test_editor_screens_no_longer_render_source_cards():
    assert 'render_core_source' not in ROUTING
    assert 'render_core_source' not in MIHOMO
```

Add CSS assertions for `inline-flex`, `align-items: center`, operator surface
variables and modal padding of at least 16px.

- [x] **Step 2: Run the contract test and confirm RED**

Run: `python -m pytest -q tests/test_core_management_dialog_contract.py`

Expected: FAIL because source roots live in engine screens.

- [x] **Step 3: Implement shared source controls**

Split the macro into a compact control/root for `core-modal` and its existing
source/install dialogs. Render controls conditionally for `has_xray` and
`has_mihomo` inside the modal, remove their screen-level calls, and retain
their engine IDs so existing feature bundles initialize them unchanged. Keep
the source controls independently available when switching options report zero
physical cores.

- [x] **Step 4: Apply theme and spacing changes**

Style source controls as compact operator-surface rows with a status summary
and inline icon-plus-label actions. Increase `core-modal` body and footer
padding to a visible 16px or more, using existing radius and surface tokens.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run: `python -m pytest -q tests/test_core_management_dialog_contract.py tests/test_panel_core_ui_watch_contract.py`

Expected: PASS.

### Task 3: Integrate and Review the Local Stand

**Files:**
- Regenerate only source inventories/contracts changed by the shared-template move.

- [x] **Step 1: Run affected existing tests**

Run: `python -m pytest -q tests/test_core_management_dialog_contract.py tests/test_panel_core_ui_watch_contract.py tests/test_cores_status_prereleases.py tests/test_header_core_button_state.py tests/test_modular_panel_stage4_1_contract.py tests/test_panel_operator_stage0_contract.py tests/test_mihomo_clash_frontend_contract.py`

Expected: PASS after updating only legitimate inventory expectations.

- [x] **Step 2: Inspect the local panel**

Open the shared `Ядро` dialog with no physical cores present. Verify there is
no reload, source rows remain actionable, and the profile modal has clear
edge spacing in light theme.

- [x] **Step 3: Run the complete suite**

Run: `python -m pytest -q`

Expected: PASS with zero failures.
