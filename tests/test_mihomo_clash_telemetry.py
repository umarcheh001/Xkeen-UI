from __future__ import annotations

import threading
import time

from services.mihomo_clash_client import MihomoClashJSONResponse
from services.mihomo_clash_target import MihomoClashTarget
from services.mihomo_clash_telemetry import (
    TelemetryHub,
    TelemetrySubscriptionClosed,
    get_telemetry_hub,
    mihomo_target_fingerprint,
    stop_all_telemetry_hubs,
)


class StubClient:
    instances = 0
    connections = 0
    memories = 0

    def __init__(self, _target):
        type(self).instances += 1

    def request_json(self, operation):
        assert operation == "connections_snapshot"
        type(self).connections += 1
        return MihomoClashJSONResponse(
            {"downloadTotal": 100 + self.connections, "uploadTotal": 40, "connections": []},
            200,
            0,
            32,
        )

    def request_memory(self):
        type(self).memories += 1
        return MihomoClashJSONResponse({"inuse": 2048}, 200, 0, 16)


class TrafficClient(StubClient):
    traffic = 0

    def request_json(self, operation):
        if operation == "version":
            return MihomoClashJSONResponse({"version": "Mihomo Meta v1.19.12"}, 200, 0, 32)
        return super().request_json(operation)

    def request_traffic(self):
        type(self).traffic += 1
        return MihomoClashJSONResponse({"down": 50, "up": 20}, 200, 0, 16)


def target():
    return MihomoClashTarget(transport="tcp", port=9090, loopback_host="127.0.0.1")


def test_target_fingerprint_rotates_with_secret_without_exposing_it():
    first = MihomoClashTarget(transport="tcp", port=9090, loopback_host="127.0.0.1", secret="one")
    second = MihomoClashTarget(transport="tcp", port=9090, loopback_host="127.0.0.1", secret="two")
    fingerprints = (mihomo_target_fingerprint(first), mihomo_target_fingerprint(second))
    assert fingerprints[0] != fingerprints[1]
    assert "one" not in fingerprints and "two" not in fingerprints


def test_ten_subscribers_share_one_reader_per_source_and_fanout():
    StubClient.instances = StubClient.connections = StubClient.memories = 0
    hub = TelemetryHub(
        target(),
        client_factory=StubClient,
        cadences={"connections": 0.5, "memory": 0.5, "traffic": 1},
        stop_grace_seconds=0,
    )
    subscriptions = [hub.subscribe() for _ in range(10)]
    assert all(subscription is not None for subscription in subscriptions)
    deadline = time.time() + 1
    frames = []
    for subscription in subscriptions:
        frame = None
        while time.time() < deadline and frame is None:
            try:
                frame = subscription.get(timeout=0.05)
            except Exception:
                pass
        frames.append(frame)
    assert all(frames)
    assert all(frame["type"] == "mihomo-clash-telemetry" for frame in frames)
    assert all(frame["payload"].get("connections") or frame["payload"].get("memory") for frame in frames)
    assert StubClient.instances == 2  # one client object per source reader
    for subscription in subscriptions:
        subscription.close()
    assert hub.subscriber_count == 0
    assert hub.running is False


def test_source_failure_is_stale_and_does_not_stop_sibling_reader():
    class FailingClient(StubClient):
        def request_json(self, operation):
            raise RuntimeError("connections down")

    hub = TelemetryHub(
        target(),
        client_factory=FailingClient,
        cadences={"connections": 0.03, "memory": 0.03, "traffic": 1},
        stop_grace_seconds=0,
    )
    subscription = hub.subscribe()
    assert subscription is not None
    frames = []
    deadline = time.time() + 1
    while time.time() < deadline and len(frames) < 4:
        try:
            frames.append(subscription.get(timeout=0.1))
        except Exception:
            pass
    assert frames
    assert any(frame["payload"].get("memory", {}).get("inuse") == 2048 for frame in frames)
    assert any(frame["payload"]["sources"]["connections"]["state"] == "error" for frame in frames)
    subscription.close()


def test_optional_traffic_reader_is_version_gated_and_independent():
    TrafficClient.traffic = 0
    hub = TelemetryHub(
        target(),
        client_factory=TrafficClient,
        traffic_enabled=True,
        cadences={"connections": 0.1, "memory": 0.1, "traffic": 0.02},
        stop_grace_seconds=0,
    )
    subscription = hub.subscribe()
    deadline = time.time() + 1
    observed = None
    while time.time() < deadline:
        try:
            frame = subscription.get(timeout=0.1)
        except Exception:
            continue
        if frame["payload"].get("traffic"):
            observed = frame["payload"]["traffic"]
            break
    assert observed == {"download": 50, "upload": 20}
    assert TrafficClient.traffic >= 1
    subscription.close()


def test_slow_consumer_is_disconnected_without_blocking_registry():
    hub = TelemetryHub(
        target(),
        client_factory=StubClient,
        cadences={"connections": 0.01, "memory": 0.01, "traffic": 1},
        queue_size=1,
        stop_grace_seconds=0,
    )
    subscription = hub.subscribe()
    assert subscription is not None
    deadline = time.time() + 1
    while time.time() < deadline and not subscription.closed.is_set():
        time.sleep(0.02)
    assert subscription.closed.is_set()
    assert subscription.closed_reason == "slow_consumer"


def test_registry_deduplicates_target_and_idle_hub_can_be_recreated():
    stop_all_telemetry_hubs()
    first = get_telemetry_hub(target(), client_factory=StubClient, stop_grace_seconds=0)
    second = get_telemetry_hub(target(), client_factory=StubClient, stop_grace_seconds=0)
    assert first is second
    subscription = first.subscribe()
    assert subscription is not None
    subscription.close()
    replacement = get_telemetry_hub(target(), client_factory=StubClient, stop_grace_seconds=0)
    assert replacement is not first
    stop_all_telemetry_hubs()
