"""Compose the panel Jinja source for static contract/inventory checks.

The runtime template intentionally keeps the shell and screen markup in
separate Jinja partials.  Static inventories still need to inspect the
effective document rather than only the small composition root, so this helper
expands local ``panel/`` includes without evaluating Jinja expressions.
"""

from __future__ import annotations

import re
from pathlib import Path


_INCLUDE_RE = re.compile(
    r"""\{%-?\s*include\s+["'](?P<path>panel/[^"']+)["']\s*-?%\}"""
)
_MACRO_IMPORT_RE = re.compile(
    r"""\{%-?\s*from\s+["']panel/macros\.html["']\s+import\s+op_icon\s*-?%\}\s*"""
)
_DYNAMIC_INCLUDE_RE = re.compile(
    r"""\{%-?\s*include\s+(?P<name>header_badge_partial|header_summary_partial|header_action_partial|control_partial|routing_inbounds_action_partial|routing_outbounds_action_partial|routing_side_card_partial|routing_file_action_partial|core_source_control_partial|pre_screen_modal_partial|screen_partial|modal_partial)\s*-?%\}"""
)
_DYNAMIC_NAVIGATION_LOOP_RE = re.compile(
    r"""\{%-?\s*for\s+item\s+in\s+page_context\.navigation_items\s*-?%\}.*?\{%-?\s*endfor\s*-?%\}""",
    re.DOTALL,
)


# Dynamic composition loops are intentionally limited to these server-owned
# paths. Static inventories expand every Full/Legacy branch without evaluating
# arbitrary Jinja expressions or accepting template names from runtime input.
DYNAMIC_COMPOSITION_INCLUDE_PATHS: dict[str, tuple[str, ...]] = {
    "header_badge_partial": ("panel/slots/xray_badge.html",),
    "header_summary_partial": ("panel/slots/diagnostics_summary.html",),
    "header_action_partial": ("panel/slots/diagnostics_actions.html",),
    "control_partial": ("panel/slots/routing_focus.html",),
    "routing_inbounds_action_partial": ("panel/slots/backups_inbounds_actions.html",),
    "routing_outbounds_action_partial": ("panel/slots/backups_outbounds_actions.html",),
    "routing_side_card_partial": ("panel/slots/backups_xray_card.html",),
    "routing_file_action_partial": ("panel/slots/backups_routing_actions.html",),
    "core_source_control_partial": (
        "panel/slots/core_source_xray.html",
        "panel/slots/core_source_mihomo.html",
    ),
    "pre_screen_modal_partial": ("panel/modals/diagnostics.html",),
    "screen_partial": (
        "panel/screens/routing.html",
        "panel/screens/mihomo.html",
        "panel/screens/xkeen.html",
        "panel/screens/commands.html",
        "panel/screens/files.html",
        "panel/screens/xray_logs.html",
    ),
    "modal_partial": (
        "panel/modals/routing.html",
        "panel/modals/commands.html",
        "panel/modals/shared.html",
        "panel/modals/core_source_xray.html",
        "panel/modals/core_source_mihomo.html",
        "panel/modals/mihomo.html",
        "panel/modals/happ.html",
        "panel/modals/files.html",
        "panel/modals/files_editor.html",
        "panel/modals/editor.html",
    ),
}


