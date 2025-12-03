"""Service-level helpers for xkeen (restart, logs, etc.)."""

import os
import time
import subprocess
from typing import List


def append_restart_log(log_file: str, ok: bool, source: str = "api") -> None:
    """Append a single line about restart result to the restart log."""
    line = "[{ts}] source={src} result={res}\n".format(
        ts=time.strftime("%Y-%m-%d %H:%M:%S"),
        src=source,
        res="OK" if ok else "FAIL",
    )
    log_dir = os.path.dirname(log_file)
    if log_dir and not os.path.isdir(log_dir):
        os.makedirs(log_dir, exist_ok=True)
    try:
        with open(log_file, "a") as f:
            f.write(line)
    except Exception:
        # Logging errors are non-critical
        pass


def read_restart_log(log_file: str, limit: int = 100) -> List[str]:
    """Read last ``limit`` lines from restart log file, if it exists."""
    if not os.path.isfile(log_file):
        return []
    try:
        with open(log_file, "r") as f:
            lines = f.readlines()
        return lines[-limit:]
    except Exception:
        return []


def restart_xkeen(restart_cmd, log_file: str, source: str = "api") -> bool:
    """Restart xkeen using given restart_cmd and log the result.

    ``restart_cmd`` is typically a list, e.g. XKEEN_RESTART_CMD.
    """
    try:
        subprocess.check_call(restart_cmd)
        append_restart_log(log_file, True, source=source)
        return True
    except Exception:
        append_restart_log(log_file, False, source=source)
        return False
