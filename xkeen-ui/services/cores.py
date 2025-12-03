"""Helpers for detecting and switching xkeen cores (xray / mihomo)."""

import os
import subprocess
from typing import List, Optional, Tuple


def detect_available_cores() -> List[str]:
    """Return list of available cores based on presence of binaries."""
    cores: List[str] = []
    if os.path.exists("/opt/sbin/xray"):
        cores.append("xray")
    if os.path.exists("/opt/sbin/mihomo"):
        cores.append("mihomo")
    return cores


def detect_running_core() -> Optional[str]:
    """Try to detect currently running core via `pidof`."""
    try:
        for core_name in ("xray", "mihomo"):
            try:
                res = subprocess.run(
                    ["pidof", core_name],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                )
                if res.returncode == 0:
                    return core_name
            except FileNotFoundError:
                continue
    except Exception:
        return None
    return None


def get_cores_status() -> Tuple[List[str], Optional[str]]:
    """Return (available_cores, current_core) for xkeen.

    current_core is based on running process if possible, falling back to first available.
    """
    cores = detect_available_cores()
    running_core = detect_running_core()

    current_core: Optional[str] = running_core
    if current_core is None:
        if "xray" in cores:
            current_core = "xray"
        elif "mihomo" in cores:
            current_core = "mihomo"

    return cores, current_core


def switch_core(core: str, error_log_path: str) -> None:
    """Switch xkeen core to `core` ('xray' or 'mihomo') and restart service.

    This replicates behaviour of the previous api_xkeen_core_set implementation:
    - determine current core;
    - when switching xray -> mihomo, clear error log;
    - run `xkeen -mihomo` or `xkeen -xray`;
    - run `xkeen -start`;
    - write subprocess output into error log where possible.

    Raises:
        ValueError: if requested core is invalid.
        RuntimeError: if switching or restart failed.
    """
    core = (core or "").strip()
    if core not in ("xray", "mihomo"):
        raise ValueError("Недопустимое ядро")

    # Determine current core (for xray -> mihomo log reset behaviour)
    current_core = detect_running_core()

    log_file = error_log_path

    # If switching from xray to mihomo - clear log file, as in original Go UI
    if current_core == "xray" and core == "mihomo" and log_file:
        try:
            with open(log_file, "w"):
                pass
        except Exception:
            # Non-critical: ignore failure to clear log
            pass

    # Open log file handle for xkeen commands
    log_handle = None
    try:
        if log_file:
            try:
                log_handle = open(log_file, "a")
            except Exception:
                # Fallback to /dev/null if log file cannot be opened
                try:
                    log_handle = open(os.devnull, "a")
                except Exception:
                    log_handle = None

        def run_cmd(cmd):
            if log_handle is not None:
                return subprocess.run(cmd, stdout=log_handle, stderr=log_handle, check=True)
            return subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

        try:
            if core == "mihomo":
                run_cmd(["xkeen", "-mihomo"])
            else:
                run_cmd(["xkeen", "-xray"])

            run_cmd(["xkeen", "-start"])
        except Exception as exc:
            # Make sure to close handle before raising
            if log_handle is not None:
                try:
                    log_handle.close()
                except Exception:
                    pass
            raise RuntimeError("Ошибка смены или запуска ядра") from exc
    finally:
        if log_handle is not None:
            try:
                log_handle.close()
            except Exception:
                pass
