"""UI settings storage (persisted in UI_STATE_DIR).

This module provides a small, safe infrastructure for storing UI preferences
(server-side) without changing existing UI behavior yet.

Intended usage (next commits):
- GET /api/ui-settings -> load_settings()
- PATCH /api/ui-settings -> patch_settings()

Storage file:
  UI_STATE_DIR/ui-settings.json

Defaults are kept minimal and backward-compatible.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict

from core.paths import UI_STATE_DIR
from services.io.atomic import _atomic_write_json
from utils.deep_merge import deep_merge


DEFAULTS: Dict[str, Any] = {
    "editor": {
        # Supported engines (today): 'codemirror'. Future: 'monaco'.
        "engine": "codemirror",
    },
    "format": {
        # Prefer browser-side formatting (Prettier) where available.
        # Default OFF to preserve current behavior.
        "preferPrettier": False,
        # Prettier formatting options (optional)
        "tabWidth": 2,
        "printWidth": 80,
    },
    "logs": {
        # Render ANSI colors in UI (future feature flag).
        "ansi": False,
        # Use new WS2 protocol endpoint when available.
        # Default OFF to preserve current behavior.
        "ws2": False,
        # Xray logs view preferences (migrated from localStorage in Commit 14).
        # Keep empty by default so we can detect "unset" state and seed from legacy
        # client storage on first use.
        "view": {},
    },
}


def _settings_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, "ui-settings.json")


def load_settings(ui_state_dir: str = UI_STATE_DIR) -> Dict[str, Any]:
    """Load UI settings from disk and merge with defaults.

    Returns defaults if file is missing/corrupted.
    """
    path = _settings_path(ui_state_dir)
    raw: Any = {}

    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                raw = json.load(f)
    except Exception:
        raw = {}

    if not isinstance(raw, dict):
        raw = {}

    merged = deep_merge(DEFAULTS, raw)
    # Ensure we always return a dict.
    return merged if isinstance(merged, dict) else dict(DEFAULTS)


def save_settings(cfg_in: Any, ui_state_dir: str = UI_STATE_DIR) -> Dict[str, Any]:
    """Save the given config (merged with defaults) to disk.

    Returns the effective saved config.
    """
    if not isinstance(cfg_in, dict):
        cfg_in = {}
    cfg = deep_merge(DEFAULTS, cfg_in)
    if not isinstance(cfg, dict):
        cfg = dict(DEFAULTS)

    path = _settings_path(ui_state_dir)
    _atomic_write_json(path, cfg, mode=0o644, ensure_ascii=False, indent=2)
    return cfg


def patch_settings(patch: Any, ui_state_dir: str = UI_STATE_DIR) -> Dict[str, Any]:
    """Apply a partial update (deep-merge) and save to disk.

    This is the helper that will be used by PATCH /api/ui-settings.
    """
    current = load_settings(ui_state_dir)
    if not isinstance(patch, dict):
        patch = {}
    merged = deep_merge(current, patch)
    return save_settings(merged, ui_state_dir)
