from __future__ import annotations

from services.mihomo_clash_devices import (
    get_mihomo_clash_device_map,
    reset_mihomo_clash_device_map_cache,
)


def test_device_map_is_cached_between_stream_frames_and_refreshes_after_ttl():
    reset_mihomo_clash_device_map_cache()
    current = [100.0]
    calls = []

    def state_factory(*, refresh_router):
        calls.append(refresh_router)
        return {"device_map": {"192.0.2.1": {"name": f"device-{len(calls)}"}}}

    first = get_mihomo_clash_device_map(clock=lambda: current[0], state_factory=state_factory)
    second = get_mihomo_clash_device_map(clock=lambda: current[0], state_factory=state_factory)
    current[0] += 31
    third = get_mihomo_clash_device_map(clock=lambda: current[0], state_factory=state_factory)

    assert first["192.0.2.1"]["name"] == "device-1"
    assert second == first
    assert third["192.0.2.1"]["name"] == "device-2"
    assert calls == [True, True]


def test_empty_device_map_and_router_failure_are_cached_for_the_ttl():
    reset_mihomo_clash_device_map_cache()
    current = [100.0]
    calls = []

    def state_factory(*, refresh_router):
        calls.append(refresh_router)
        return {"device_map": {}}

    assert get_mihomo_clash_device_map(clock=lambda: current[0], state_factory=state_factory) == {}
    assert get_mihomo_clash_device_map(clock=lambda: current[0], state_factory=state_factory) == {}
    assert calls == [True]
