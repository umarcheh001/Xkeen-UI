"""Soft RSS budget for the long-running Xkeen UI process.

Python releases most objects through reference counting, so a Go-style GC
percentage is not a useful control here.  This guard combines earlier cyclic
GC with pressure-triggered cache eviction and ``malloc_trim`` where libc
supports it.  It deliberately does not impose RLIMIT_AS: a hard virtual-memory
limit is unreliable for Python and can turn a recoverable request into a
process crash.
"""

from __future__ import annotations

import gc
import threading
import time
from typing import Any, Callable, Mapping

from core.paths import UI_STATE_DIR
from services.ui_settings import load_settings


MIB = 1024 * 1024
MEMORY_BUDGET_OPTIONS = frozenset({"auto", "128", "192", "256", "384", "512", "off"})
CHECK_INTERVAL_SECONDS = 15.0
ACTION_COOLDOWN_SECONDS = 60.0
PRESSURE_RATIO = 0.85

_DEFAULT_GC_THRESHOLDS = gc.get_threshold()
_LOW_MEMORY_GC_THRESHOLDS = (350, 7, 7)


def _parse_kib_value(line: str) -> int:
    parts = line.partition(":")[2].strip().split()
    if not parts:
        return 0
    try:
        value = max(0, int(parts[0]))
    except (TypeError, ValueError):
        return 0
    return value * 1024 if len(parts) > 1 and parts[1].lower() == "kb" else value


def read_process_rss_bytes() -> int:
    """Return physical resident memory, never VIRT/address-space size."""

    try:
        with open("/proc/self/status", "r", encoding="utf-8", errors="replace") as stream:
            for line in stream:
                if line.startswith("VmRSS:"):
                    return _parse_kib_value(line)
    except OSError:
        return 0
    return 0


def read_system_memory_bytes() -> tuple[int, int]:
    """Return ``(MemTotal, MemAvailable)`` using procfs only."""

    values: dict[str, int] = {}
    try:
        with open("/proc/meminfo", "r", encoding="utf-8", errors="replace") as stream:
            for line in stream:
                key = line.partition(":")[0]
                if key in {"MemTotal", "MemAvailable", "MemFree", "Buffers", "Cached"}:
                    values[key] = _parse_kib_value(line)
    except OSError:
        return 0, 0

    total = max(0, values.get("MemTotal", 0))
    available = values.get("MemAvailable")
    if available is None:
        available = values.get("MemFree", 0) + values.get("Buffers", 0) + values.get("Cached", 0)
    return total, max(0, min(total, int(available or 0)))


