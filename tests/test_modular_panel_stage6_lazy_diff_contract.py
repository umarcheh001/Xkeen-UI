"""Stage 6 made the diff viewer lazy; these pin what keeps it reachable."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "xkeen-ui" / "static" / "js"

READY_EVENT = "xkeen:diff-engine-ready"


def _read(rel: str) -> str:
    return (JS / rel).read_text(encoding="utf-8")


def test_diff_engine_announces_itself_after_its_api_is_published():
    # Screens start before the viewer is loaded and cannot register a scope
    # then; without the announcement Compare loaded the viewer and opened
    # nothing, because its scope was never registered.
    source = _read("ui/diff_engine.js")

    announce = f"new CustomEvent('{READY_EVENT}')"
    assert source.count(announce) == 1
    assert source.index("XKeen.ui.diff.registerScope = registerScope;") < source.index(announce)
    assert source.index("XKeen.ui.diff.openForScope = openForScope;") < source.index(announce)


def test_every_diff_scope_owner_registers_when_the_viewer_arrives():
    owners = {
        "features/routing.js": "ensureRoutingDiffScopeRegistered",
        "features/mihomo_panel.js": "ensureMihomoDiffScopeRegistered",
        "ui/json_editor_modal.js": "ensureJsonEditorDiffScopeRegistered",
    }
    registering = sorted(
        path.relative_to(JS).as_posix()
        for path in JS.rglob("*.js")
        if path.name != "diff_engine.js"  # its header documents the call
        and "diff.registerScope(" in path.read_text(encoding="utf-8", errors="replace")
    )
    assert registering == sorted(owners), "a new diff scope owner needs the ready listener too"

    for rel, function_name in owners.items():
        source = _read(rel)
        listener = f"document.addEventListener('{READY_EVENT}', () => {{"
        assert source.count(listener) == 1, rel
        tail = source[source.index(listener):source.index(listener) + 200]
        assert f"{function_name}();" in tail, rel


def test_a_variant_without_a_capability_does_not_offer_it():
    actions = _read("ui/editor_actions.js")
    bindings = _read("pages/panel.lazy_bindings.runtime.js")
    routing = _read("features/routing.js")

    # No Compare button when the diff viewer is not part of the variant.
    assert "if (item.requiresDiffScope === true && !isEditorCapabilityOffered('diff')) return;" in actions
    # Pages without the module descriptor keep every tool.
    assert "if (!capabilities || typeof capabilities.has !== 'function') return true;" in actions

    assert "has: isPanelEditorCapabilityActive," in bindings
    assert "markUnavailableEngines: markUnavailableEditorEngines," in bindings
    assert "if (isPanelEditorCapabilityActive('monaco')) return;" in bindings
    assert "select[id$=\"engine-select\"] option[value=\"monaco\"]" in bindings
    # The routing engine list is built in code, not in the markup.
    assert "capabilities.markUnavailableEngines([o2]);" in routing
