"""Service-level helpers for xkeen (restart, logs, etc.)."""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from typing import Iterable, List, Sequence

from services.restart_log import append_restart_log as _append_restart_log
from services.restart_log import append_restart_log_text as _append_restart_log_text
from services.restart_log import read_restart_log as _read_restart_log
from services.xkeen_commands_catalog import build_xkeen_cmd, resolve_xkeen_init_script


DEFAULT_RESTART_SETTLE_TIMEOUT = 60.0
RESTART_SETTLE_TIMEOUT_ENV = "XKEEN_RESTART_SETTLE_TIMEOUT"


@dataclass(frozen=True)
class _DispatchResult:
    """Whether a control command started and whether its process finished."""

    launched: bool
    completed: bool
    returncode: int | None = None


@dataclass(frozen=True)
class _ControlResult:
    ok: bool
    in_flight: bool = False


def get_xkeen_restart_settle_timeout() -> float:
    """Return the bounded wait used to verify a slow router restart."""

    try:
        value = float(os.environ.get(RESTART_SETTLE_TIMEOUT_ENV, DEFAULT_RESTART_SETTLE_TIMEOUT))
    except (TypeError, ValueError):
        value = DEFAULT_RESTART_SETTLE_TIMEOUT
    return min(300.0, max(2.0, value))


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
        if _process_ids(core_name):
            return core_name
    return ""


def _process_ids(name: str) -> tuple[int, ...]:
    """Return process ids using the router's pidof or macOS pgrep."""
    for command in (("pidof", name), ("pgrep", "-x", name)):
        try:
            result = subprocess.run(
                list(command),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=1.0,
            )
        except FileNotFoundError:
            continue
        except Exception:
            continue
        if result.returncode == 0:
            return tuple(sorted({int(item) for item in str(result.stdout or "").split() if item.isdigit()}))
    return ()


def is_xkeen_running() -> bool:
    """Return True when xkeen-managed core process is currently running."""
    return bool(detect_xkeen_runtime_core())


def _xkeen_runtime_identity() -> tuple[str, tuple[int, ...]]:
    """Return a process identity that changes after a real core restart."""
    core = detect_xkeen_runtime_core()
    if not core:
        return "", ()
    try:
        pids = _process_ids(core)
    except Exception:
        pids = ()
    return core, pids


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
) -> _DispatchResult:
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
        return _DispatchResult(False, True, None)

    try:
        rc = proc.wait(timeout=max(0.1, float(dispatch_timeout or 0)))
        return _DispatchResult(True, True, int(rc))
    except subprocess.TimeoutExpired:
        # The command was accepted but is still running.  Do not dispatch a
        # compatibility fallback while it can still complete the same action.
        return _DispatchResult(True, False, None)
    except Exception:
        # A started process with an unknown wait result is still in flight.
        return _DispatchResult(True, False, None)


def _normalize_dispatch_result(result: object) -> _DispatchResult:
    """Keep test/integration monkeypatches returning the old bool contract working."""

    if isinstance(result, _DispatchResult):
        return result
    if result is True:
        return _DispatchResult(True, True, 0)
    return _DispatchResult(False, True, None)


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


def _wait_xkeen_restarted(
    previous: tuple[str, tuple[int, ...]],
    *,
    timeout: float,
    poll_interval: float = 0.25,
    stable_for: float = 1.0,
) -> bool:
    """Wait for a new running core process, not merely an already-running one.

    New means lasting: XKeen may bring the core up, take it down and bring it
    up again while it starts, and a process seen once in between is gone by the
    time anyone asks about it.  Reporting on that one logged a successful
    restart with the core "stopped".
    """
    deadline = time.monotonic() + max(0.2, float(timeout or 0))
    saw_stopped = not bool(previous[0])
    candidate: tuple[str, tuple[int, ...]] | None = None
    candidate_since = 0.0
    while time.monotonic() < deadline:
        current = _xkeen_runtime_identity()
        if not current[0] or not current[1]:
            # A name without process ids is the old core dying between the two
            # pidof calls, not a new one.
            saw_stopped = True
            candidate = None
        elif saw_stopped or current != previous:
            now = time.monotonic()
            if current != candidate:
                candidate = current
                candidate_since = now
            elif now - candidate_since >= stable_for:
                return True
        time.sleep(max(0.05, float(poll_interval or 0.25)))
    return False


