# Panel Stage 4.5 Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Render the panel from one allow-listed composition manifest derived from the Stage 3 active module set, so inactive modules have no server HTML surface.

**Architecture:** `routes/pages.py` owns an ordered manifest for navigation, shell slots, screens, and modals. The page route turns the active module set into `page_context`, and Jinja consumes only its selected allow-listed entries. The static source resolver gains an audited catalog for dynamic composition includes so existing inventories continue to inspect the complete Full/Legacy source graph without importing the Flask application.

**Tech Stack:** Python 3, Flask/Jinja, pytest, existing module runtime activation, generated repository inventories.

**Spec:** `docs/superpowers/specs/2026-10-01-panel-stage-4-5-composition-design.md`

## Global Constraints

- Preserve DOM ids, `data-view`, `data-xk-section`, modal order, URLs, and page entrypoint order.
- `active_module_ids` is the only server-side input for optional panel HTML; browser state and local storage do not participate.
- A missing activation is the Legacy/Full fallback and includes all allow-listed panel entries.
- `panel.html` must not return to per-module `{% if has_* %}` chains; owner rules live in the Python composition manifest.
- Do not change frontend bundle loading, dynamic imports, CSS loading, or API loading. Those are Stage 5 work.
- Regenerate committed inventories only through supplied scripts.

---

### Task 1: Build the Server Composition Contract

**Files:**
- Modify: `xkeen-ui/routes/pages.py:17-134`
- Modify: `tests/support/panel_render.py:27-55`
- Create: `tests/test_modular_panel_stage4_5_composition.py`
- Modify: `scripts/panel_template_source.py:15-41`
- Test: `tests/test_modular_panel_stage4_5_composition.py`

**Interfaces:**
- Consumes: `module_activation["active_module_ids"]` calculated by Stage 3.
- Produces: `_build_panel_page_context(active_module_ids, core_ui) -> dict[str, object]` with `page_context["active_module_ids"]`, ordered `navigation_items`, `screen_partials`, `modal_partials`, `header_badge_partials`, `header_summary_partials`, `header_action_partials`, and `control_partials`.
- Produces: `PANEL_COMPOSITION` and `PANEL_COMPOSITION_PARTIALS`, which list only repository-owned template paths.
- Produces: `compose_panel_template(root)` expansion of literal local includes and named composition loop variables from an audited catalog.

- [x] **Step 1: Write failing selection tests**

Create `tests/test_modular_panel_stage4_5_composition.py` with literal expected values for a Full set, an Xray-only set, a Mihomo-only set, a core-only set, and the legacy `None` activation. Add an input-order assertion so reversing active ids cannot change composition.

```python
def test_page_context_filters_each_surface_by_declared_owners():
    composition = pages._build_panel_page_context(
        {"core", "tool.editor", "engine.xray"}, _core_ui_for_test()
    )

    assert _template_paths(composition["screen_partials"]) == [
        "panel/screens/routing.html",
        "panel/screens/xkeen.html",
        "panel/screens/xray_logs.html",
    ]
    assert _template_paths(composition["modal_partials"]) == [
        "panel/modals/routing.html",
        "panel/modals/shared.html",
        "panel/modals/editor.html",
    ]
    assert _navigation_views(composition) == ["routing", "xkeen", "xray-logs", "donate"]
```

Name the break: deleting an owner requirement or accidentally allowing a disabled module must add its HTML surface to a minimal profile.

- [x] **Step 2: Run the new tests to verify they fail**

Run: `python -m pytest -q tests/test_modular_panel_stage4_5_composition.py`

Expected: FAIL because `_build_panel_page_context` and the composition manifest do not exist.

- [x] **Step 3: Implement the allow-listed manifest and builder**

In `routes/pages.py`, introduce immutable ordered entries (for example a frozen `PanelCompositionEntry`) with `owners`, `kind`, `template`, and optional navigation metadata. Select an entry only when `set(entry.owners) <= active_module_ids`; when the argument is `None`, select every entry. Derive the first available `data-view` navigation item as active.

Keep existing installed-binary values from `_detect_panel_core_ui` unchanged. Add the new `page_context` object to the render context in `index()`. Keep composite owners explicit:

```python
("integration.happ", "engine.mihomo")  # panel/modals/happ.html
("tool.files", "tool.editor")          # panel/modals/files_editor.html
```

Update `tests/support/panel_render.py` so `render_panel(None, tmp_path)` registers page routes without `module_activation`, exercising Legacy fallback through the real route.

- [x] **Step 4: Extend the static composition resolver**

