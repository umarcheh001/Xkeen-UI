from __future__ import annotations

from pathlib import Path

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


MODULE_SETS = (
    None,
    FULL_ENGINES,
    {"core"},
    {"core", "tool.editor", "engine.xray"},
    {"core", "tool.editor", "engine.mihomo"},
    FULL_ENGINES | {"tool.terminal", "tool.files", "tool.advanced-diagnostics"},
)


def test_every_composed_navigation_item_is_in_the_published_whitelist(monkeypatch):
    # ui/sections.js hides each [data-xk-section] button that is missing
    # from the whitelist, so a section left out here is in the markup and
    # never on the screen.
    monkeypatch.delenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", raising=False)
    monkeypatch.setattr(pages, "detect_available_cores", lambda: ["xray", "mihomo"])

    for module_ids in MODULE_SETS:
        ui = pages._detect_panel_core_ui(module_ids)
        published = set(str(ui["panel_sections_whitelist"]).split(","))
        context = pages._build_panel_page_context(module_ids)
        composed = {item["section"] for item in context["navigation_items"]}

        assert composed <= published, (module_ids, sorted(composed - published))


def test_modules_link_is_outside_the_sections_a_whitelist_can_hide(monkeypatch):
    # The way to updates is an item of the gear menu: it is not a section,
    # so no whitelist, however old, can take it off the screen.
    monkeypatch.setenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", "routing,xkeen")
    monkeypatch.setattr(pages, "detect_available_cores", lambda: ["xray", "mihomo"])
    header = (Path(pages.__file__).resolve().parents[1] / "templates" / "panel" / "header.html").read_text(encoding="utf-8")

    assert "url_for('modules_page')" in header
    assert 'data-xk-section="modules"' not in header
    for module_ids in MODULE_SETS:
        ui = pages._detect_panel_core_ui(module_ids)
        published = set(str(ui["panel_sections_whitelist"]).split(","))
        composed = {item["section"] for item in pages._build_panel_page_context(module_ids)["navigation_items"]}

        assert "modules" not in published | composed, module_ids


def test_whitelist_without_known_sections_still_shows_everything(monkeypatch):
    monkeypatch.setenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", "no-such-section")
    monkeypatch.setattr(pages, "detect_available_cores", lambda: ["xray", "mihomo"])

    for module_ids in MODULE_SETS:
        ui = pages._detect_panel_core_ui(module_ids)
        published = set(str(ui["panel_sections_whitelist"]).split(","))

        assert {"xkeen", "donate"} <= published, module_ids
