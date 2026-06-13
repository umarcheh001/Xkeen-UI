"""DevTools UI service control helpers.

These functions are used by DevTools endpoints to query and control the UI service
(start/stop/restart) when running on a router via an init.d script, and to
provide a safe "external" status in dev/desktop environments.
"""

from __future__ import annotations

import os
import sys
import subprocess
from typing import Any, Dict


UI_INIT_SCRIPT_DEFAULT = "/opt/etc/init.d/S99xkeen-ui-umarcheh001"
UI_INIT_SCRIPT_LEGACY = "/opt/etc/init.d/S99xkeen-ui"
UI_INIT_OWNER_MARKER = 'XKEEN_UI_INIT_OWNER="umarcheh001/Xkeen-UI"'
UI_PID_FILE = os.environ.get("XKEEN_UI_PID_FILE", "/opt/var/run/xkeen-ui.pid")
# Optional: custom command to control UI in dev (e.g. launchctl/systemd). Supports "{action}" placeholder.
UI_CONTROL_CMD = os.environ.get("XKEEN_UI_CONTROL_CMD") or os.environ.get("XKEEN_UI_RESTART_CMD")


def _runtime_mode() -> str:
    rt_env = (os.environ.get("XKEEN_RUNTIME") or os.environ.get("XKEEN_ENV") or "").strip().lower()
    if rt_env in ("router", "dev", "desktop", "mac"):
        return "router" if rt_env == "router" else "dev"
    if sys.platform == "darwin":
        return "dev"
    # Router markers (best-effort)
    try:
        has_ndm = os.path.exists("/proc/ndm") or os.path.exists("/opt/etc/ndm")
    except Exception:
        has_ndm = False
    try:
        has_opkg = os.path.exists("/opt/bin/opkg")
    except Exception:
        has_opkg = False
    return "router" if (has_ndm or has_opkg) else "dev"


def _is_executable_file(path: str) -> bool:
    try:
        return bool(path) and os.path.isfile(path) and os.access(path, os.X_OK)
    except Exception:
        return False


def _is_our_ui_init_script(path: str) -> bool:
    try:
        if not path or not os.path.isfile(path):
            return False
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
        if UI_INIT_OWNER_MARKER in content:
            return True
        if 'UI_DIR="/opt/etc/xkeen-ui"' not in content:
            return False
        return 'RUN_SERVER="$UI_DIR/run_server.py"' in content or 'APP_PY="$UI_DIR/app.py"' in content
    except Exception:
        return False


def _resolve_ui_init_script() -> str | None:
    override = str(os.environ.get("XKEEN_UI_INIT_SCRIPT", "") or "").strip()
    if override and _is_executable_file(override):
        return override

    for cand in (UI_INIT_SCRIPT_DEFAULT, UI_INIT_SCRIPT_LEGACY):
        if _is_executable_file(cand) and _is_our_ui_init_script(cand):
            return cand
    return None


def ui_status() -> Dict[str, Any]:
    ui_init_script = _resolve_ui_init_script()
    # In dev mode UI is often managed externally (IDE run, docker, etc.)
    if _runtime_mode() != "router" and not ui_init_script:
        return {"running": None, "pid": None, "managed": "external"}

    pid = None
    running = False
    try:
        if os.path.isfile(UI_PID_FILE):
            with open(UI_PID_FILE, "r", encoding="utf-8", errors="ignore") as f:
                s = (f.read() or "").strip()
            if s.isdigit():
                pid = int(s)
                try:
                    os.kill(pid, 0)
                    running = True
                except Exception:
                    running = False
    except Exception:
        pass
    return {"running": running, "pid": pid}


def ui_action(action: str) -> Dict[str, Any]:
    action = (action or "").strip().lower()
    if action not in ("start", "stop", "restart", "status"):
        raise ValueError("bad_action")

    if action == "status":
        st = ui_status()
        return {"ok": True, "action": action, **st}

    ui_init_script = _resolve_ui_init_script()

    # Prefer our dedicated init script when present.
    if ui_init_script:
        # For stop/restart we run in background to increase chances that HTTP response is sent.
        if action in ("stop", "restart"):
            try:
                subprocess.Popen([ui_init_script, action], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception as e:
                return {"ok": False, "action": action, "error": str(e)}
            return {"ok": True, "action": action, "scheduled": True, "mode": "initd", "script": ui_init_script}

        try:
            subprocess.check_call([ui_init_script, action], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"ok": True, "action": action, "mode": "initd", "script": ui_init_script}
        except Exception as e:
            return {"ok": False, "action": action, "error": str(e), "mode": "initd", "script": ui_init_script}

    # Dev/desktop: allow custom control command if provided.
    if UI_CONTROL_CMD:
        try:
            cmd = str(UI_CONTROL_CMD)
            if "{action}" in cmd:
                cmd = cmd.replace("{action}", action)
            elif action != "restart":
                # Without placeholder we only support restart to avoid surprises.
                return {"ok": False, "action": action, "error": "control_cmd_restart_only"}
            subprocess.Popen(cmd if isinstance(cmd, str) else str(cmd), shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"ok": True, "action": action, "scheduled": True, "mode": "cmd"}
        except Exception as e:
            return {"ok": False, "action": action, "error": str(e), "mode": "cmd"}

    # No supported mechanism in this environment.
    if _runtime_mode() != "router":
        return {"ok": False, "action": action, "error": "managed_externally"}
    return {"ok": False, "action": action, "error": "init_script_missing"}