Add named dynamic-include support in `scripts/panel_template_source.py` for the exact loop variables in `panel.html`, `header.html`, and `shell.html`, such as `screen_partial`, `modal_partial`, and `header_badge_partial`. Its catalog must contain every manifest template path and no arbitrary path. Add a test comparing the static catalog with `PANEL_COMPOSITION_PARTIALS` to prevent drift.

- [x] **Step 5: Run focused tests to verify they pass**

Run: `python -m pytest -q tests/test_modular_panel_stage4_5_composition.py tests/test_modular_panel_stage4_1_contract.py tests/test_modular_panel_stage4_2_shell.py`

Expected: PASS. The static resolver still exposes complete Full template source to Stage 0 and Operator guards.

- [x] **Step 6: Commit the contract foundation**

```bash
git add xkeen-ui/routes/pages.py tests/support/panel_render.py tests/test_modular_panel_stage4_5_composition.py scripts/panel_template_source.py
git commit -m "feat(panel): add active-module composition context"
```

### Task 2: Render Navigation, Shell Slots, Screens, and Modals from Context

**Files:**
- Modify: `xkeen-ui/templates/panel.html:1-70`
- Modify: `xkeen-ui/templates/panel/navigation.html:3-34`
- Modify: `xkeen-ui/templates/panel/header.html:36-140`
- Modify: `xkeen-ui/templates/panel/shell.html:26-47`
- Create: `xkeen-ui/templates/panel/slots/xray_badge.html`
- Create: `xkeen-ui/templates/panel/slots/diagnostics_summary.html`
- Create: `xkeen-ui/templates/panel/slots/diagnostics_actions.html`
- Create: `xkeen-ui/templates/panel/slots/routing_focus.html`
- Modify: `tests/test_modular_panel_stage4_2_shell.py`
- Modify: `tests/test_modular_panel_stage4_3_routing_screen.py`
- Modify: `tests/test_modular_panel_stage4_3_xray_logs_screen.py`
- Modify: `tests/test_modular_panel_stage4_3_mihomo_screen.py`
- Modify: `tests/test_modular_panel_stage4_3_xkeen_screen.py`
- Modify: `tests/test_modular_panel_stage4_3_tool_screens.py`
- Modify: `tests/test_modular_panel_stage4_4_modals.py`
- Test: `tests/test_modular_panel_stage4_5_composition.py`

**Interfaces:**
- Consumes: the `page_context` collections built in Task 1.
- Produces: identical Full/Legacy document order and only owner-authorized server markup in minimal profiles.
- Preserves: `top-tab-files`, `top-tab-mihomo-generator`, `top-tab-donate`, all `view-*` ids, existing modal ids, and core page config.

- [x] **Step 1: Add failing profile-render assertions**

Extend the new Stage 4.5 test using `render_panel` and literal expected output. Assert navigation and module-owned shell ids as behavior, rather than source text.

```python
def test_core_only_html_has_no_optional_navigation_or_shell_markup(tmp_path):
    html = render_panel(["core"], tmp_path)

    assert _nav_views(html) == ["xkeen", "donate"]
    for marker in (
        'id="view-routing"', 'id="view-mihomo"', 'id="view-commands"',
        'id="view-files"', 'id="xray-logs-badge"',
        'id="xk-resource-monitor"', 'id="routing-focus-switch"',
    ):
        assert marker not in html
```

Also assert Full and Legacy have equal screen, modal, navigation, and shell-id sets; assert an inactive Mihomo profile never resolves `mihomo_generator_page`.

- [x] **Step 2: Run render tests to verify they fail**

Run: `python -m pytest -q tests/test_modular_panel_stage4_5_composition.py`

Expected: FAIL because old templates still emit terminal/files navigation and routing shell controls independently of active modules.

- [x] **Step 3: Replace template gate chains with composition loops**

In `panel.html`, retain literal `head.html` and `shell.html` entry includes, but replace screen/modal owner chains with loops:

```jinja2
{% for screen_partial in page_context.screen_partials %}
{% include screen_partial %}
{% endfor %}
```

In `navigation.html`, render items from `page_context.navigation_items`. Preserve current classes, ids, `data-view`, `data-xk-section`, `data-nav-href`, and `data-xk-top-nav` via manifest metadata; mark only the first rendered in-panel view as active.

Move the Xray badge, diagnostics summary, diagnostics links, and routing-focus control into the four owner partials listed above. At their original insertion points, `header.html` and `shell.html` loop over the matching `page_context` collections. Leave core controls and presentation markup where they are.

- [x] **Step 4: Update historical Stage 4 guards**

Replace assertions that require direct literal include/gate text in `panel.html` with assertions against `PANEL_COMPOSITION`, selected `page_context`, and rendered output. Retain existing ownership, DOM-order, duplicate-id, and mixed-HWID assertions. Update static source checks for the explicit dynamic include expansion, without reducing DOM coverage.

