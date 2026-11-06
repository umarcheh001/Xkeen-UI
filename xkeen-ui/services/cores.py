"""Helpers for detecting and switching xkeen cores (xray / mihomo).

Diagnostics patch (2026-02)
--------------------------
The core switch endpoint is a frequent source of "UI hangs" because it executes
external commands and may trigger service restarts.

This module now adds:
- per-command timing logs (to core logger when available);
- subprocess timeouts (configurable via env);
- structured error details for the API layer.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

from services.io.atomic import _atomic_write_json
from services.xray_assets import ensure_xray_dat_assets
from services.xkeen_commands_catalog import build_xkeen_cmd


# --- core logger (never required) ---
try:
    from services.logging_setup import core_logger as _get_core_logger

    _CORE_LOGGER = _get_core_logger()
except Exception:  # noqa: BLE001
    _CORE_LOGGER = None


def _core_log(level: str, msg: str, **extra) -> None:
    if _CORE_LOGGER is None:
        return
    try:
        if extra:
            tail = ", ".join(f"{k}={v}" for k, v in extra.items())
            full = f"{msg} | {tail}"
        else:
            full = msg
        fn = getattr(_CORE_LOGGER, str(level or "info").lower(), None)
        if callable(fn):
            fn(full)
        else:
            _CORE_LOGGER.info(full)
    except Exception:
        return


def _coerce_subprocess_output(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="replace")
        except Exception:
            return value.decode(errors="replace")
    return str(value)


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if v is None:
        return default
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _truncate(s: str, limit: int = 800) -> str:
    s = s or ""
    if len(s) <= limit:
        return s
    return s[:limit] + "…"


def _is_restart_log_service_line(line: str) -> bool:
    lower = str(line or "").lower()
    return "прокси-клиент" in lower or "proxy-client" in lower


def _is_restart_log_error_line(line: str) -> bool:
    lower = str(line or "").lower()
    return any(
        token in lower
        for token in (
            "error",
            "failed",
            "failure",
            "fatal",
            "panic",
            "timeout",
            "ошиб",
            "не удалось",
        )
    )


def _select_restart_log_output(phase: str, output: object, *, ok: bool, core: str = "") -> str:
    phase = str(phase or "").strip().lower()
    if ok and phase in {"switch_core", "xray_test", "start"}:
        return ""

    text = _coerce_subprocess_output(output).replace("\r\n", "\n").replace("\r", "\n")
    if not text:
        return ""

    lines = [line.rstrip() for line in text.split("\n") if line.strip()]
    if not lines:
        return ""

    selected = [line for line in lines if _is_restart_log_service_line(line) or _is_restart_log_error_line(line)]
    if not selected:
        selected = lines[-24:]
    if len(selected) > 40:
        selected = selected[:20] + ["..."] + selected[-19:]
    return "\n".join(selected) + "\n"


class CoreSwitchError(RuntimeError):
    """Raised when core switching fails.

    Carries best-effort diagnostic details.
    """

    def __init__(self, message: str, *, details: Optional[Dict[str, object]] = None):
        super().__init__(message)
        self.details: Dict[str, object] = details or {}


def detect_available_cores() -> List[str]:
    """Return cores whose configured or system binary is executable."""

    def _available(configured: object, names: tuple[str, ...]) -> bool:
        for candidate in (str(configured or "").strip(), *names):
            if not candidate:
                continue
            if os.path.isabs(candidate):
                if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                    return True
            elif shutil.which(candidate):
                return True
        return False

    cores: List[str] = []
    if _available(os.environ.get("XKEEN_XRAY_BINARY"), ("/opt/sbin/xray", "/opt/bin/xray", "xray")):
        cores.append("xray")
    if _available(os.environ.get("MIHOMO_BIN"), ("/opt/sbin/mihomo", "/opt/bin/mihomo", "mihomo")):
        cores.append("mihomo")
    return cores


def _process_ids(name: str) -> tuple[int, ...]:
    """Return process ids using ``pidof`` or macOS/BSD ``pgrep``."""

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
        if result.returncode != 0:
            continue
        ids = tuple(sorted({int(item) for item in str(result.stdout or "").split() if item.isdigit()}))
        if ids:
            return ids
    return ()


def detect_running_cores() -> Tuple[str, ...]:
    """Return all core processes currently reported by ``pidof``.

    During a restart both engines can briefly coexist. That state must not be
    collapsed to the first name in a fixed ``xray, mihomo`` order: doing so
    makes the UI announce Xray while Mihomo is the engine XKeen is bringing up.
    """
    return tuple(core_name for core_name in ("xray", "mihomo") if _process_ids(core_name))


@dataclass(frozen=True)
class CoreRuntime:
    """The engines ``pidof`` saw, kept whole.

    Two names at once is a hand-off in progress -- or a Mihomo launched
    outside XKeen next to its Xray.  No single name answers every caller for
    that, so each asks its own question: "is X up?" is ``has``, "is nothing
    running?" is ``idle`` and "which engine owns the service?" is ``owner``,
    unknown while both run.
    """

    running: Tuple[str, ...] = ()

    def has(self, core: str) -> bool:
        return core in self.running

    @property
    def idle(self) -> bool:
        return not self.running

    @property
    def switching(self) -> bool:
        return len(self.running) > 1

    @property
    def owner(self) -> Optional[str]:
        return self.running[0] if len(self.running) == 1 else None


def core_runtime() -> CoreRuntime:
    """Snapshot of the running engines; the one entry point for callers."""
    return CoreRuntime(detect_running_cores())


_XKEEN_STATUS_CORE_RE = re.compile(
    r"(?:прокси[-\s]*клиент|proxy(?:\s+client)?)\s+"
    r"(?P<core>xray|mihomo)\s+"
    r"(?:запущен|running)",
    re.IGNORECASE,
)
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def _xkeen_status_running_core() -> Optional[str]:
    """Ask XKeen which engine owns the currently running proxy service.

    This is intentionally a narrow tie-breaker, used only when ``pidof``
    reports *both* engines.  A lingering process during a core hand-off must
    not make the UI choose Xray merely because it appears first in a fixed
    probe order.
    """

    try:
        result = subprocess.run(
            build_xkeen_cmd("-status"),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=3.0,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return None
    output = _ANSI_ESCAPE_RE.sub("", str(result.stdout or ""))
    match = _XKEEN_STATUS_CORE_RE.search(output)
    return match.group("core").lower() if match else None


def resolve_running_core_for_status(running_cores: Tuple[str, ...] | None = None) -> Optional[str]:
    """Resolve a status-facing core name without guessing during a hand-off."""

    detected = tuple(running_cores) if running_cores is not None else detect_running_cores()
    if len(detected) == 1:
        return detected[0]
    if len(detected) > 1:
        reported = _xkeen_status_running_core()
        if reported in detected:
            return reported
    return None


def settled_core_owner(
    probe: Callable[[], CoreRuntime] | None = None,
) -> Tuple[CoreRuntime, Optional[str]]:
    """Return the engine owning the service for a one-off action.

    A switch leaves the old engine alive for a few seconds: wait that out
    (``XKEEN_CORE_SETTLE_TIMEOUT_MS``, 3 s) and, if both still run, ask XKeen
    itself.  ``None`` together with ``runtime.switching`` means nobody can
    tell -- the caller refuses instead of guessing.  ``probe`` is the
    caller's own ``core_runtime``, so its tests stand in for ``pidof``.
    """

    probe = probe or core_runtime
    runtime = probe()
    deadline = time.monotonic() + max(0, _env_int("XKEEN_CORE_SETTLE_TIMEOUT_MS", 3000)) / 1000.0
    while runtime.switching and time.monotonic() < deadline:
        time.sleep(0.25)
        runtime = probe()
    return runtime, resolve_running_core_for_status(runtime.running)


# The engine the panel last saw running. A stopped or crashed service has no
# process to ask, and xkeen keeps its choice inside its own scripts; the
# window of the core tells what ran before the stop from this record.
LAST_CORE_FILENAME = "xkeen-last-core.json"
_KNOWN_CORES = ("xray", "mihomo")


def _last_core_path() -> str:
    from core.paths import UI_STATE_DIR

    return os.path.join(UI_STATE_DIR, LAST_CORE_FILENAME)


def read_last_core() -> Optional[str]:
    """Return the engine last seen running, or None when the panel never saw one."""
    try:
        with open(_last_core_path(), "r", encoding="utf-8") as handle:
            core = json.load(handle).get("core")
    except Exception:
        return None
    return core if core in _KNOWN_CORES else None


def remember_running_core(core: Optional[str]) -> None:
    """Record a running engine; the file is written only when it changes."""
    if core not in _KNOWN_CORES or read_last_core() == core:
        return
    try:
        _atomic_write_json(_last_core_path(), {"schema_version": 1, "core": core})
    except Exception as exc:  # noqa: BLE001 - a hint must never break the status
        _core_log("warning", "xkeen.last_core_write_failed", error=str(exc))


def get_cores_status(runtime: CoreRuntime | None = None) -> Tuple[List[str], Optional[str]]:
    """Return (available_cores, current_core) for xkeen.

    ``current_core`` is based on a running process.  If process detection is
    temporarily inconclusive (for example while xkeen is restarting), return
    ``None`` instead of claiming the first installed engine is active.  The
    old fallback made an active Mihomo router briefly look like Xray and hid
    the confirmation action in the core switch modal.
    """
    cores = detect_available_cores()
    running = (runtime or core_runtime()).running
    running_core = resolve_running_core_for_status(running)
    remember_running_core(running_core)
    return cores, running_core


def switch_core(core: str, error_log_path: str, runtime_log: Callable[[str], None] | None = None) -> None:
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
    current_core = core_runtime().owner

    log_file = error_log_path

    # If switching from xray to mihomo - clear log file, as in original Go UI
    if current_core == "xray" and core == "mihomo" and log_file:
        try:
            with open(log_file, "w"):
                pass
        except Exception:
            # Non-critical: ignore failure to clear log
            pass

    # Timeouts (seconds). Keep conservative defaults; can be tuned via env.
    timeout_switch = max(5, _env_int("XKEEN_CORE_SWITCH_TIMEOUT", 25))
    timeout_start = max(5, _env_int("XKEEN_CORE_START_TIMEOUT", 20))

    # Open log file handle for xkeen commands
    log_handle = None
    try:
        if log_file:
            try:
                log_handle = open(log_file, "a", encoding="utf-8", errors="replace")
            except Exception:
                # Fallback to /dev/null if log file cannot be opened
                try:
                    log_handle = open(os.devnull, "a")
                except Exception:
                    log_handle = None

        def _write_runtime_log(text: object) -> None:
            if not callable(runtime_log):
                return
            raw = _coerce_subprocess_output(text)
            if not raw:
                return
            try:
                runtime_log(raw if raw.endswith("\n") else raw + "\n")
            except Exception:
                return

        def _write_diag(line: str) -> None:
            if log_handle is None:
                return
            try:
                log_handle.write(line.rstrip("\n") + "\n")
                log_handle.flush()
            except Exception:
                pass

        def _write_command_output(output: object, *, phase: str, ok: bool) -> None:
            text = _coerce_subprocess_output(output)
            runtime_text = _select_restart_log_output(phase, text, ok=ok, core=core)
            if not text and not runtime_text:
                return
            if text and log_handle is not None:
                try:
                    log_handle.write(text)
                    if not text.endswith("\n"):
                        log_handle.write("\n")
                    log_handle.flush()
                except Exception:
                    pass
            _write_runtime_log(runtime_text)

        def run_cmd(cmd, *, phase: str, timeout: int) -> None:
            cmd_s = " ".join(str(x) for x in cmd)
            _core_log("info", "xkeen.cmd_start", phase=phase, cmd=cmd_s, timeout=timeout)
            _write_diag(f"[xkeen-ui] {phase}: start cmd={cmd_s} timeout={timeout}s")
            t0 = time.monotonic()
            try:
                completed = subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    check=True,
                    timeout=timeout,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
                _write_command_output(getattr(completed, "stdout", ""), phase=phase, ok=True)
            except subprocess.TimeoutExpired as exc:
                dt = round(time.monotonic() - t0, 3)
                _write_command_output(getattr(exc, "output", ""), phase=phase, ok=False)
                _core_log("error", "xkeen.cmd_timeout", phase=phase, cmd=cmd_s, elapsed_s=dt)
                _write_diag(f"[xkeen-ui] {phase}: TIMEOUT after {dt}s cmd={cmd_s}")
                raise CoreSwitchError(
                    "Таймаут выполнения команды",
                    details={
                        "phase": phase,
                        "cmd": cmd_s,
                        "timeout_s": timeout,
                        "elapsed_s": dt,
                        "log": log_file,
                    },
                ) from exc
            except subprocess.CalledProcessError as exc:
                dt = round(time.monotonic() - t0, 3)
                _write_command_output(getattr(exc, "output", ""), phase=phase, ok=False)
                _core_log("error", "xkeen.cmd_failed", phase=phase, cmd=cmd_s, rc=getattr(exc, "returncode", None), elapsed_s=dt)
                _write_diag(
                    f"[xkeen-ui] {phase}: FAILED rc={getattr(exc,'returncode',None)} after {dt}s cmd={cmd_s}"
                )
                raise CoreSwitchError(
                    "Команда завершилась с ошибкой",
                    details={
                        "phase": phase,
                        "cmd": cmd_s,
                        "returncode": getattr(exc, "returncode", None),
                        "elapsed_s": dt,
                        "log": log_file,
                    },
                ) from exc
            except Exception as exc:
                dt = round(time.monotonic() - t0, 3)
                _core_log("error", "xkeen.cmd_exception", phase=phase, cmd=cmd_s, elapsed_s=dt, error=str(exc))
                _write_diag(f"[xkeen-ui] {phase}: EXCEPTION after {dt}s cmd={cmd_s} err={exc}")
                raise CoreSwitchError(
                    "Ошибка выполнения команды",
                    details={
                        "phase": phase,
                        "cmd": cmd_s,
                        "elapsed_s": dt,
                        "log": log_file,
                        "error": str(exc),
                    },
                ) from exc
            dt = round(time.monotonic() - t0, 3)
            _core_log("info", "xkeen.cmd_ok", phase=phase, cmd=cmd_s, elapsed_s=dt)
            _write_diag(f"[xkeen-ui] {phase}: ok elapsed={dt}s cmd={cmd_s}")

        def _stop_process(proc: subprocess.Popen) -> None:
            try:
                if proc.poll() is not None:
                    return
                proc.terminate()
                proc.wait(timeout=1.0)
            except Exception:
                try:
                    if proc.poll() is None:
                        proc.kill()
                except Exception:
                    pass

        def run_start_cmd(cmd, *, timeout: int) -> None:
            cmd_s = " ".join(str(x) for x in cmd)
            phase = "start"
            _core_log("info", "xkeen.cmd_start", phase=phase, cmd=cmd_s, timeout=timeout)
            _write_diag(f"[xkeen-ui] {phase}: start cmd={cmd_s} timeout={timeout}s")
            t0 = time.monotonic()
            rc = None
            started = False

            with tempfile.TemporaryFile() as output_file:
                try:
                    proc = subprocess.Popen(
                        cmd,
                        stdin=subprocess.DEVNULL,
                        stdout=output_file,
                        stderr=subprocess.STDOUT,
                    )
                except Exception as exc:
                    dt = round(time.monotonic() - t0, 3)
                    _core_log("error", "xkeen.cmd_exception", phase=phase, cmd=cmd_s, elapsed_s=dt, error=str(exc))
                    _write_diag(f"[xkeen-ui] {phase}: EXCEPTION after {dt}s cmd={cmd_s} err={exc}")
                    raise CoreSwitchError(
                        "Ошибка выполнения команды",
                        details={"phase": phase, "cmd": cmd_s, "elapsed_s": dt, "log": log_file, "error": str(exc)},
                    ) from exc

                deadline = time.monotonic() + max(1, int(timeout))
                while True:
                    rc = proc.poll()
                    # The engine being left may linger for a moment; the new
                    # one showing up is what "started" means here.
                    if core_runtime().has(core):
                        started = True
                        grace_s = max(0.0, _env_int("XKEEN_CORE_START_GRACE_AFTER_RUNNING_MS", 1500) / 1000.0)
                        grace_deadline = time.monotonic() + grace_s
                        while proc.poll() is None and time.monotonic() < grace_deadline:
                            time.sleep(0.1)
                        break
                    if rc is not None and rc != 0:
                        break
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.25)

                if proc.poll() is None:
                    _stop_process(proc)
                rc = proc.poll()

                try:
                    output_file.seek(0)
                    output = output_file.read()
                except Exception:
                    output = b""

            dt = round(time.monotonic() - t0, 3)
            if started:
                _write_command_output(output, phase=phase, ok=True)
                _core_log("info", "xkeen.cmd_ok", phase=phase, cmd=cmd_s, elapsed_s=dt, runtime_core=core)
                _write_diag(f"[xkeen-ui] {phase}: ok elapsed={dt}s cmd={cmd_s}")
                return

            _write_command_output(output, phase=phase, ok=False)
            if rc is None:
                _core_log("error", "xkeen.cmd_timeout", phase=phase, cmd=cmd_s, elapsed_s=dt)
                _write_diag(f"[xkeen-ui] {phase}: TIMEOUT after {dt}s cmd={cmd_s}")
                raise CoreSwitchError(
                    "Таймаут выполнения команды",
                    details={"phase": phase, "cmd": cmd_s, "timeout_s": timeout, "elapsed_s": dt, "log": log_file},
                )

            if rc == 0:
                _core_log("error", "xkeen.cmd_not_ready", phase=phase, cmd=cmd_s, rc=rc, elapsed_s=dt)
                _write_diag(f"[xkeen-ui] {phase}: NOT_READY rc={rc} after {dt}s cmd={cmd_s}")
            else:
                _core_log("error", "xkeen.cmd_failed", phase=phase, cmd=cmd_s, rc=rc, elapsed_s=dt)
                _write_diag(f"[xkeen-ui] {phase}: FAILED rc={rc} after {dt}s cmd={cmd_s}")
            raise CoreSwitchError(
                "Команда завершилась с ошибкой",
                details={"phase": phase, "cmd": cmd_s, "returncode": rc, "elapsed_s": dt, "log": log_file},
            )

        # ---- run switching sequence ----
        try:
            if core == "mihomo":
                run_cmd(["xkeen", "-mihomo"], phase="switch_core", timeout=timeout_switch)
            else:
                run_cmd(["xkeen", "-xray"], phase="switch_core", timeout=timeout_switch)
            # Xray configs often reference DAT assets via `ext:<name>.dat:<list>`.
            # Many embedded builds resolve these assets next to the binary
            # (e.g. /opt/sbin/geosite_v2fly.dat). Ensure all DAT files managed by
            # the UI under /opt/etc/xray/dat are symlinked into /opt/sbin.
            if core == "xray":
                try:
                    dat_dir = os.environ.get("XRAY_DAT_DIR") or "/opt/etc/xray/dat"
                    asset_dir = os.environ.get("XRAY_ASSET_DIR") or "/opt/sbin"
                    ensure_xray_dat_assets(
                        dat_dir=dat_dir,
                        asset_dir=asset_dir,
                        diag=_write_diag,
                        log=lambda line: _core_log("info", line),
                    )
                except Exception as e:  # noqa: BLE001
                    # Best-effort only; do not block switching.
                    _core_log("warning", "xray_assets_failed", error=str(e))
            # Preflight check for Xray configs: fail fast with actionable error
            if core == "xray":
                try:
                    xray_bin = "/opt/sbin/xray" if os.path.exists("/opt/sbin/xray") else "xray"
                    confdir = os.environ.get("XRAY_CONFDIR") or "/opt/etc/xray/configs"
                    _default_test_timeout = 30
                    test_timeout = max(5, _env_int("XKEEN_XRAY_TEST_TIMEOUT", _default_test_timeout))
                    cmd = [xray_bin, "-test", "-confdir", confdir]
                    cmd_s = " ".join(str(x) for x in cmd)
                    _core_log("info", "xkeen.cmd_start", phase="xray_test", cmd=cmd_s, timeout=test_timeout)
                    _write_diag(f"[xkeen-ui] xray_test: start cmd={cmd_s} timeout={test_timeout}s")
                    t0t = time.monotonic()
                    completed = subprocess.run(
                        cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        check=True,
                        timeout=test_timeout,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                    )
                    _write_command_output(getattr(completed, "stdout", ""), phase="xray_test", ok=True)
                    dtt = round(time.monotonic() - t0t, 3)
                    _core_log("info", "xkeen.cmd_ok", phase="xray_test", cmd=cmd_s, elapsed_s=dtt)
                    _write_diag(f"[xkeen-ui] xray_test: ok elapsed={dtt}s cmd={cmd_s}")
                except FileNotFoundError:
                    # xray binary not found - skip preflight
                    pass
                except subprocess.TimeoutExpired as exc:
                    dtt = round(time.monotonic() - t0t, 3) if 't0t' in locals() else None
                    _write_command_output(getattr(exc, "output", ""), phase="xray_test", ok=False)
                    _core_log("error", "xkeen.cmd_timeout", phase="xray_test", cmd=cmd_s if 'cmd_s' in locals() else 'xray -test', elapsed_s=dtt)
                    _write_diag(f"[xkeen-ui] xray_test: TIMEOUT after {dtt}s cmd={cmd_s}")
                    raise CoreSwitchError(
                        "Таймаут проверки конфигурации Xray",
                        details={
                            "phase": "xray_test",
                            "cmd": cmd_s if 'cmd_s' in locals() else 'xray -test',
                            "timeout_s": test_timeout,
                            "elapsed_s": dtt,
                            "log": log_file,
                        },
                    ) from exc
                except subprocess.CalledProcessError as exc:
                    dtt = round(time.monotonic() - t0t, 3) if 't0t' in locals() else None
                    _write_command_output(getattr(exc, "output", ""), phase="xray_test", ok=False)
                    _core_log("error", "xkeen.cmd_failed", phase="xray_test", cmd=cmd_s if 'cmd_s' in locals() else 'xray -test', rc=getattr(exc, 'returncode', None), elapsed_s=dtt)
                    _write_diag(f"[xkeen-ui] xray_test: FAILED rc={getattr(exc,'returncode',None)} after {dtt}s cmd={cmd_s}")
                    raise CoreSwitchError(
                        "Ошибка конфигурации Xray",
                        details={
                            "phase": "xray_test",
                            "cmd": cmd_s if 'cmd_s' in locals() else 'xray -test',
                            "returncode": getattr(exc, 'returncode', None),
                            "elapsed_s": dtt,
                            "log": log_file,
                            "hint": "Проверь /opt/var/log/xray/error.log. Частые причины: 1) отсутствует GeoSite/GeoIP список в DAT; 2) Xray не видит нужный *.dat в assets (должен быть доступен по имени в /opt/sbin или через симлинки из /opt/etc/xray/dat).",
                        },
                    ) from exc

            run_start_cmd(build_xkeen_cmd("-start"), timeout=timeout_start)
            remember_running_core(core)
        except CoreSwitchError:
            raise
        except Exception as exc:
            raise CoreSwitchError(
                "Ошибка смены или запуска ядра",
                details={"phase": "unknown", "log": log_file, "error": str(exc)},
            ) from exc
    finally:
        if log_handle is not None:
            try:
                log_handle.close()
            except Exception:
                pass
