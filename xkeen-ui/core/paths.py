"""Core path resolution helpers for Xkeen UI.

PR1: moved from app.py so that app.py stays thin.
"""

from __future__ import annotations

import os
import sys


def get_ui_state_dir() -> str:
    """Return a writable directory for UI state (auth, secret key, logs).

    Router default: /opt/etc/xkeen-ui
    Dev/macOS fallback: XDG/~/Library/Application Support/xkeen-ui (or ~/.config/xkeen-ui)

    Override with env:
    - XKEEN_UI_STATE_DIR (preferred)
    - XKEEN_UI_DIR (legacy)
    """
    env_dir = os.environ.get("XKEEN_UI_STATE_DIR") or os.environ.get("XKEEN_UI_DIR")
    if env_dir:
        return env_dir

    default_dir = "/opt/etc/xkeen-ui"
    # Try router default first, but never fail hard if it's not writable (e.g., on macOS dev).
    try:
        os.makedirs(default_dir, exist_ok=True)
        test_path = os.path.join(default_dir, ".writetest")
        with open(test_path, "w", encoding="utf-8") as f:
            f.write("")
        os.remove(test_path)
        return default_dir
    except Exception:
        pass

    home = os.path.expanduser("~")
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        fallback = os.path.join(xdg, "xkeen-ui")
    elif sys.platform == "darwin":
        fallback = os.path.join(home, "Library", "Application Support", "xkeen-ui")
    else:
        fallback = os.path.join(home, ".config", "xkeen-ui")

    try:
        os.makedirs(fallback, exist_ok=True)
    except Exception:
        # Last resort: current working directory
        fallback = os.path.abspath("./xkeen-ui-state")
        os.makedirs(fallback, exist_ok=True)
    return fallback


def choose_base_dir(default_dir: str, fallback_dir: str) -> str:
    """Choose ``default_dir`` if it is writable, otherwise use ``fallback_dir``.

    This is used to make the UI runnable on macOS/dev where /opt is missing or not writable.
    """
    try:
        os.makedirs(default_dir, exist_ok=True)
        test_path = os.path.join(default_dir, ".writetest")
        with open(test_path, "w", encoding="utf-8") as f:
            f.write("")
        os.remove(test_path)
        return default_dir
    except Exception:
        os.makedirs(fallback_dir, exist_ok=True)
        return fallback_dir


# Effective state directory for UI runtime.
UI_STATE_DIR = get_ui_state_dir()

# Effective base dirs for reading/writing configs and logs.
BASE_ETC_DIR = choose_base_dir("/opt/etc", os.path.join(UI_STATE_DIR, "etc"))
BASE_VAR_DIR = choose_base_dir("/opt/var", os.path.join(UI_STATE_DIR, "var"))
