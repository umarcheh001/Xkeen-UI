# Modular Panel Stage 6 Editor Separation Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current checkout. Each task has a test-first checkpoint.

**Goal:** Split editor capabilities into persisted light/full/advanced variants while preserving `tool.editor` and existing screen APIs. **Status: completed 2 October 2026.**

**Architecture:** Keep one `tool.editor` registry module. Persist an optional `editor.variant`, expose a core-owned descriptor through modules/capabilities APIs, and let the existing allow-listed frontend loader activate only the editor layers required by the selected variant and interaction.

**Tech Stack:** Python, Flask, pytest, browser ESM modules, existing Stage 5 module loader and runtime.

**Spec:** `docs/superpowers/specs/2026-10-02-modular-panel-stage6-editor-separation-design.md`

## Global Constraints

- Allowed variants are exactly `light`, `full`, and `advanced`.
- `schema_version` remains unchanged at `1`.
- `tool.editor` remains a dependency of active Xray and Mihomo engines.
- Light mode must not load Monaco, diff, Prettier, or quick-fix assets.
- Existing Stage 5 frontend descriptor keys remain backward compatible.

---

### Task 1: Persist and expose editor variant

**Files:**
- Modify: `xkeen-ui/services/module_registry.py`
- Modify: `tests/test_module_registry.py`
- Modify: `tests/test_module_capabilities.py`

**Interfaces:**
- Produce `ModuleRegistry.set_editor_variant(variant: str) -> tuple[dict[str, object], bool]`.
- Snapshot top-level `editor` contains `variant`, `available_variants`, `capabilities`, `requires_restart`.

- [x] Write failing tests for legacy default, explicit variant migration, invalid variant, persistence, and restart flag.
- [x] Run `python -m pytest tests/test_module_registry.py tests/test_module_capabilities.py -q` and confirm the new assertions fail because no editor contract exists.
- [x] Add variant constants, profile default resolution, state normalization, descriptor serialization, and atomic setter.
- [x] Run the focused tests and then the complete registry/capabilities files.

### Task 2: Add core-owned editor API

**Files:**
- Modify: `xkeen-ui/routes/modules.py`
- Modify: `xkeen-ui/services/capabilities.py`
- Modify: `tests/test_module_registry.py`
- Modify: `tests/test_module_capabilities.py`

**Interfaces:**
- `PATCH /api/modules/editor` accepts only a JSON object with `variant`.
- `GET /api/modules` and `GET /api/capabilities` expose the same editor descriptor.

- [x] Write failing Flask route tests for valid patch, invalid variant, missing variant, and unsupported fields.
- [x] Run the focused route tests and verify expected failures.
- [x] Implement the endpoint using the registry setter and preserve existing module patch behavior.
- [x] Project the descriptor into capabilities without changing legacy keys.
- [x] Run focused route/capabilities tests.

### Task 3: Split editor frontend loading

**Files:**
- Modify: `xkeen-ui/static/js/pages/panel.module_loader.js`
- Modify: `xkeen-ui/static/js/pages/panel.editor.bundle.js`
- Modify: `xkeen-ui/static/js/runtime/lazy_runtime.js`
- Modify: `xkeen-ui/static/js/pages/panel.lazy_bindings.runtime.js`
- Modify: `xkeen-ui/routes/pages.py`
- Modify: `tests/test_modular_panel_stage5_frontend_contract.py`
- Create: `tests/test_modular_panel_stage6_editor_contract.py`

**Interfaces:**
- The loader keeps a local allow-list and returns inactive/failed states safely.
- Editor support requests use the descriptor capabilities before loading heavy layers.

- [x] Write failing static contract tests for light capability gating, separate Monaco/enhancement loaders, and unchanged Stage 5 engine bundles.
- [x] Run the new/static tests and confirm they fail before implementation.
- [x] Add declarative capability metadata to the page descriptor and local loader entries.
- [x] Keep CodeMirror as the light base; gate Monaco, diff, and enhancement imports behind explicit support calls.
- [x] Run Stage 5 and Stage 6 frontend contract tests.

### Task 4: Profile-aware UI state and graceful fallback

**Files:**
- Modify: `xkeen-ui/static/js/runtime/lazy_runtime.js`
- Modify: `xkeen-ui/static/js/pages/panel.lazy_bindings.runtime.js`
- Modify: relevant editor capability facade/tests identified by Task 3

- [x] Add failing tests for unavailable optional support preserving CodeMirror and for no light-mode Monaco request.
- [x] Implement capability-aware fallback and diagnostic event without changing modal consumers.
- [x] Run editor runtime and browser-profile checks.

### Task 5: Close documentation and verify

**Files:**
- Modify: `README-modular-panel-plan.md`
- Modify: `docs/README.md`
- Modify: `docs/modular-panel-stage6-editor-separation.md`
- Modify: `docs/superpowers/specs/2026-10-02-modular-panel-stage6-editor-separation-design.md`

- [x] Update Stage 6 status and record the final compatibility matrix.
- [x] Add the implementation plan/spec to the documentation index.
- [x] Run focused tests, Stage 5 regression tests, `git diff --check`, and the applicable full test subset.
- [x] Commit and push only after the working tree and remote branch are verified.
