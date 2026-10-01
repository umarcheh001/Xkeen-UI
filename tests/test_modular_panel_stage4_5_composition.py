from __future__ import annotations

import re
from pathlib import Path

import routes.pages as pages
from scripts.panel_template_source import (
    DYNAMIC_COMPOSITION_INCLUDE_PATHS,
    DYNAMIC_NAVIGATION_ITEMS,
)
from tests.support.panel_render import (
    FULL_MODULE_IDS as RENDER_FULL_MODULE_IDS,
    render_panel,
)


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


def test_static_source_resolver_navigation_catalog_matches_runtime_manifest():
    static_items = tuple(
        (
            item["owners"],
            item["section"],
            item["label"],
            item["class_name"],
            item["view"],
            item["element_id"],
            item["href_endpoint"],
            item["top_nav"],
        )
        for item in DYNAMIC_NAVIGATION_ITEMS
    )
    runtime_items = tuple(
        (
            entry.owners,
            entry.section,
            entry.label,
            entry.class_name,
            entry.view,
            entry.element_id,
            entry.href_endpoint,
            entry.top_nav,
        )
        for entry in pages.PANEL_NAVIGATION
    )

    assert static_items == runtime_items


def _navigation_sections_from_html(html: str) -> list[str]:
    navigation = html.split('<div class="top-tabs header-tabs"', 1)[1].split("</div>", 1)[0]
    return re.findall(r'data-xk-section="([^"]+)"', navigation)


def test_core_only_html_has_no_optional_navigation_or_shell_markup(tmp_path):
    html = render_panel(["core"], tmp_path)

    assert _navigation_sections_from_html(html) == ["xkeen", "donate"]
    for marker in (
        'id="view-routing"',
        'id="view-mihomo"',
        'id="view-commands"',
        'id="view-files"',
        'id="xray-logs-badge"',
        'id="xk-resource-monitor"',
        'id="routing-focus-switch"',
    ):
        assert marker not in html


def test_legacy_and_full_html_keep_the_same_composed_surface_set(tmp_path):
    full = render_panel(RENDER_FULL_MODULE_IDS, tmp_path / "full")
    legacy = render_panel(None, tmp_path / "legacy")

    for marker in (
        'id="view-routing"',
        'id="view-mihomo"',
        'id="view-xkeen"',
        'id="view-commands"',
        'id="view-files"',
        'id="view-xray-logs"',
        'id="routing-focus-switch"',
    ):
        assert (marker in full) == (marker in legacy)


def test_full_profile_preserves_the_diagnostics_modal_position_before_screens(tmp_path):
    html = render_panel(RENDER_FULL_MODULE_IDS, tmp_path)

    assert html.index('id="xk-resource-dashboard-modal"') < html.index('id="view-routing"')


def test_stage4_5_closure_is_documented():
    root = Path(__file__).resolve().parents[1]
    plan = (root / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    index = (root / "docs/README.md").read_text(encoding="utf-8")
    contract = (root / "docs/modular-panel-stage4.5-composition.md").read_text(encoding="utf-8")

    assert "**Статус:** закрыт 1 октября 2026 года." in plan
    assert "Этап 4 закрыт; следующий — Этап 5" in plan
    assert "modular-panel-stage4.5-composition.md" in plan
    assert "modular-panel-stage4.5-composition.md" in index
    assert "Критерий завершения **выполнен**" in contract
