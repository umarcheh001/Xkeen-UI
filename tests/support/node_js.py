"""How the tests run the panel's JS modules in node.

The Xray sources reach the core by the name `xk-core/<path under static>`,
which a browser resolves through the importmap. Node learns the same name from
the resolve hook in tests/js/xk_core_hooks.mjs.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
XK_CORE_HOOKS = ROOT / "tests" / "js" / "xk_core_hooks.mjs"

# A module script read from stdin, or from `-e` placed after it.
NODE_MODULE_COMMAND: tuple[str, ...] = ("node", "--import", XK_CORE_HOOKS.as_uri(), "--input-type=module")