def resolve_memory_budget_bytes(setting: Any, total_bytes: int) -> int | None:
    """Resolve a persisted preset to a soft byte budget."""

    mode = str(setting or "auto").strip().lower()
    if mode not in MEMORY_BUDGET_OPTIONS:
        mode = "auto"
    if mode == "off":
        return None
    if mode != "auto":
        return int(mode) * MIB

    if total_bytes <= 0:
        return 192 * MIB
    auto_mb = int(total_bytes // MIB) // 4
    return max(128, min(256, auto_mb)) * MIB


def _clear_runtime_caches() -> dict[str, int]:
    """Clear reconstructible payload caches without touching active jobs."""

    cleared: dict[str, int] = {}
    try:
        from services.xray_log_api import clear_log_cache

        cleared["xray_logs"] = int(clear_log_cache())
    except Exception:
        pass
    try:
        from services.mihomo_clash_cache import get_shared_mihomo_clash_cache

        cleared["mihomo"] = int(get_shared_mihomo_clash_cache().clear())
    except Exception:
        pass
    try:
        from services.geodat.cache import clear_geodat_cache

        cleared["geodat"] = int(clear_geodat_cache())
    except Exception:
        pass
    try:
        from services.mihomo_egress_info import reset_mihomo_egress_info_cache

        reset_mihomo_egress_info_cache()
        cleared["egress"] = 1
    except Exception:
        pass
    return cleared


def _malloc_trim() -> bool:
    """Ask glibc-compatible allocators to return unused arenas to the OS."""

    try:
        import ctypes

        trim = ctypes.CDLL(None).malloc_trim
        trim.argtypes = [ctypes.c_size_t]
        trim.restype = ctypes.c_int
        return bool(trim(0))
    except (AttributeError, OSError, TypeError, ValueError):
        return False


class MemoryGuard:
    def __init__(
        self,
        *,
        ui_state_dir: str = UI_STATE_DIR,
        interval_seconds: float = CHECK_INTERVAL_SECONDS,
        cooldown_seconds: float = ACTION_COOLDOWN_SECONDS,
        settings_loader: Callable[..., Mapping[str, Any]] = load_settings,
        rss_reader: Callable[[], int] = read_process_rss_bytes,
        memory_reader: Callable[[], tuple[int, int]] = read_system_memory_bytes,
        cache_clearer: Callable[[], Mapping[str, int]] = _clear_runtime_caches,
        collector: Callable[[], int] = gc.collect,
        trimmer: Callable[[], bool] = _malloc_trim,
        threshold_setter: Callable[[int, int, int], None] = gc.set_threshold,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.ui_state_dir = ui_state_dir
        self.interval_seconds = max(1.0, float(interval_seconds))
        self.cooldown_seconds = max(0.0, float(cooldown_seconds))
        self._settings_loader = settings_loader
        self._rss_reader = rss_reader
        self._memory_reader = memory_reader
        self._cache_clearer = cache_clearer
        self._collector = collector
        self._trimmer = trimmer
        self._threshold_setter = threshold_setter
        self._clock = clock
        self._wake = threading.Event()
        self._status_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._last_action_monotonic = float("-inf")
        self._gc_mode: str | None = None
        self._status: dict[str, Any] = {
            "enabled": False,
            "mode": "not_started",
            "budget_bytes": None,
            "rss_bytes": 0,
            "pressure": False,
            "collections": 0,
            "last_action_at": None,
            "last_reclaimed_bytes": 0,
        }

    def _memory_setting(self) -> str:
        try:
            settings = self._settings_loader(ui_state_dir=self.ui_state_dir)
            runtime = settings.get("runtime") if isinstance(settings, Mapping) else None
            raw = runtime.get("memoryBudget") if isinstance(runtime, Mapping) else "auto"
        except Exception:
            raw = "auto"
        mode = str(raw or "auto").strip().lower()
        return mode if mode in MEMORY_BUDGET_OPTIONS else "auto"

    def _apply_gc_mode(self, mode: str) -> None:
        next_mode = "off" if mode == "off" else "managed"
        if next_mode == self._gc_mode:
            return
        thresholds = _DEFAULT_GC_THRESHOLDS if next_mode == "off" else _LOW_MEMORY_GC_THRESHOLDS
        try:
            self._threshold_setter(*thresholds)
            self._gc_mode = next_mode
        except Exception:
            pass

    def check(self) -> dict[str, Any]:
        mode = self._memory_setting()
        total_bytes, available_bytes = self._memory_reader()
        rss_before = max(0, int(self._rss_reader() or 0))
        budget_bytes = resolve_memory_budget_bytes(mode, total_bytes)
        self._apply_gc_mode(mode)

        low_available_threshold = max(32 * MIB, min(64 * MIB, int(total_bytes * 0.10))) if total_bytes else 0
        over_process_budget = bool(budget_bytes and rss_before >= int(budget_bytes * PRESSURE_RATIO))
        low_system_memory = bool(low_available_threshold and available_bytes <= low_available_threshold)
        pressure = budget_bytes is not None and (over_process_budget or low_system_memory)
        now = float(self._clock())

        collected = 0
        trimmed = False
        cleared: Mapping[str, int] = {}
        reclaimed = 0
        rss_current = rss_before
        acted = pressure and now - self._last_action_monotonic >= self.cooldown_seconds
        if acted:
            try:
                cleared = self._cache_clearer()
            except Exception:
                cleared = {}
            try:
                collected = max(0, int(self._collector() or 0))
            except Exception:
                collected = 0
            try:
                trimmed = bool(self._trimmer())
            except Exception:
                trimmed = False
            rss_after = max(0, int(self._rss_reader() or 0))
            rss_current = rss_after
            reclaimed = max(0, rss_before - rss_after)
            self._last_action_monotonic = now
            try:
                from core.logging import core_log

                core_log(
                    "warning",
                    "memory guard reclaimed runtime memory",
                    mode=mode,
                    rss_before=rss_before,
                    rss_after=rss_after,
                    budget_bytes=budget_bytes,
                    available_bytes=available_bytes,
                    collected=collected,
                    trimmed=trimmed,
                    cleared=dict(cleared),
                )
            except Exception:
                pass

        with self._status_lock:
            previous_collections = int(self._status.get("collections") or 0)
            previous_last_action = self._status.get("last_action_at")
            previous_reclaimed = int(self._status.get("last_reclaimed_bytes") or 0)
            self._status = {
                "enabled": budget_bytes is not None,
                "mode": mode,
                "budget_bytes": budget_bytes,
                "rss_bytes": rss_current,
                "system_available_bytes": available_bytes,
                "pressure": pressure,
                "collections": previous_collections + (1 if acted else 0),
                "last_action_at": int(time.time()) if acted else previous_last_action,
                "last_reclaimed_bytes": reclaimed if acted else previous_reclaimed,
                "last_collected_objects": collected if acted else 0,
                "malloc_trimmed": trimmed if acted else False,
                "cleared_caches": dict(cleared) if acted else {},
            }
            return dict(self._status)

    def status(self) -> dict[str, Any]:
        with self._status_lock:
            status = dict(self._status)
        try:
            status["rss_bytes"] = max(0, int(self._rss_reader() or status.get("rss_bytes") or 0))
        except Exception:
            pass
        return status

    def notify(self) -> None:
        self._wake.set()

    def _run(self) -> None:
        while True:
            try:
                self.check()
            except Exception:
                pass
            self._wake.wait(self.interval_seconds)
            self._wake.clear()

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="xkeen-memory-guard", daemon=True)
        self._thread.start()


_guard_lock = threading.Lock()
_guard: MemoryGuard | None = None


def start_memory_guard(*, ui_state_dir: str = UI_STATE_DIR) -> MemoryGuard:
    global _guard
    with _guard_lock:
        if _guard is None:
            _guard = MemoryGuard(ui_state_dir=ui_state_dir)
        _guard.start()
        return _guard


def notify_memory_guard() -> None:
    with _guard_lock:
        guard = _guard
    if guard is not None:
        guard.notify()


def get_memory_guard_status() -> dict[str, Any]:
    with _guard_lock:
        guard = _guard
    if guard is not None:
        return guard.status()
    return {
        "enabled": False,
        "mode": "not_started",
        "budget_bytes": None,
        "rss_bytes": read_process_rss_bytes(),
        "pressure": False,
        "collections": 0,
        "last_action_at": None,
        "last_reclaimed_bytes": 0,
    }


__all__ = [
    "MEMORY_BUDGET_OPTIONS",
    "MemoryGuard",
    "get_memory_guard_status",
    "notify_memory_guard",
    "read_process_rss_bytes",
    "read_system_memory_bytes",
    "resolve_memory_budget_bytes",
    "start_memory_guard",
]
