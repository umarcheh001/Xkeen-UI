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

        return _INCLUDE_RE.sub(replace, source)

    return expand("panel.html")
