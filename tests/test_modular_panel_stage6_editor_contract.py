from __future__ import annotations

import json
from pathlib import Path

from routes.pages import build_panel_frontend_modules


ROOT = Path(__file__).resolve().parents[1]
PAGES = ROOT / "xkeen-ui" / "static" / "js" / "pages"


def _bundle_keys(descriptor: dict[str, object]) -> set[str]:
    return {
        str(item["key"])
        for item in descriptor["bundles"]
        if isinstance(item, dict) and item.get("key")
    }


def test_editor_descriptor_gates_optional_bundles_by_variant():
    active = {"core", "tool.editor", "engine.xray"}

    light = build_panel_frontend_modules(active, editor_variant="light")
    full = build_panel_frontend_modules(active, editor_variant="full")
    advanced = build_panel_frontend_modules(active, editor_variant="advanced")

    assert light["editor"] == {
        "variant": "light",
        "capabilities": ["codemirror", "schema-basic"],
        "availableVariants": ["light", "full", "advanced"],
    }
    assert _bundle_keys(light) == {"panel-core", "panel-routing", "editor-runtime", "editor-codemirror"}
    assert _bundle_keys(full) >= {
        "panel-core",
        "panel-routing",
        "editor-runtime",
        "editor-codemirror",
        "editor-monaco",
        "editor-diff",
    }
    assert "editor-enhancements" not in _bundle_keys(full)
    assert _bundle_keys(advanced) >= {"editor-monaco", "editor-diff", "editor-enhancements"}


def test_editor_bundle_descriptor_is_local_and_capability_annotated():
    descriptor = build_panel_frontend_modules(
        {"core", "tool.editor", "engine.xray"}, editor_variant="advanced"
    )
    bundles = {item["key"]: item for item in descriptor["bundles"] if isinstance(item, dict)}

    assert bundles["editor-codemirror"]["capabilities"] == ["codemirror"]
    assert bundles["editor-monaco"]["capabilities"] == ["monaco"]
    assert bundles["editor-diff"]["capabilities"] == ["diff"]
    assert bundles["editor-enhancements"]["capabilities"] == [
        "prettier",
        "quick-fix",
        "schema-extended",
    ]
    assert all("path" not in item and "import" not in item for item in bundles.values())


def test_local_loader_has_editor_capability_allow_list_and_no_diff_in_light_core():
    loader = (PAGES / "panel.module_loader.js").read_text(encoding="utf-8")
    core = (PAGES / "panel.editor.bundle.js").read_text(encoding="utf-8")
    cm = (PAGES / "panel.editor.codemirror.bundle.js").read_text(encoding="utf-8")
    monaco = (PAGES / "panel.editor.monaco.bundle.js").read_text(encoding="utf-8")
    diff = (PAGES / "panel.editor.diff.bundle.js").read_text(encoding="utf-8")
    enhancements = (PAGES / "panel.editor.enhancements.bundle.js").read_text(encoding="utf-8")
    bindings = (PAGES / "panel.lazy_bindings.runtime.js").read_text(encoding="utf-8")

    for key in ("editor-codemirror", "editor-monaco", "editor-diff", "editor-enhancements"):
        assert f"'{key}'" in loader
    assert "editor-codemirror" in bindings
    assert "editor-monaco" in bindings
    assert "editor-diff" in bindings
    assert "diff_engine.js" not in core
    assert "diff_modal.js" not in core
    assert "codemirror6.shared.js" in cm
    assert "editor_monaco.shared.js" in monaco
    assert "diff_engine.js" in diff
    assert "diff_modal.js" in diff
    assert "prettier_loader.js" in enhancements


def test_engine_bundles_do_not_eagerly_import_advanced_quick_fixes():
    schema = (ROOT / "xkeen-ui" / "static" / "js" / "ui" / "editor_schema.js").read_text(encoding="utf-8")
    routing = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing.js").read_text(encoding="utf-8")
    mihomo = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_panel.js").read_text(encoding="utf-8")

    assert "schema_quickfixes.js" not in schema
    assert "from '../ui/schema_quickfixes.js'" not in routing
    assert "from '../ui/schema_quickfixes.js'" not in mihomo
    assert "import('../ui/schema_quickfixes.js')" in routing
    assert "import('../ui/schema_quickfixes.js')" in mihomo


def test_stage6_descriptor_is_json_serializable():
    descriptor = build_panel_frontend_modules(
        {"core", "tool.editor", "engine.mihomo"}, editor_variant="full"
    )
    json.dumps(descriptor)
