"""DevTools service facade.

Historically DevTools lived in a single module: `services/devtools.py`.
During refactor it became a package (`services/devtools/`), but **imports must
stay compatible**:

    from services import devtools as dt

Routes and other services expect the same symbols to be available on `dt.*`.
This `__init__` keeps the surface area stable by re-exporting the public API
from smaller submodules.

This PR is *polishing only* (no behavioral changes).
"""

from __future__ import annotations

from typing import Any, Dict

# ---------------------------------------------------------------------------
# ENV editor
# ---------------------------------------------------------------------------

from .env import (  # noqa: F401
    ENV_WHITELIST,
    ENV_READONLY,
    EnvItem,
    _env_file_path,
    read_env_file,
    write_env_file,
    get_env_items,
    set_env,
)

# ---------------------------------------------------------------------------
# Logs
# ---------------------------------------------------------------------------

from .logs import (  # noqa: F401
    list_logs,
    tail_log,
    truncate_log,
    _resolve_log_path,
    _b64e,
    _b64d,
    _encode_cursor,
    _decode_cursor,
)

# ---------------------------------------------------------------------------
# UI service control
# ---------------------------------------------------------------------------

from .ui_service import ui_status, ui_action  # noqa: F401

# ---------------------------------------------------------------------------
# Themes
# ---------------------------------------------------------------------------

# NOTE: global theme carries a large default config; use lazy wrappers so the
# facade import stays cheap unless DevTools theme endpoints are actually used.


def theme_get(ui_state_dir: str) -> Dict[str, Any]:
    from .theme_global import theme_get as _impl

    return _impl(ui_state_dir)


def theme_set(ui_state_dir: str, cfg_in: Any) -> Dict[str, Any]:
    from .theme_global import theme_set as _impl

    return _impl(ui_state_dir, cfg_in)


def theme_reset(ui_state_dir: str) -> Dict[str, Any]:
    from .theme_global import theme_reset as _impl

    return _impl(ui_state_dir)


from .theme_terminal import (  # noqa: F401,E402
    terminal_theme_get,
    terminal_theme_set,
    terminal_theme_reset,
)

from .theme_codemirror import (  # noqa: F401,E402
    codemirror_theme_get,
    codemirror_theme_set,
    codemirror_theme_reset,
)

# ---------------------------------------------------------------------------
# Custom CSS
# ---------------------------------------------------------------------------

from .custom_css import (  # noqa: F401,E402
    custom_css_get,
    custom_css_set,
    custom_css_disable,
    custom_css_reset,
)


# ---------------------------------------------------------------------------
# Public contract
# ---------------------------------------------------------------------------

__all__ = [
    "ENV_WHITELIST",
    "ENV_READONLY",
    "EnvItem",
    "read_env_file",
    "write_env_file",
    "get_env_items",
    "set_env",
    "_env_file_path",
    "list_logs",
    "tail_log",
    "truncate_log",
    "_resolve_log_path",
    "_b64e",
    "_b64d",
    "_encode_cursor",
    "_decode_cursor",
    "ui_status",
    "ui_action",
    "theme_get",
    "theme_set",
    "theme_reset",
    "terminal_theme_get",
    "terminal_theme_set",
    "terminal_theme_reset",
    "codemirror_theme_get",
    "codemirror_theme_set",
    "codemirror_theme_reset",
    "custom_css_get",
    "custom_css_set",
    "custom_css_disable",
    "custom_css_reset",
]
