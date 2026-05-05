"""Service-level helpers for xkeen (restart, logs, etc.)."""

from __future__ import annotations

import time
import subprocess
from typing import Iterable, List, Sequence

from services.restart_log import append_restart_log as _append_restart_log
from services.restart_log import append_restart_log_text as _append_restart_log_text
from services.restart_log import read_restart_log as _read_restart_log
from services.xkeen_commands_catalog import build_xkeen_cmd, resolve_xkeen_init_script


def append_restart_log(log_file: str, ok: bool, source: str = "api", **meta: object) -> None:
    """Append a single line about restart result to the restart log."""
    return _append_restart_log(log_file, ok, source=source, **meta)


def append_restart_log_text(log_file: str, raw_text: str) -> None:
    """Append raw runtime output to the restart log."""
    return _append_restart_log_text(log_file, raw_text)


def read_restart_log(log_file: str, limit: int = 100) -> List[str]:
    """Read last ``limit`` lines from restart log file, if it exists."""
    return _read_restart_log(log_file, limit=limit)


def detect_xkeen_runtime_core() -> str:
    """Return the currently running xkeen-managed core name, if detected."""
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
            return core_name
    return ""


def is_xkeen_running() -> bool:
    """Return True when xkeen-managed core process is currently running."""
    return bool(detect_xkeen_runtime_core())


def get_xkeen_runtime_status() -> dict[str, object]:
    """Return compact runtime status fields for restart-log metadata."""
    core = detect_xkeen_runtime_core()
    running = bool(core)
    return {
        "runtime_status": "running" if running else "stopped",
        "runtime_core": core or "none",
    }


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
    started_at = time.monotonic()
    ok = control_xkeen_action(
        "restart",
        primary_cmd=restart_cmd,
        prefer_init=True,
        dispatch_timeout=dispatch_timeout,
        settle_timeout=8.0,
    )
    duration_ms = max(0, int(round((time.monotonic() - started_at) * 1000)))
    append_restart_log(log_file, ok, source=source, duration_ms=duration_ms, **get_xkeen_runtime_status())
    return ok
