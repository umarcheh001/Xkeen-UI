"""Shared in-memory telemetry fan-out for the Mihomo operator panel.

The hub is intentionally small and process-local.  It owns no controller
configuration and never writes a snapshot to disk: a discovered, backend-only
``MihomoClashTarget`` is used to run one bounded reader per source and the
result is fanned out to browser subscribers.  Connections, memory and the
optional traffic stream have independent cadences and failures.
"""

from __future__ import annotations

import copy
import queue
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from services.mihomo_clash_cache import target_fingerprint
from services.mihomo_clash_client import MihomoClashClient, MihomoClashClientError
from services.mihomo_clash_capabilities import parse_mihomo_version
from services.mihomo_clash_dto import build_mihomo_clash_connections_dto
from services.mihomo_clash_target import MihomoClashTarget
from services.mihomo_clash_devices import get_mihomo_clash_device_map


DEFAULT_CADENCES_SECONDS: Mapping[str, float] = {
    "traffic": 1.0,
    "connections": 2.0,
    "memory": 5.0,
}
MAX_TELEMETRY_TARGETS = 8
MAX_TELEMETRY_SUBSCRIBERS = 32
MAX_TELEMETRY_QUEUE = 8
MAX_TELEMETRY_HISTORY = 60
IDLE_STOP_SECONDS = 4.0


def mihomo_target_fingerprint(target: MihomoClashTarget) -> str:
    """Return a stable, secret-free key for one discovered controller target."""

    return target_fingerprint(target)


class TelemetrySubscriptionClosed(RuntimeError):
    """Raised when a subscription is closed by the hub or its owner."""


class TelemetrySubscription:
    """Bounded queue owned by one browser telemetry socket."""

    def __init__(self, hub: "TelemetryHub", subscription_id: int, maxsize: int):
        self.hub = hub
        self.subscription_id = int(subscription_id)
        self.queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=maxsize)
        self.closed = threading.Event()
        self.closed_reason = ""

    def get(self, timeout: float | None = None) -> dict[str, Any]:
        """Wait for one frame, raising a stable exception after close."""

        if self.closed.is_set() and self.queue.empty():
            raise TelemetrySubscriptionClosed(self.closed_reason or "closed")
        try:
            frame = self.queue.get(timeout=timeout)
        except queue.Empty:
            if self.closed.is_set():
                raise TelemetrySubscriptionClosed(self.closed_reason or "closed")
            raise
        if frame is None:
            raise TelemetrySubscriptionClosed(self.closed_reason or "closed")
        return frame

    def close(self, reason: str = "closed") -> None:
        self.hub.unsubscribe(self, reason=reason)

    def __iter__(self):
        while not self.closed.is_set():
            try:
                yield self.get(timeout=0.5)
            except queue.Empty:
                continue
            except TelemetrySubscriptionClosed:
                break


@dataclass
class _SourceState:
    state: str = "error"
    payload: Any = None
    error: dict[str, Any] | None = None
    last_success_ms: int | None = None
    stale_since: int | None = None


