"""Service-level helpers for xkeen (restart, logs, etc.)."""

from __future__ import annotations

import os
import time
import subprocess
from typing import Iterable, List, Sequence

from services.xkeen_commands_catalog import build_xkeen_cmd, resolve_xkeen_init_script


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


def is_xkeen_running() -> bool:
    """Return True when xkeen-managed core process is currently running."""
    for core_name in ("xray", "mihomo"):
        try:
            res = subprocess.run(
                ["pidof", core_name],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            continue
        except Exception:
            continue
        if res.returncode == 0:
            return True
    return False


def build_xkeen_control_cmds(
    action: str,
    *,
    primary_cmd: Sequence[str] | None = None,
    prefer_init: bool = True,
) -> list[list[str]]:
    """Build a list of candidate service-control commands.

    After the frontend/service-control refactor some routers reported that the
    plain ``xkeen -start`` / ``xkeen -restart`` CLI command returned without
    actually bringing the managed core back up. The init.d script remains the
    most reliable compatibility path, so manual controls now try both forms.
    """

    normalized = str(action or "").strip().lower()
    if normalized not in {"start", "stop", "restart", "status"}:
        return []

    seen: set[tuple[str, ...]] = set()
    commands: list[list[str]] = []

    def _push(cmd: Iterable[str] | None) -> None:
        if not cmd:
            return
        parts = [str(part or "").strip() for part in cmd]
        parts = [part for part in parts if part]
        if not parts:
            return
        key = tuple(parts)
        if key in seen:
            return
        seen.add(key)
        commands.append(parts)

    script = resolve_xkeen_init_script()
    init_cmd = [script, normalized] if script else None
    cli_cmd = build_xkeen_cmd(f"-{normalized}")

    if primary_cmd:
        _push(primary_cmd)

    if prefer_init:
        _push(init_cmd)
        _push(cli_cmd)
    else:
        _push(cli_cmd)
        _push(init_cmd)

    return commands


def _dispatch_xkeen_control_command(
    cmd: Sequence[str],
    *,
    dispatch_timeout: float,
) -> bool:
    try:
        proc = subprocess.Popen(
            list(cmd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
    except Exception:
        return False

    try:
        rc = proc.wait(timeout=max(0.1, float(dispatch_timeout or 0)))
        return rc == 0
    except subprocess.TimeoutExpired:
        return True
    except Exception:
        return False


def _wait_xkeen_running(expected_running: bool, *, timeout: float, poll_interval: float = 0.25) -> bool:
    deadline = time.monotonic() + max(0.2, float(timeout or 0))
    last_state = is_xkeen_running()
    if last_state == expected_running:
        return True

    while time.monotonic() < deadline:
        time.sleep(max(0.05, float(poll_interval or 0.25)))
        last_state = is_xkeen_running()
        if last_state == expected_running:
            return True

    return last_state == expected_running


def control_xkeen_action(
    action: str,
    *,
    primary_cmd: Sequence[str] | None = None,
    prefer_init: bool = True,
    dispatch_timeout: float = 1.5,
    settle_timeout: float = 8.0,
) -> bool:
    """Execute xkeen service-control action with runtime verification.

    The command is considered successful only when the observed runtime state
    matches the requested action. If the first command silently no-ops, we try
    the next compatibility candidate.
    """

    normalized = str(action or "").strip().lower()
    if normalized not in {"start", "stop", "restart"}:
        return False

    expected_running = normalized != "stop"
    if normalized == "start" and is_xkeen_running():
        return True
    if normalized == "stop" and not is_xkeen_running():
        return True

    settle = max(2.0, float(settle_timeout or 0))
    for cmd in build_xkeen_control_cmds(
        normalized,
        primary_cmd=primary_cmd,
        prefer_init=prefer_init,
    ):
        if not _dispatch_xkeen_control_command(cmd, dispatch_timeout=dispatch_timeout):
            continue
        if _wait_xkeen_running(expected_running, timeout=settle):
            return True

    return False


def restart_xkeen(
    restart_cmd,
    log_file: str,
    source: str = "api",
    dispatch_timeout: float = 1.5,
) -> bool:
    """Restart xkeen and log the result.

    ``restart_cmd`` is used as the primary candidate, but we also fall back to
    the init.d/CLI compatibility candidates when the primary command exits yet
    the managed core never comes back.
    """
    ok = control_xkeen_action(
        "restart",
        primary_cmd=restart_cmd,
        prefer_init=True,
        dispatch_timeout=dispatch_timeout,
        settle_timeout=8.0,
    )
    append_restart_log(log_file, ok, source=source)
    return ok
