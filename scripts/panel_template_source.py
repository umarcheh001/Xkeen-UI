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
    r"""\{%-?\s*include\s+(?P<name>header_badge_partial|header_summary_partial|header_action_partial|control_partial|screen_partial|modal_partial)\s*-?%\}"""
)


# Dynamic composition loops are intentionally limited to these server-owned
# paths. Static inventories expand every Full/Legacy branch without evaluating
# arbitrary Jinja expressions or accepting template names from runtime input.
DYNAMIC_COMPOSITION_INCLUDE_PATHS: dict[str, tuple[str, ...]] = {
    "header_badge_partial": ("panel/slots/xray_badge.html",),
    "header_summary_partial": ("panel/slots/diagnostics_summary.html",),
    "header_action_partial": ("panel/slots/diagnostics_actions.html",),
    "control_partial": ("panel/slots/routing_focus.html",),
    "screen_partial": (
        "panel/screens/routing.html",
        "panel/screens/mihomo.html",
        "panel/screens/xkeen.html",
        "panel/screens/commands.html",
        "panel/screens/files.html",
        "panel/screens/xray_logs.html",
    ),
    "modal_partial": (
        "panel/modals/diagnostics.html",
        "panel/modals/routing.html",
        "panel/modals/commands.html",
        "panel/modals/shared.html",
        "panel/modals/mihomo.html",
        "panel/modals/happ.html",
        "panel/modals/files.html",
        "panel/modals/files_editor.html",
        "panel/modals/editor.html",
    ),
}


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

        return _DYNAMIC_INCLUDE_RE.sub(replace_dynamic, source)

    return expand("panel.html")
