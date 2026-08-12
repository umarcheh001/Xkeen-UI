"""Small in-process concurrency/rate guard for Mihomo runtime actions."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from types import MappingProxyType
from typing import Callable, Mapping


@dataclass(frozen=True)
class MihomoClashActionPolicy:
    max_global_concurrent: int
    max_subject_concurrent: int
    max_calls_per_window: int
    window_seconds: float


MIHOMO_CLASH_ACTION_POLICIES: Mapping[str, MihomoClashActionPolicy] = MappingProxyType(
    {
        "proxy-select": MihomoClashActionPolicy(4, 1, 30, 60.0),
        "runtime-mode": MihomoClashActionPolicy(1, 1, 12, 60.0),
        "proxy-unfix": MihomoClashActionPolicy(2, 1, 20, 60.0),
        # Mihomo delay checks are CPU/network-heavy on router hardware. Keep
        # one in flight globally so concurrent browser tabs cannot starve UI
        # status polling or create an upstream busy queue.
        "delay": MihomoClashActionPolicy(1, 1, 24, 60.0),
        # HTTP fallback uses this endpoint at a documented two-second cadence.
        # The rolling limit bounds accidental hot loops while leaving room for
        # manual refreshes and a reconnect bootstrap.
        "connections-snapshot": MihomoClashActionPolicy(8, 1, 40, 60.0),
        "connection-disconnect": MihomoClashActionPolicy(8, 2, 120, 60.0),
        "connections-disconnect-all": MihomoClashActionPolicy(1, 1, 10, 60.0),
        # The provider workspace uses a bounded two-worker queue for explicit
        # HTTP-provider batches. Keep the server cap aligned with that queue.
        "provider-update": MihomoClashActionPolicy(2, 2, 120, 60.0),
        "provider-healthcheck": MihomoClashActionPolicy(2, 1, 20, 60.0),
    }
)


@dataclass(frozen=True)
class MihomoClashActionRejected:
    code: str
    retry_after_seconds: int


class MihomoClashActionLease:
    def __init__(self, release: Callable[[], None]):
        self._release = release
        self._released = False

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._release()

    def __enter__(self) -> "MihomoClashActionLease":
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.release()


class MihomoClashActionGuard:
    """Bound mutating/expensive actions per process and authenticated subject."""

    def __init__(
        self,
        *,
        policies: Mapping[str, MihomoClashActionPolicy] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        source = MIHOMO_CLASH_ACTION_POLICIES if policies is None else policies
        self._policies = MappingProxyType(dict(source))
        self._clock = clock
        self._lock = threading.Lock()
        self._active_global: dict[str, int] = defaultdict(int)
        self._active_subject: dict[tuple[str, str], int] = defaultdict(int)
        self._calls: dict[tuple[str, str], deque[float]] = defaultdict(deque)

    def try_acquire(
        self,
        action: str,
        subject: str,
    ) -> tuple[MihomoClashActionLease | None, MihomoClashActionRejected | None]:
        action_name = str(action or "")
        subject_name = str(subject or "anonymous")[:128]
        policy = self._policies.get(action_name)
        if policy is None:
            return None, MihomoClashActionRejected("action_not_allowed", 60)

        now = float(self._clock())
        key = (action_name, subject_name)
        with self._lock:
            calls = self._calls[key]
            boundary = now - max(0.1, float(policy.window_seconds))
            while calls and calls[0] <= boundary:
                calls.popleft()

            if len(calls) >= max(1, int(policy.max_calls_per_window)):
                retry_after = max(1, int(policy.window_seconds - (now - calls[0]) + 0.999))
                return None, MihomoClashActionRejected("action_rate_limited", retry_after)

            if (
                self._active_global[action_name] >= max(1, int(policy.max_global_concurrent))
                or self._active_subject[key] >= max(1, int(policy.max_subject_concurrent))
            ):
                return None, MihomoClashActionRejected("action_busy", 1)

            calls.append(now)
            self._active_global[action_name] += 1
            self._active_subject[key] += 1

        def release() -> None:
            with self._lock:
                self._active_global[action_name] = max(
                    0,
                    self._active_global[action_name] - 1,
                )
                self._active_subject[key] = max(0, self._active_subject[key] - 1)

        return MihomoClashActionLease(release), None


__all__ = [
    "MIHOMO_CLASH_ACTION_POLICIES",
    "MihomoClashActionGuard",
    "MihomoClashActionLease",
    "MihomoClashActionPolicy",
    "MihomoClashActionRejected",
]