- [x] **Step 5: Run all Stage 4 composition tests to verify they pass**

Run: `python -m pytest -q tests/test_modular_panel_stage4_1_contract.py tests/test_modular_panel_stage4_2_shell.py tests/test_modular_panel_stage4_3_routing_screen.py tests/test_modular_panel_stage4_3_xray_logs_screen.py tests/test_modular_panel_stage4_3_mihomo_screen.py tests/test_modular_panel_stage4_3_xkeen_screen.py tests/test_modular_panel_stage4_3_tool_screens.py tests/test_modular_panel_stage4_4_modals.py tests/test_modular_panel_stage4_5_composition.py`

Expected: PASS. Full/Legacy remain structurally complete; Xray-only, Mihomo-only, and core-only lack every inactive surface.

- [x] **Step 6: Commit the template composition**

```bash
git add xkeen-ui/templates/panel.html xkeen-ui/templates/panel/navigation.html xkeen-ui/templates/panel/header.html xkeen-ui/templates/panel/shell.html xkeen-ui/templates/panel/slots tests/test_modular_panel_stage4_*.py
git commit -m "feat(panel): compose HTML from active modules"
```

### Task 3: Close Stage 4.5 and Regenerate Contracts

**Files:**
- Create: `docs/modular-panel-stage4.5-composition.md`
- Modify: `README-modular-panel-plan.md`
- Modify: `docs/README.md`
- Modify: `docs/modular-panel-stage0-inventory.json`
- Modify: `docs/modular-panel-stage0-inventory.md`
- Modify: `docs/modular-panel-stage4.1-contract.json`
- Modify: `docs/modular-panel-stage4.1-contract.md`
- Modify: `xkeen-ui/module-sizes.json` only if regenerated sizes differ
- Test: `tests/test_modular_panel_stage4_5_composition.py`

**Interfaces:**
- Consumes: passing Task 1-2 server-side composition and existing generators.
- Produces: a closed Stage 4.5 record, current inventory snapshots, and a docs index link.

- [x] **Step 1: Add a failing closure-documentation test**

```python
def test_stage4_5_closure_is_documented():
    assert "**Статус:** закрыт 1 октября 2026 года." in plan
    assert "modular-panel-stage4.5-composition.md" in plan
    assert "modular-panel-stage4.5-composition.md" in docs_index
    assert "Критерий завершения **выполнен**" in contract
```

- [x] **Step 2: Run the documentation test to verify it fails**

Run: `python -m pytest -q tests/test_modular_panel_stage4_5_composition.py::test_stage4_5_closure_is_documented`

Expected: FAIL because the 4.5 closure document and status do not exist.

- [x] **Step 3: Write closure documentation and regenerate snapshots**

Document the manifest boundary, legacy fallback, profile matrix, dynamic-source resolver guard, test command, and explicit Stage 5 non-goals in `docs/modular-panel-stage4.5-composition.md`. Mark 4.5 closed and 4.6 next in `README-modular-panel-plan.md`; add the document to `docs/README.md`.

Run:

```bash
python scripts/generate_modular_panel_inventory.py --root .
python scripts/generate_modular_panel_stage4_1_contract.py --root .
python scripts/generate_panel_operator_inventory.py --root .
python scripts/sync_module_sizes.py --root .
```

Inspect generated diffs and retain only changes caused by the composition source graph.

- [x] **Step 4: Run closure and generated-artifact tests**

Run: `python -m pytest -q tests/test_modular_panel_stage4_5_composition.py tests/test_modular_panel_stage4_1_contract.py tests/test_modular_panel_stage0_inventory.py tests/test_panel_operator_stage0_contract.py`

Expected: PASS with generated snapshots matching source.

- [x] **Step 5: Run the full suite and inspect live profiles**

Run: `python -m pytest -q`

Restart the local E2E panel and inspect Full, Xray-only, Mihomo-only, and core-only profiles using real `modules.json` state. Verify rendered navigation and first selected view; do not select a core source or change router configuration during the smoke check.

- [x] **Step 6: Commit the completed stage**

```bash
git add docs README-modular-panel-plan.md xkeen-ui/module-sizes.json docs/modular-panel-stage0-inventory.json docs/modular-panel-stage0-inventory.md docs/modular-panel-stage4.1-contract.json docs/modular-panel-stage4.1-contract.md
git commit -m "docs(panel): close stage 4.5 composition"
```

## Plan Self-Review

- Spec coverage: Tasks 1-2 implement every composition rule; Task 3 records closure and regenerates source snapshots.
- Placeholders: no task contains an unspecified implementation or test command.
- Type consistency: the only new template contract is `page_context`; all producer and consumer names are declared in Task 1 and used consistently by Task 2.
