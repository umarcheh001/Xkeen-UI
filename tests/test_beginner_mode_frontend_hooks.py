"""Substring-level guards for Phase 5 (beginner-mode hover + diagnostic severity).

These tests do not execute JS — they assert that key hooks are wired into the
frontend sources, so accidental refactors do not silently strip the
beginner-mode rendering path or the new info/suggestion diagnostic severity.
"""

from __future__ import annotations

from pathlib import Path


JS_DIR = Path(__file__).resolve().parents[1] / "xkeen-ui" / "static" / "js"


def _read(path: Path) -> str:
    with path.open("r", encoding="utf-8") as f:
        return f.read()


# ---------- CodeMirror JSON schema hover ----------


def test_codemirror_json_schema_renders_beginner_block():
    src = _read(JS_DIR / "vendor" / "codemirror_json_schema.js")
    assert "function _readBeginnerMeta(" in src
    assert "function renderBeginnerBlockHtml(" in src
    assert "function renderBeginnerBlockMarkdown(" in src
    assert "function renderBeginnerBlockPlain(" in src
    assert "function _resolveHoverOptions(" in src
    assert "options.getBeginnerMode" in src
    assert "x-ui-explain" in src
    assert "x-ui-use-case" in src
    assert "x-ui-example" in src
    assert "x-ui-warning" in src


# ---------- YAML schema hover (Mihomo) ----------


def test_yaml_schema_renders_beginner_block():
    src = _read(JS_DIR / "ui" / "yaml_schema.js")
    assert "function _readYamlBeginnerMeta(" in src
    assert "function _formatYamlBeginnerBlockPlain(" in src
    assert "function _formatYamlBeginnerBlockMarkdown(" in src
    assert "options.beginnerMode" in src
    assert "beginnerMode: !!options.beginnerMode" in src


# ---------- CodeMirror 6 boot wires settings → hover/diagnostics ----------


def test_codemirror6_boot_reads_beginner_mode_setting_and_appends_hint():
    src = _read(JS_DIR / "ui" / "codemirror6_boot.js")
    assert "function isBeginnerModeEnabled(" in src
    assert "editor.beginnerModeEnabled === true" in src
    assert "getBeginnerMode" in src
    assert "beginnerMode: isBeginnerModeEnabled(opts)" in src
    # Diagnostic hint surfacing in CM6 lint normalization
    assert "Подсказка:" in src


# ---------- Monaco shared hover providers ----------


def test_monaco_shared_passes_beginner_mode_to_hover_builders():
    src = _read(JS_DIR / "ui" / "monaco_shared.js")
    assert "function _isBeginnerModeEnabled(" in src
    assert "editor.beginnerModeEnabled === true" in src
    # Both JSON and YAML hover providers should opt into beginner mode
    assert src.count("beginnerMode: _isBeginnerModeEnabled()") >= 2


# ---------- Semantic diagnostic severity ----------


def test_schema_semantic_validation_supports_info_and_hint():
    src = _read(JS_DIR / "ui" / "schema_semantic_validation.js")
    assert "function _normalizeSeverity(" in src
    # info/suggestion/hint all collapse into the same level
    assert "'info'" in src
    assert "'suggestion'" in src
    assert "'hint'" in src
    # hint payload is preserved on the diagnostic
    assert "hint" in src


# ---------- Monaco marker mapping in routing.js / mihomo_panel.js ----------


def test_routing_marker_mapping_handles_info_and_appends_hint():
    src = _read(JS_DIR / "features" / "routing.js")
    assert "rawSev === 'info'" in src
    assert "rawSev === 'suggestion'" in src
    assert "rawSev === 'hint'" in src
    assert "Подсказка:" in src


def test_mihomo_panel_marker_mapping_appends_hint():
    src = _read(JS_DIR / "features" / "mihomo_panel.js")
    assert "Подсказка:" in src


# ---------- Settings panel exposes the toggle ----------


def test_settings_panel_exposes_beginner_mode_switch():
    src = _read(JS_DIR / "ui" / "settings_panel.js")
    assert "editor-beginner-mode" in src
    assert "editor.beginnerModeEnabled" in src


def test_settings_module_defaults_beginner_mode_to_false():
    src = _read(JS_DIR / "ui" / "settings.js")
    assert "beginnerModeEnabled: false" in src
