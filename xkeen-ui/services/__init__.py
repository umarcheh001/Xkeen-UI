"""Services facade.

The `services/` package has many modules. As the codebase grows, direct deep
imports like:

    from services.x.y import z

can become fragile and may contribute to circular dependencies.

This module provides a small, stable public surface for the most common
service entry points.

Design rules
- Keep this module lightweight: use lazy imports inside functions.
- Export only a handful of commonly used helpers.
- Avoid importing heavy modules at import time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional


def get_build_info(ui_state_dir: Optional[str] = None) -> Dict[str, Any]:
    """Return current build info for DevTools.

    Lazy wrapper around :func:`services.build_info.read_build_info`.
    """

    from .build_info import read_build_info

    return read_build_info(ui_state_dir)


def get_capabilities(
    env: Optional[Dict[str, str]] = None,
    *,
    which: Callable[[str], Optional[str]] = __import__("shutil").which,
) -> Dict[str, Any]:
    """Detect backend capabilities (payload for /api/capabilities)."""

    from .capabilities import detect_capabilities

    return detect_capabilities(env or {}, which=which)


def get_remotefs_state(
    env: Optional[Dict[str, str]] = None,
    *,
    which: Callable[[str], Optional[str]] = __import__("shutil").which,
) -> Dict[str, Any]:
    """Detect RemoteFS backend availability (internal details).

    This is not part of the public API contract but is used for conditional
    blueprint registration.
    """

    from .capabilities import detect_remotefs_state

    return detect_remotefs_state(env or {}, which=which)


@dataclass(frozen=True)
class UISettingsStore:
    """Small wrapper for UI settings persistence."""

    ui_state_dir: str

    def load(self) -> Dict[str, Any]:
        from .ui_settings import load_settings

        return load_settings(self.ui_state_dir)

    def save(self, cfg_in: Any) -> Dict[str, Any]:
        from .ui_settings import save_settings

        return save_settings(cfg_in, self.ui_state_dir)

    def patch(self, patch: Any):
        from .ui_settings import patch_settings

        return patch_settings(patch, self.ui_state_dir)


_UI_SETTINGS_STORE: Optional[UISettingsStore] = None


def get_ui_settings_store(ui_state_dir: Optional[str] = None) -> UISettingsStore:
    """Return (cached) UI settings store bound to UI_STATE_DIR."""

    global _UI_SETTINGS_STORE
    if ui_state_dir is None:
        from core.paths import UI_STATE_DIR as _UI_STATE_DIR

        ui_state_dir = _UI_STATE_DIR

    if _UI_SETTINGS_STORE is None or _UI_SETTINGS_STORE.ui_state_dir != str(ui_state_dir):
        _UI_SETTINGS_STORE = UISettingsStore(ui_state_dir=str(ui_state_dir))
    return _UI_SETTINGS_STORE


__all__ = [
    "get_build_info",
    "get_capabilities",
    "get_remotefs_state",
    "UISettingsStore",
    "get_ui_settings_store",
]
