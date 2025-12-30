"""Service helpers for restarting Xray core without restarting xkeen-ui.

The main goal is to apply Xray config changes (e.g. loglevel in 01_log.json)
while keeping the web UI and its PTY/WebSocket sessions stable.

We intentionally *do not* call `xkeen -restart` here, because on some setups
it restarts the whole stack (including the UI).
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from typing import List, Tuple

try:
    import shutil
except Exception:  # pragma: no cover
    shutil = None  # type: ignore


def _which(cmd: str) -> str | None:
    try:
        if shutil is not None and hasattr(shutil, "which"):
            return shutil.which(cmd)  # type: ignore[arg-type]
    except Exception:
        pass
    # Minimal fallback: check common locations
    for p in (f"/opt/bin/{cmd}", f"/opt/sbin/{cmd}", f"/usr/bin/{cmd}", f"/bin/{cmd}"):
        try:
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return p
        except Exception:
            continue
    return None


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


def _kill_pids(pids: List[int], sig: int) -> None:
    for pid in pids:
        try:
            os.kill(pid, sig)
        except Exception:
            pass


def restart_xray_core(
    *,
    start_cmd: List[str] | None = None,
    stop_cmd: List[str] | None = None,
    timeout_sec: float = 6.0,
) -> Tuple[bool, str]:
    """Restart only the Xray process.

    Strategy:
      1) If xray is not running, return (False, "not running").
      2) Terminate xray (SIGTERM, then SIGKILL if needed).
      3) Start it back via `xkeen -start` (preferred) or provided start_cmd.
      4) Wait until pidof(xray) succeeds.

    Returns:
        (ok, detail)
    """
    pids = _pidof("xray")
    if not pids:
        return False, "xray not running"

    # Stop: prefer explicit stop_cmd (if provided), otherwise kill the xray PIDs.
    if stop_cmd:
        try:
            subprocess.check_call(stop_cmd)
        except Exception:
            # Fall back to kill.
            _kill_pids(pids, signal.SIGTERM)
    else:
        _kill_pids(pids, signal.SIGTERM)

    # Wait for exit
    deadline = time.time() + max(1.0, float(timeout_sec) * 0.5)
    while time.time() < deadline:
        if not _pidof("xray"):
            break
        time.sleep(0.15)

    # Force kill if still alive
    still = _pidof("xray")
    if still:
        _kill_pids(still, signal.SIGKILL)
        time.sleep(0.2)

    # Start: default to xkeen -start if available
    cmd = start_cmd
    if not cmd:
        if _which("xkeen"):
            cmd = ["xkeen", "-start"]

    if not cmd:
        # Last-resort: try to start xray directly with confdir.
        # This may fail if the environment expects XRAY_LOCATION_* to be set.
        return False, "no start command available"

    try:
        subprocess.check_call(cmd)
    except Exception as e:
        return False, f"start failed: {e}"

    # Wait for xray to appear again
    deadline = time.time() + max(2.0, float(timeout_sec))
    while time.time() < deadline:
        if _pidof("xray"):
            return True, "restarted"
        time.sleep(0.2)

    return False, "xray did not start"