class TelemetryHub:
    """One set of source readers shared by all subscribers for a target."""

    def __init__(
        self,
        target: MihomoClashTarget,
        *,
        client_factory: Callable[[MihomoClashTarget], Any] = MihomoClashClient,
        device_map_factory: Callable[[], Mapping[str, Any]] = get_mihomo_clash_device_map,
        traffic_enabled: bool = False,
        cadences: Mapping[str, float] | None = None,
        history_size: int = MAX_TELEMETRY_HISTORY,
        max_subscribers: int = MAX_TELEMETRY_SUBSCRIBERS,
        queue_size: int = MAX_TELEMETRY_QUEUE,
        stop_grace_seconds: float = IDLE_STOP_SECONDS,
    ):
        self.target = target
        self.fingerprint = mihomo_target_fingerprint(target)
        self.client_factory = client_factory
        self.device_map_factory = device_map_factory
        self.traffic_enabled = bool(traffic_enabled)
        self.cadences = {
            name: max(0.05, float((cadences or {}).get(name, default)))
            for name, default in DEFAULT_CADENCES_SECONDS.items()
        }
        self.history_size = max(1, min(256, int(history_size)))
        self.max_subscribers = max(1, min(MAX_TELEMETRY_SUBSCRIBERS, int(max_subscribers)))
        self.queue_size = max(1, min(MAX_TELEMETRY_QUEUE, int(queue_size)))
        self.stop_grace_seconds = max(0.0, min(30.0, float(stop_grace_seconds)))
        self._lock = threading.RLock()
        self._subscribers: dict[int, TelemetrySubscription] = {}
        self._next_subscription_id = 0
        self._stop_event = threading.Event()
        self._running = False
        self._started_once = False
        self._threads: dict[str, threading.Thread] = {}
        self._idle_thread: threading.Thread | None = None
        self._idle_generation = 0
        self._sources = {
            name: _SourceState() for name in ("traffic", "connections", "memory")
        }
        self._sequence = 0
        self._history: deque[dict[str, Any]] = deque(maxlen=self.history_size)
        self._previous_totals: tuple[int, int, int] | None = None
        self._last_rates: dict[str, float] | None = None

    @property
    def running(self) -> bool:
        with self._lock:
            return self._running

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    @property
    def history(self) -> tuple[dict[str, Any], ...]:
        with self._lock:
            return tuple(copy.deepcopy(list(self._history)))

    def subscribe(self) -> TelemetrySubscription | None:
        """Attach a bounded subscriber and start readers on first attach."""

        with self._lock:
            if len(self._subscribers) >= self.max_subscribers:
                return None
            self._next_subscription_id += 1
            subscription = TelemetrySubscription(self, self._next_subscription_id, self.queue_size)
            self._subscribers[subscription.subscription_id] = subscription
            self._idle_generation += 1
            if self._idle_thread is not None:
                self._idle_thread = None
            if not self._running:
                self._start_locked()
            latest = self._latest_frame_locked()
            if latest is not None:
                try:
                    subscription.queue.put_nowait(copy.deepcopy(latest))
                except queue.Full:
                    self._close_subscription_locked(subscription, "slow_consumer")
            return subscription if not subscription.closed.is_set() else None

    def unsubscribe(self, subscription: TelemetrySubscription, *, reason: str = "closed") -> None:
        with self._lock:
            current = self._subscribers.get(subscription.subscription_id)
            if current is not subscription:
                subscription.closed.set()
                if not subscription.closed_reason:
                    subscription.closed_reason = reason
                return
            self._close_subscription_locked(subscription, reason)

    def stop(self) -> None:
        """Stop all readers and close subscribers; safe to call repeatedly."""

        with self._lock:
            self._stop_event.set()
            self._running = False
            subscribers = list(self._subscribers.values())
            self._subscribers.clear()
            threads = list(self._threads.values())
            self._threads.clear()
        for subscriber in subscribers:
            subscriber.closed_reason = "hub_stopped"
            subscriber.closed.set()
            try:
                subscriber.queue.put_nowait(None)
            except queue.Full:
                pass
        current = threading.current_thread()
        for thread in threads:
            if thread is not current:
                thread.join(timeout=1.0)

    def _start_locked(self) -> None:
        self._stop_event.clear()
        self._running = True
        self._started_once = True
        sources = ["connections", "memory"]
        if self.traffic_enabled:
            sources.insert(0, "traffic")
        for source in sources:
            thread = threading.Thread(
                target=self._reader_loop,
                args=(source,),
                name=f"mihomo-telemetry-{source}",
                daemon=True,
            )
            self._threads[source] = thread
            thread.start()

    def _schedule_idle_stop_locked(self) -> None:
        if self.stop_grace_seconds <= 0:
            # We are called while holding ``_lock``.  Signal readers and mark
            # the hub idle here; joining their threads while holding this lock
            # could deadlock a reader that is publishing its final frame.
            self._stop_event.set()
            self._running = False
            self._threads.clear()
            return
        if self._idle_thread is not None and self._idle_thread.is_alive():
            return
        self._idle_generation += 1
        idle_generation = self._idle_generation
        idle_thread = threading.Thread(
            target=self._idle_stop_worker,
            args=(idle_generation,),
            name="mihomo-telemetry-idle-stop",
            daemon=True,
        )
        self._idle_thread = idle_thread
        idle_thread.start()

    def _idle_stop_worker(self, idle_generation: int) -> None:
        if self._stop_event.wait(self.stop_grace_seconds):
            return
        with self._lock:
            if (
                idle_generation != self._idle_generation
                or self._subscribers
                or not self._running
            ):
                return
        self.stop()

    def _reader_loop(self, source: str) -> None:
        try:
            client = self.client_factory(self.target)
        except Exception as exc:
            self._publish_error(source, exc)
            client = None
        if source == "traffic" and client is not None:
            try:
                version_response = client.request_json("version")
                version = parse_mihomo_version(getattr(version_response, "payload", version_response))
                if version is None or version < (1, 18, 0):
                    raise MihomoClashClientError(
                        "not_supported",
                        "The installed Mihomo version does not support traffic telemetry.",
                        status=409,
                    )
            except Exception as exc:
                self._publish_error(source, exc)
                return
        while not self._stop_event.is_set():
            if client is not None:
                try:
                    payload = self._read_source(client, source)
                except Exception as exc:  # source failures must not stop siblings
                    self._publish_error(source, exc)
                else:
                    self._publish_success(source, payload)
            if self._stop_event.wait(self.cadences[source]):
                break

    def _read_source(self, client: Any, source: str) -> Any:
        if source == "traffic":
            response = client.request_traffic()
            return self._normalize_traffic(getattr(response, "payload", response))
        if source == "connections":
            response = client.request_json("connections_snapshot")
            raw = getattr(response, "payload", response)
            return build_mihomo_clash_connections_dto(
                raw,
                device_map=self.device_map_factory(),
            )
        response = client.request_memory()
        raw = getattr(response, "payload", response)
        value = raw.get("inuse") if isinstance(raw, Mapping) else 0
        try:
            return {"inuse": max(0, int(value))}
        except (TypeError, ValueError, OverflowError):
            return {"inuse": 0}

    @staticmethod
    def _normalize_traffic(payload: Any) -> dict[str, int]:
        raw = payload if isinstance(payload, Mapping) else {}

        def number(*keys: str) -> int:
            for key in keys:
                value = raw.get(key)
                if isinstance(value, bool):
                    continue
                try:
                    return max(0, int(value))
                except (TypeError, ValueError, OverflowError):
                    continue
            return 0

        return {
            "download": number("download", "down", "downloadTotal"),
            "upload": number("upload", "up", "uploadTotal"),
        }

    def _publish_success(self, source: str, payload: Any) -> None:
        now = int(time.time() * 1000)
        with self._lock:
            state = self._sources[source]
            state.state = "live"
            state.payload = payload
            state.error = None
            state.last_success_ms = now
            state.stale_since = None
            self._publish_locked(now, updated_source=source)

    def _publish_error(self, source: str, exc: Exception) -> None:
        now = int(time.time() * 1000)
        if isinstance(exc, MihomoClashClientError):
            error = exc.public_dict()
        else:
            error = {"code": "source_failed", "retryable": True}
        with self._lock:
            state = self._sources[source]
            if state.last_success_ms is not None:
                state.state = "stale"
                if state.stale_since is None:
                    state.stale_since = now
            else:
                state.state = "error"
            state.error = error
            self._publish_locked(now, updated_source=source)

    def _latest_frame_locked(self) -> dict[str, Any] | None:
        return copy.deepcopy(self._history[-1]) if self._history else None

    def _publish_locked(self, now: int, *, updated_source: str) -> None:
        self._sequence += 1
        source_payload: dict[str, Any] = {}
        source_status: dict[str, Any] = {}
        stale_since_values: list[int] = []
        ages: list[int] = []
        for name, state in self._sources.items():
            if state.payload is not None:
                source_payload[name] = copy.deepcopy(state.payload)
            item: dict[str, Any] = {"state": state.state}
            if state.error:
                item["error"] = copy.deepcopy(state.error)
            if state.stale_since is not None:
                item["stale_since"] = state.stale_since
                stale_since_values.append(state.stale_since)
            if state.last_success_ms is not None:
                age = max(0, now - state.last_success_ms)
                item["source_age_ms"] = age
                ages.append(age)
            source_status[name] = item

        connection = source_payload.get("connections")
        memory = source_payload.get("memory")
        if isinstance(connection, Mapping) and isinstance(memory, Mapping):
            # Keep the existing connections DTO shape so consumers can switch
            # transports without changing inspectors or summary rendering.
            connection = copy.deepcopy(dict(connection))
            connection["memory"] = max(0, int(memory.get("inuse") or 0))
            source_payload["connections"] = connection
        if updated_source == "connections":
            self._last_rates = self._connection_rates(connection, now)
        if self._last_rates:
            source_payload["rates"] = copy.deepcopy(self._last_rates)
        states = [state.state for state in self._sources.values() if state.last_success_ms is not None or state.error]
        if not states or all(state == "error" for state in states):
            overall = "error"
        elif any(state in {"stale", "error"} for state in states):
            overall = "stale"
        else:
            overall = "live"
        frame: dict[str, Any] = {
            "type": "mihomo-clash-telemetry",
            "schema_version": 1,
            "sequence": self._sequence,
            "received_at_ms": now,
            "state": overall,
            "payload": {
                "schema_version": 1,
                "sources": source_status,
                **source_payload,
            },
        }
        if stale_since_values:
            frame["stale_since"] = min(stale_since_values)
        if ages:
            frame["source_age_ms"] = max(ages)
        self._history.append(copy.deepcopy(frame))
        for subscription in list(self._subscribers.values()):
            try:
                subscription.queue.put_nowait(copy.deepcopy(frame))
            except queue.Full:
                self._close_subscription_locked(subscription, "slow_consumer")

    def _connection_rates(self, payload: Any, now: int) -> dict[str, float] | None:
        if not isinstance(payload, Mapping):
            return None
        download = int(payload.get("download_total") or 0)
        upload = int(payload.get("upload_total") or 0)
        previous = self._previous_totals
        self._previous_totals = (download, upload, now)
        if previous is None:
            return {"download_bps": 0.0, "upload_bps": 0.0}
        old_download, old_upload, old_at = previous
        elapsed = max(0.001, (now - old_at) / 1000.0)
        return {
            "download_bps": max(0.0, (download - old_download) / elapsed),
            "upload_bps": max(0.0, (upload - old_upload) / elapsed),
        }

    def _close_subscription_locked(self, subscription: TelemetrySubscription, reason: str) -> None:
        self._subscribers.pop(subscription.subscription_id, None)
        subscription.closed_reason = str(reason or "closed")
        subscription.closed.set()
        try:
            while True:
                subscription.queue.get_nowait()
        except queue.Empty:
            pass
        try:
            subscription.queue.put_nowait(None)
        except queue.Full:
            pass
        if not self._subscribers and self._running:
            self._schedule_idle_stop_locked()


