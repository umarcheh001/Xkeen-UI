from __future__ import annotations

import routes.pages as pages
from scripts.panel_template_source import DYNAMIC_COMPOSITION_INCLUDE_PATHS


FULL_MODULE_IDS = {
    "core",
    "engine.xray",
    "engine.mihomo",
    "tool.editor",
    "tool.terminal",
    "tool.files",
    "tool.backups",
    "integration.happ",
    "tool.advanced-diagnostics",
}
XRAY_MINIMAL_MODULE_IDS = {"core", "tool.editor", "engine.xray"}
MIHOMO_MINIMAL_MODULE_IDS = {"core", "tool.editor", "engine.mihomo"}


def _page_context(module_ids: set[str] | None) -> dict[str, object]:
    return pages._build_panel_page_context(module_ids)


def _paths(context: dict[str, object], key: str) -> list[str]:
    return list(context[key])


def _navigation_sections(context: dict[str, object]) -> list[str]:
    return [str(item["section"]) for item in context["navigation_items"]]


def test_page_context_filters_each_surface_by_declared_owners():
    xray = _page_context(XRAY_MINIMAL_MODULE_IDS)
    mihomo = _page_context(MIHOMO_MINIMAL_MODULE_IDS)
    core = _page_context({"core"})

    assert _paths(xray, "screen_partials") == [
        "panel/screens/routing.html",
        "panel/screens/xkeen.html",
        "panel/screens/xray_logs.html",
    ]
    assert _paths(xray, "modal_partials") == [
        "panel/modals/routing.html",
        "panel/modals/shared.html",
        "panel/modals/editor.html",
    ]
    assert _navigation_sections(xray) == ["routing", "xkeen", "xray-logs", "donate"]

    assert _paths(mihomo, "screen_partials") == [
        "panel/screens/mihomo.html",
        "panel/screens/xkeen.html",
    ]
    assert _paths(mihomo, "modal_partials") == [
        "panel/modals/shared.html",
        "panel/modals/mihomo.html",
        "panel/modals/editor.html",
    ]
    assert _navigation_sections(mihomo) == ["mihomo", "xkeen", "mihomo-generator", "donate"]

    assert _paths(core, "screen_partials") == ["panel/screens/xkeen.html"]
    assert _paths(core, "modal_partials") == ["panel/modals/shared.html"]
    assert _navigation_sections(core) == ["xkeen", "donate"]


def test_page_context_is_deterministic_and_legacy_keeps_full_composition():
    full = _page_context(FULL_MODULE_IDS)
    shuffled = _page_context(set(reversed(tuple(FULL_MODULE_IDS))))
    legacy = _page_context(None)

    assert full == shuffled
    for key in ("navigation_items", "screen_partials", "modal_partials"):
        assert legacy[key] == full[key]
    assert legacy["legacy_fallback"] is True
    assert full["legacy_fallback"] is False


def test_composition_declares_only_known_static_template_paths():
    expected = {
        "panel/screens/routing.html",
        "panel/screens/mihomo.html",
        "panel/screens/xkeen.html",
        "panel/screens/commands.html",
        "panel/screens/files.html",
        "panel/screens/xray_logs.html",
        "panel/modals/diagnostics.html",
        "panel/modals/routing.html",
        "panel/modals/commands.html",
        "panel/modals/shared.html",
        "panel/modals/mihomo.html",
        "panel/modals/happ.html",
        "panel/modals/files.html",
        "panel/modals/files_editor.html",
        "panel/modals/editor.html",
        "panel/slots/xray_badge.html",
        "panel/slots/diagnostics_summary.html",
        "panel/slots/diagnostics_actions.html",
        "panel/slots/routing_focus.html",
    }

    assert set(pages.PANEL_COMPOSITION_PARTIALS) == expected


def test_static_source_resolver_catalog_matches_the_runtime_manifest():
    static_paths = {
        path
        for paths in DYNAMIC_COMPOSITION_INCLUDE_PATHS.values()
        for path in paths
    }

    assert static_paths == set(pages.PANEL_COMPOSITION_PARTIALS)
