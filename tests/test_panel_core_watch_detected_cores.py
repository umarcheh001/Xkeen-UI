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
        assert "modules" in composed, module_ids


def test_modules_item_stays_visible_under_a_whitelist_written_before_it_existed(monkeypatch):
    # The item carries the update badge; a list saved by an older panel
    # cannot name it and must not hide it.
    monkeypatch.setenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", "routing,xkeen")
    monkeypatch.setattr(pages, "detect_available_cores", lambda: ["xray", "mihomo"])

    for module_ids in MODULE_SETS:
        ui = pages._detect_panel_core_ui(module_ids)
        published = str(ui["panel_sections_whitelist"]).split(",")

        assert "modules" in published, module_ids
        assert set(published) <= {"routing", "xkeen", "modules"}, module_ids


def test_whitelist_without_known_sections_still_shows_everything(monkeypatch):
    monkeypatch.setenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", "no-such-section")
    monkeypatch.setattr(pages, "detect_available_cores", lambda: ["xray", "mihomo"])

    for module_ids in MODULE_SETS:
        ui = pages._detect_panel_core_ui(module_ids)
        published = set(str(ui["panel_sections_whitelist"]).split(","))

        assert {"xkeen", "modules", "donate"} <= published, module_ids