def _control_xkeen_action_result(
    action: str,
    *,
    primary_cmd: Sequence[str] | None = None,
    prefer_init: bool = True,
    dispatch_timeout: float = 1.5,
    settle_timeout: float = DEFAULT_RESTART_SETTLE_TIMEOUT,
) -> _ControlResult:
    """Execute xkeen service-control action with runtime verification.

    The command is considered successful only when the observed runtime state
    matches the requested action. If the first command silently no-ops, we try
    the next compatibility candidate.
    """

    normalized = str(action or "").strip().lower()
    if normalized not in {"start", "stop", "restart"}:
        return _ControlResult(False)

    expected_running = normalized != "stop"
    if normalized == "start" and is_xkeen_running():
        return _ControlResult(True)
    if normalized == "stop" and not is_xkeen_running():
        return _ControlResult(True)

    previous_identity = _xkeen_runtime_identity() if normalized == "restart" else ("", ())
    settle = max(2.0, float(settle_timeout or 0))
    for cmd in build_xkeen_control_cmds(
        normalized,
        primary_cmd=primary_cmd,
        prefer_init=prefer_init,
    ):
        dispatch = _normalize_dispatch_result(
            _dispatch_xkeen_control_command(cmd, dispatch_timeout=dispatch_timeout)
        )
        if not dispatch.launched:
            continue
        if dispatch.completed and dispatch.returncode not in (None, 0):
            # A command that finished with an error is eligible for the next
            # compatibility candidate; it cannot still be changing runtime.
            continue
        if normalized == "restart":
            if _wait_xkeen_restarted(previous_identity, timeout=settle):
                return _ControlResult(True)
        elif normalized == "start":
            if _wait_xkeen_restarted(("", ()), timeout=settle):
                return _ControlResult(True)
        elif _wait_xkeen_running(expected_running, timeout=settle):
            return _ControlResult(True)

        # A timed-out child may still be performing the restart.  Returning
        # here prevents the next compatibility candidate from starting a
        # second restart on top of it.
        if not dispatch.completed:
            return _ControlResult(False, in_flight=True)

    return _ControlResult(False)


def _normalize_control_result(result: object) -> _ControlResult:
    """Keep integrations that monkeypatch the historical bool return working."""

    if isinstance(result, _ControlResult):
        return result
    return _ControlResult(bool(result))


def control_xkeen_action(
    action: str,
    *,
    primary_cmd: Sequence[str] | None = None,
    prefer_init: bool = True,
    dispatch_timeout: float = 1.5,
    settle_timeout: float = DEFAULT_RESTART_SETTLE_TIMEOUT,
    return_details: bool = False,
) -> bool | _ControlResult:
    """Execute xkeen service-control action and return its verified status."""

    from flask import current_app, has_app_context
    control = current_app.extensions.get('xkeen.runtime_control') if has_app_context() else None
    result = _ControlResult(False)

    def execute() -> bool:
        nonlocal result
        result = _control_xkeen_action_result(
            action, primary_cmd=primary_cmd, prefer_init=prefer_init,
            dispatch_timeout=dispatch_timeout, settle_timeout=settle_timeout,
        )
        return result.ok

    # Engine hooks keep the bool contract; callers still need the in-flight flag.
    ok = control(action, execute) if control is not None else execute()
    return _ControlResult(bool(ok), result.in_flight) if return_details else bool(ok)


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
    control_result = _normalize_control_result(control_xkeen_action(
        "restart",
        primary_cmd=restart_cmd,
        prefer_init=True,
        dispatch_timeout=dispatch_timeout,
        settle_timeout=get_xkeen_restart_settle_timeout(),
        return_details=True,
    ))
    ok = control_result.ok
    recovered = False
    recovery_attempted = False
    try:
        runtime_before_recovery = get_xkeen_runtime_status()
    except Exception:
        runtime_before_recovery = {}
    if (
        not ok
        and not control_result.in_flight
        and runtime_before_recovery.get("runtime_status") == "stopped"
    ):
        # Some router builds return from restart after stopping the core. Give
        # the supervisor's normal start path one chance before reporting a
        # failed restart to callers.
        recovery_attempted = True
        recovered = control_xkeen_action(
            "start",
            prefer_init=True,
            dispatch_timeout=dispatch_timeout,
            settle_timeout=get_xkeen_restart_settle_timeout(),
        )
        ok = recovered
    try:
        from services.mihomo_clash_cache import invalidate_shared_mihomo_cache

        invalidate_shared_mihomo_cache(
            namespaces={"status", "groups", "providers", "rules", "yaml", "dns"}
        )
    except Exception:
        # Restart/cache coordination is best-effort and must not alter the
        # historical restart result contract.
        pass
    duration_ms = max(0, int(round((time.monotonic() - started_at) * 1000)))
    try:
        runtime_status = get_xkeen_runtime_status()
    except Exception:
        runtime_status = {"runtime_status": "unknown", "runtime_core": "none"}
    append_restart_log(
        log_file,
        ok,
        source=source,
        duration_ms=duration_ms,
        **({"recovery_attempted": True, "recovered": bool(recovered)} if recovery_attempted else {}),
        **runtime_status,
    )
    return ok