_HUB_LOCK = threading.RLock()
_HUBS: dict[str, TelemetryHub] = {}


def get_telemetry_hub(
    target: MihomoClashTarget,
    **kwargs: Any,
) -> TelemetryHub | None:
    """Get/create a bounded hub for one target fingerprint."""

    key = mihomo_target_fingerprint(target)
    with _HUB_LOCK:
        current = _HUBS.get(key)
        if current is not None and (current.running or current.subscriber_count or not current._started_once):
            return current
        if current is not None:
            _HUBS.pop(key, None)
        for stale_key, stale_hub in list(_HUBS.items()):
            if not stale_hub.running and stale_hub.subscriber_count == 0:
                _HUBS.pop(stale_key, None)
        if len(_HUBS) >= MAX_TELEMETRY_TARGETS:
            return None
        hub = TelemetryHub(target, **kwargs)
        _HUBS[key] = hub
        return hub


def stop_all_telemetry_hubs() -> None:
    """Best-effort process shutdown hook used by tests and app teardown."""

    with _HUB_LOCK:
        hubs = list(_HUBS.values())
        _HUBS.clear()
    for hub in hubs:
        hub.stop()


__all__ = [
    "DEFAULT_CADENCES_SECONDS",
    "IDLE_STOP_SECONDS",
    "MAX_TELEMETRY_HISTORY",
    "MAX_TELEMETRY_QUEUE",
    "MAX_TELEMETRY_SUBSCRIBERS",
    "MAX_TELEMETRY_TARGETS",
    "TelemetryHub",
    "TelemetrySubscription",
    "TelemetrySubscriptionClosed",
    "get_telemetry_hub",
    "mihomo_target_fingerprint",
    "stop_all_telemetry_hubs",
]
