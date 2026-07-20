"""Service helpers for restarting the Xray core without restarting xkeen-ui.

The goal is to apply Xray config changes (e.g. loglevel in 01_log.json) while
keeping the web UI and its PTY/WebSocket sessions stable.

Implementation note: we deliberately delegate the actual stop+start to the same
verified service-control path that powers the manual "Restart" button
(:func:`services.xkeen.control_xkeen_action`). That path prefers the init.d
script and *verifies* that the managed core actually came back, falling back to
the CLI form when needed.

An earlier implementation SIGKILLed the ``xray`` process directly and then ran a
bare ``xkeen -start``. On several routers that CLI start silently no-ops (xkeen's
supervisor state is out of sync after an external kill), so the core stayed down
and the user had to press "Restart" manually. Restarting through xkeen only
touches the proxy core — the web UI is a separate service and keeps running.
"""

from __future__ import annotations

import subprocess
import threading
from typing import List, Tuple

from services.xkeen import control_xkeen_action


def _pidof(name: str) -> List[int]:
    """Return list of PIDs for a process name using `pidof` or empty list."""
    try:
        res = subprocess.run(
            ["pidof", name],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        if res.returncode != 0:
            return []
        raw = (res.stdout or "").strip()
        if not raw:
            return []
        pids: List[int] = []
        for part in raw.split():
            try:
                pids.append(int(part))
            except Exception:
                continue
        return pids
    except Exception:
        return []


# Restarts must not overlap: the web UI can issue several enable/disable calls in
# quick succession (e.g. a persisted-state restore racing with an explicit button
# press). Serializing keeps the stop/start windows from stomping on each other.
_RESTART_LOCK = threading.Lock()


def restart_xray_core(
    *,
    start_cmd: List[str] | None = None,  # legacy, accepted for compatibility
    stop_cmd: List[str] | None = None,   # legacy, accepted for compatibility
    timeout_sec: float = 6.0,
    start_if_stopped: bool = False,
) -> Tuple[bool, str]:
    """Restart the Xray core so a config change (loglevel) takes effect.

    Strategy:
      1) If xray is not running and ``start_if_stopped`` is False, bail out with
         "xray not running" (used by "disable logs": a stopped core stays stopped).
      2) Otherwise delegate to :func:`services.xkeen.control_xkeen_action` with a
         proper stop+start (init.d preferred, CLI fallback) and verify the core
         is running again afterwards.

    ``start_if_stopped`` is meant for "enable logs": the user asked for a running
    core with the new loglevel, so a stopped xray should be brought up.

    Calls are serialized via a module-level lock.

    Returns:
        (ok, detail)
    """
    with _RESTART_LOCK:
        running = bool(_pidof("xray"))

        if not running and not start_if_stopped:
            return False, "xray not running"

        # Give the core enough time to come back; mirror the manual restart button.
        settle = max(8.0, float(timeout_sec or 0))
        ok = control_xkeen_action(
            "restart",
            prefer_init=True,
            settle_timeout=settle,
        )
        # control_xkeen_action manages both supported cores and can report success while
        # Mihomo (rather than Xray) is the process that came back. Log controls are Xray-
        # specific, so verify the requested core explicitly before confirming Start.
        if ok and _pidof("xray"):
            return True, ("restarted" if running else "started")
        return False, "xray did not start"
