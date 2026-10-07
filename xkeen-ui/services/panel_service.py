"""Control of the panel's own service: the init script that starts and stops it.

This is not the XKeen service. ``xkeen -restart`` restarts the proxy and
leaves the panel process untouched; anything that has to reload the panel's
own code — a module operation, a panel update, a profile transition — needs
the command built here.
"""

from __future__ import annotations

import os
import subprocess
from typing import List, Optional


PANEL_INIT_SCRIPT_DEFAULT = "/opt/etc/init.d/S99xkeen-ui-umarcheh001"
PANEL_INIT_SCRIPT_LEGACY = "/opt/etc/init.d/S99xkeen-ui"
PANEL_INIT_OWNER_MARKER = 'XKEEN_UI_INIT_OWNER="umarcheh001/Xkeen-UI"'


def _is_executable_file(path: str) -> bool:
    try:
        return bool(path) and os.path.isfile(path) and os.access(path, os.X_OK)
    except Exception:
        return False


def is_panel_init_script(path: str) -> bool:
    """Whether the script belongs to this panel and not to another one under the same name."""

    try:
        if not path or not os.path.isfile(path):
            return False
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            content = handle.read()
        if PANEL_INIT_OWNER_MARKER in content:
            return True
        if 'UI_DIR="/opt/etc/xkeen-ui"' not in content:
            return False
        return 'RUN_SERVER="$UI_DIR/run_server.py"' in content or 'APP_PY="$UI_DIR/app.py"' in content
    except Exception:
        return False


def resolve_panel_init_script() -> Optional[str]:
    override = str(os.environ.get("XKEEN_UI_INIT_SCRIPT", "") or "").strip()
    if override and _is_executable_file(override):
        return override

    for candidate in (PANEL_INIT_SCRIPT_DEFAULT, PANEL_INIT_SCRIPT_LEGACY):
        if _is_executable_file(candidate) and is_panel_init_script(candidate):
            return candidate
    return None


def panel_restart_command() -> List[str]:
    """The command that restarts the panel; empty where nothing manages it."""

    script = resolve_panel_init_script()
    return [script, "restart"] if script else []


def restart_panel(source: str = "api") -> bool:
    """Ask the service script to restart the panel; ``False`` when it cannot be asked.

    The script kills the process that serves the request, so it is started
    apart from it and not waited for: the answer has to leave first.
    """

    command = panel_restart_command()
    if not command:
        return False
    options: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        options["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    try:
        subprocess.Popen(command, **options)
    except OSError:
        return False
    return True
