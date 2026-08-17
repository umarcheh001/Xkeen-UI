from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SETTINGS_PANEL = ROOT / "xkeen-ui" / "static" / "js" / "ui" / "settings_panel.js"
PANEL_TEMPLATE = ROOT / "xkeen-ui" / "templates" / "panel.html"
MIHOMO_GROUPS = ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_clash" / "groups.js"
EDITOR_ENGINE = ROOT / "xkeen-ui" / "static" / "js" / "ui" / "editor_engine.js"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_contextual_controls_are_not_duplicated_in_ui_settings():
    settings_panel = _read(SETTINGS_PANEL)
    panel_template = _read(PANEL_TEMPLATE)

    # These preferences still live in /api/ui-settings, but their only UI is
    # next to the feature whose result they affect.
    assert "'editor.engine'" not in settings_panel
    assert "'mihomo.proxySortOrder'" not in settings_panel
    assert "'mihomo.latencyPreset'" not in settings_panel

    assert 'id="mihomo-editor-engine-select"' in panel_template
    assert 'id="mihomo-clash-groups-sort"' in panel_template
    assert 'id="mihomo-clash-latency-preset"' in panel_template


def test_contextual_controls_keep_server_side_ui_settings_persistence():
    editor_engine = _read(EDITOR_ENGINE)
    mihomo_groups = _read(MIHOMO_GROUPS)

    assert "await settingsApi.patch({ editor: { engine: _engine } });" in editor_engine
    assert "persistMihomoViewSettings({ proxySortOrder: sortMode });" in mihomo_groups
    assert "persistMihomoViewSettings({ latencyPreset });" in mihomo_groups

