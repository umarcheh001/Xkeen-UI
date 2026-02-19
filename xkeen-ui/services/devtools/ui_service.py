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


UI_INIT_SCRIPT = os.environ.get("XKEEN_UI_INIT_SCRIPT", "/opt/etc/init.d/S99xkeen-ui")
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


def ui_status() -> Dict[str, Any]:
    # In dev mode UI is often managed externally (IDE run, docker, etc.)
    if _runtime_mode() != "router" and not (os.path.isfile(UI_INIT_SCRIPT) and os.access(UI_INIT_SCRIPT, os.X_OK)):
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

    # Prefer init script when present.
    if os.path.isfile(UI_INIT_SCRIPT) and os.access(UI_INIT_SCRIPT, os.X_OK):
        # For stop/restart we run in background to increase chances that HTTP response is sent.
        if action in ("stop", "restart"):
            try:
                subprocess.Popen([UI_INIT_SCRIPT, action], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception as e:
                return {"ok": False, "action": action, "error": str(e)}
            return {"ok": True, "action": action, "scheduled": True, "mode": "initd"}

        try:
            subprocess.check_call([UI_INIT_SCRIPT, action], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"ok": True, "action": action, "mode": "initd"}
        except Exception as e:
            return {"ok": False, "action": action, "error": str(e), "mode": "initd"}

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
