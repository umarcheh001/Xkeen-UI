from __future__ import annotations

from pathlib import Path


JS_DIR = Path(__file__).resolve().parents[1] / "xkeen-ui" / "static" / "js"


def _read(path: Path) -> str:
    with path.open("r", encoding="utf-8") as f:
        return f.read()


def test_settings_module_and_panel_expose_expert_mode_toggle():
    settings_src = _read(JS_DIR / "ui" / "settings.js")
    panel_src = _read(JS_DIR / "ui" / "settings_panel.js")

    assert "expertModeEnabled: false" in settings_src
    assert "isEditorExpertModeEnabled" in settings_src
    assert "editor-expert-mode" in panel_src
    assert "editor.expertModeEnabled" in panel_src
    assert "Эксперт" in panel_src


def test_editor_schema_skips_schema_assist_in_expert_mode():
    src = _read(JS_DIR / "ui" / "editor_schema.js")

    assert "function isEditorExpertModeEnabled(ctx)" in src
    assert "reason: 'expert-mode'" in src
    assert "if (isEditorExpertModeEnabled(ctx)) return null;" in src
    assert "if (isEditorExpertModeEnabled(o)) {" in src


def test_codemirror_and_monaco_runtime_gate_schema_assist_in_expert_mode():
    cm_src = _read(JS_DIR / "ui" / "codemirror6_boot.js")
    monaco_src = _read(JS_DIR / "ui" / "monaco_shared.js")

    assert "function isEditorExpertModeEnabled(opts)" in cm_src
    assert "if (!schema || isEditorExpertModeEnabled(opts)) return [];" in cm_src
    assert "if (isEditorExpertModeEnabled(opts)) return null;" in cm_src
    assert "if (isEditorExpertModeEnabled(options)) return [];" in cm_src

    assert "function _isEditorExpertModeEnabled(opts, snapshot)" in monaco_src
    assert "if (_isEditorExpertModeEnabled()) return [];" in monaco_src
    assert "if (_isEditorExpertModeEnabled()) return { suggestions: [] };" in monaco_src
    assert "if (_isEditorExpertModeEnabled()) return null;" in monaco_src


def test_routing_and_mihomo_hide_quick_fix_in_expert_mode():
    routing_src = _read(JS_DIR / "features" / "routing.js")
    mihomo_src = _read(JS_DIR / "features" / "mihomo_panel.js")

    assert "function isRoutingExpertModeEnabled()" in routing_src
    assert "if (isQuickFix && expert) {" in routing_src
    assert "Экспертный режим отключает quick fix" in routing_src
    assert "wireRoutingUiSettingsSyncOnce" in routing_src

    assert "function isMihomoExpertModeEnabled()" in mihomo_src
    assert "if (isQuickFix && expert) {" in mihomo_src
    assert "Экспертный режим отключает quick fix" in mihomo_src
    assert "wireMihomoUiSettingsSyncOnce" in mihomo_src
