from __future__ import annotations

import routes.pages as pages


FULL_ENGINES = {"core", "tool.editor", "engine.xray", "engine.mihomo"}


def test_detected_cores_follow_installed_binaries_not_active_engines(monkeypatch):
    # legacy-full keeps both engines active on a router with only Xray
    # installed; the core watcher must still see just the installed binary,
    # otherwise /api/xkeen/core never matches and the panel reloads forever.
    monkeypatch.setattr(pages, "detect_available_cores", lambda: ["xray"])

    ui = pages._detect_panel_core_ui(FULL_ENGINES)

    assert ui["available_cores"] == ["xray", "mihomo"]
    assert ui["detected_cores"] == ["xray"]
    assert ui["core_ui_fallback"] is False
    assert ui["has_mihomo"] is True


def test_no_installed_binaries_switch_the_watcher_to_fallback(monkeypatch):
    monkeypatch.setattr(pages, "detect_available_cores", lambda: [])

    ui = pages._detect_panel_core_ui(FULL_ENGINES)

    assert ui["detected_cores"] == []
    assert ui["core_ui_fallback"] is True
    assert ui["available_cores"] == ["xray", "mihomo"]