# This mirrors PANEL_NAVIGATION without importing Flask routes in static tools.
# Tests compare the complete tuple with the runtime manifest to prevent drift.
DYNAMIC_NAVIGATION_ITEMS: tuple[dict[str, object], ...] = (
    {
        "owners": ("engine.xray",),
        "section": "routing",
        "label": "Роутинг Xray",
        "class_name": "top-tab-btn xk-top-tab xk-top-tab-routing",
        "view": "routing",
        "element_id": None,
        "href_endpoint": None,
        "top_nav": False,
    },
    {
        "owners": ("engine.mihomo",),
        "section": "mihomo",
        "label": "Роутинг Mihomo",
        "class_name": "top-tab-btn xk-top-tab xk-top-tab-mihomo",
        "view": "mihomo",
        "element_id": None,
        "href_endpoint": None,
        "top_nav": False,
    },
    {
        "owners": ("core",),
        "section": "xkeen",
        "label": "Порты и исключения",
        "class_name": "top-tab-btn xk-top-tab xk-top-tab-xkeen",
        "view": "xkeen",
        "element_id": None,
        "href_endpoint": None,
        "top_nav": False,
    },
    {
        "owners": ("engine.xray",),
        "section": "xray-logs",
        "label": "Логи Xray",
        "class_name": "top-tab-btn xk-top-tab xk-top-tab-logs",
        "view": "xray-logs",
        "element_id": None,
        "href_endpoint": None,
        "top_nav": False,
    },
    {
        "owners": ("tool.terminal",),
        "section": "commands",
        "label": "Команды",
        "class_name": "top-tab-btn xk-top-tab xk-top-tab-commands",
        "view": "commands",
        "element_id": None,
        "href_endpoint": None,
        "top_nav": False,
    },
    {
        "owners": ("tool.files",),
        "section": "files",
        "label": "Файлы",
        "class_name": "top-tab-btn xk-top-tab xk-top-tab-files",
        "view": "files",
        "element_id": "top-tab-files",
        "href_endpoint": None,
        "top_nav": False,
    },
    {
        "owners": ("engine.mihomo",),
        "section": "mihomo-generator",
        "label": "Mihomo Генератор",
        "class_name": "top-tab-btn xk-top-tab xk-top-tab-generator",
        "view": None,
        "element_id": "top-tab-mihomo-generator",
        "href_endpoint": "mihomo_generator_page",
        "top_nav": True,
    },
    {
        "owners": ("core",),
        "section": "donate",
        "label": "Поддержать",
        "class_name": "top-tab-btn xk-top-tab xk-top-tab-donate",
        "view": None,
        "element_id": "top-tab-donate",
        "href_endpoint": None,
        "top_nav": False,
    },
)


def _static_navigation_markup() -> str:
    """Return the Full navigation document for source-only inventories."""

    lines: list[str] = []
    first_view = True
    for item in DYNAMIC_NAVIGATION_ITEMS:
        view = item["view"]
        class_name = str(item["class_name"])
        if view and first_view:
            class_name += " active"
            first_view = False
        attributes = [f'class="{class_name}"']
        if view:
            attributes.append(f'data-view="{view}"')
        else:
            attributes.append('type="button"')
        attributes.append(f'data-xk-section="{item["section"]}"')
        if item["element_id"]:
            attributes.append(f'id="{item["element_id"]}"')
        if item["href_endpoint"]:
            attributes.append(f'data-nav-href="/{item["href_endpoint"]}"')
        if item["top_nav"]:
            attributes.append('data-xk-top-nav="1"')
        lines.extend((f"<button {' '.join(attributes)}>", str(item["label"]), "</button>"))
    return "\n".join(lines)


def compose_panel_template(root: Path) -> str:
    """Return the panel template with local shell includes expanded."""

    root = Path(root).resolve()
    template_root = root / "xkeen-ui/templates"

    def expand(relative_path: str, stack: tuple[str, ...] = ()) -> str:
        if relative_path in stack:
            chain = " -> ".join((*stack, relative_path))
            raise ValueError(f"Recursive panel template include: {chain}")
        path = template_root / relative_path
        source = path.read_text(encoding="utf-8")
        source = _MACRO_IMPORT_RE.sub("", source)

        def replace(match: re.Match[str]) -> str:
            include_path = match.group("path")
            return expand(include_path, (*stack, relative_path))

        source = _INCLUDE_RE.sub(replace, source)

        def replace_dynamic(match: re.Match[str]) -> str:
            return "\n".join(
                expand(include_path, (*stack, relative_path))
                for include_path in DYNAMIC_COMPOSITION_INCLUDE_PATHS[match.group("name")]
            )

        source = _DYNAMIC_INCLUDE_RE.sub(replace_dynamic, source)
        return _DYNAMIC_NAVIGATION_LOOP_RE.sub(_static_navigation_markup(), source)

    return expand("panel.html")
