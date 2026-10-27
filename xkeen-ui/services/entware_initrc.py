"""Check the firmware's Entware shutdown script, without changing custom paths."""

from __future__ import annotations

import re
from threading import RLock

from utils.firmware import run_ndmc

_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_LOCK = RLock()
_cache: dict | None = None


def _failed(run) -> bool:
    output = _ANSI.sub("", run.output).lower()
    return run.rc != 0 or any(marker in output for marker in ("% error", "error:", "command::base error"))


def clear_initrc_cache() -> None:
    global _cache
    with _LOCK:
        _cache = None


def initrc_status() -> dict:
    global _cache
    with _LOCK:
        if _cache is not None:
            return dict(_cache)
        result = {"state": "unknown", "path": None}
        try:
            run = run_ndmc("show running-config", timeout=10)
            if not _failed(run):
                clean = _ANSI.sub("", run.stdout or "")
                initrc = re.search(r"^\s*opkg[ \t]+initrc[ \t]+([^\r\n]+)", clean, re.MULTILINE)
                disk = re.search(r"^\s*opkg[ \t]+disk[ \t]+\S+", clean, re.MULTILINE)
                if initrc and initrc.group(1).strip():
                    result = {"state": "ok", "path": initrc.group(1).strip()}
                elif disk:
                    result = {"state": "missing", "path": None}
        except Exception:  # optional firmware probe must not break diagnostics
            pass
        _cache = result
        return dict(result)


class InitrcError(RuntimeError):
    def __init__(self, message: str, *, code: str, details: str = ""):
        super().__init__(message)
        self.code = code
        self.details = details


def _command(command: str, message: str) -> None:
    try:
        run = run_ndmc(command, timeout=15)
    except Exception as exc:
        raise InitrcError(message, code="initrc_command_failed", details=str(exc)) from exc
    if _failed(run):
        raise InitrcError(message, code="initrc_command_failed", details=_ANSI.sub("", run.output))


def apply_initrc() -> dict:
    with _LOCK:
        clear_initrc_cache()
        try:
            status = initrc_status()
            if status["state"] == "unknown":
                raise InitrcError("Не удалось проверить настройку Entware.", code="initrc_unavailable")
            if status["state"] == "missing":
                _command("opkg initrc /opt/etc/init.d/rc.unslung", "Не удалось прописать сценарий остановки служб.")
            # Also save on retry: a previous command may have applied the path
            # successfully while saving the persistent configuration failed.
            _command("system configuration save", "Не удалось сохранить настройку Entware.")
            clear_initrc_cache()
            status = initrc_status()
            if status["state"] != "ok":
                raise InitrcError("Настройка сценария остановки служб не подтверждена.", code="initrc_not_applied")
            return status
        except Exception:
            clear_initrc_cache()
            raise
