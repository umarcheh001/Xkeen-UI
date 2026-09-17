from __future__ import annotations

from services.memory_guard import MIB, MemoryGuard, resolve_memory_budget_bytes


def test_auto_budget_is_router_sized_and_bounded():
    assert resolve_memory_budget_bytes("auto", 512 * MIB) == 128 * MIB
    assert resolve_memory_budget_bytes("auto", 256 * MIB) == 128 * MIB
    assert resolve_memory_budget_bytes("auto", 4 * 1024 * MIB) == 256 * MIB
    assert resolve_memory_budget_bytes("192", 512 * MIB) == 192 * MIB
    assert resolve_memory_budget_bytes("off", 512 * MIB) is None


def test_guard_reclaims_caches_when_rss_nears_budget():
    rss_values = iter((120 * MIB, 80 * MIB))
    calls: list[str] = []
    thresholds: list[tuple[int, int, int]] = []

    guard = MemoryGuard(
        ui_state_dir="/unused",
        settings_loader=lambda **_kwargs: {"runtime": {"memoryBudget": "128"}},
        rss_reader=lambda: next(rss_values),
        memory_reader=lambda: (512 * MIB, 200 * MIB),
        cache_clearer=lambda: calls.append("cache") or {"logs": 2},
        collector=lambda: calls.append("gc") or 7,
        trimmer=lambda: calls.append("trim") or True,
        threshold_setter=lambda *values: thresholds.append(values),
        clock=lambda: 100.0,
    )

    status = guard.check()

    assert calls == ["cache", "gc", "trim"]
    assert thresholds == [(350, 7, 7)]
    assert status["enabled"] is True
    assert status["pressure"] is True
    assert status["budget_bytes"] == 128 * MIB
    assert status["rss_bytes"] == 80 * MIB
    assert status["last_reclaimed_bytes"] == 40 * MIB
    assert status["last_collected_objects"] == 7
    assert status["collections"] == 1


def test_guard_does_not_collect_below_pressure_threshold():
    calls: list[str] = []
    guard = MemoryGuard(
        ui_state_dir="/unused",
        settings_loader=lambda **_kwargs: {"runtime": {"memoryBudget": "128"}},
        rss_reader=lambda: 75 * MIB,
        memory_reader=lambda: (512 * MIB, 200 * MIB),
        cache_clearer=lambda: calls.append("cache") or {},
        collector=lambda: calls.append("gc") or 0,
        trimmer=lambda: calls.append("trim") or False,
        threshold_setter=lambda *_values: None,
    )

    status = guard.check()

    assert calls == []
    assert status["pressure"] is False
    assert status["collections"] == 0


def test_off_disables_pressure_actions_and_restores_default_gc_mode():
    calls: list[str] = []
    thresholds: list[tuple[int, int, int]] = []
    guard = MemoryGuard(
        ui_state_dir="/unused",
        settings_loader=lambda **_kwargs: {"runtime": {"memoryBudget": "off"}},
        rss_reader=lambda: 300 * MIB,
        memory_reader=lambda: (512 * MIB, 10 * MIB),
        cache_clearer=lambda: calls.append("cache") or {},
        collector=lambda: calls.append("gc") or 0,
        trimmer=lambda: calls.append("trim") or False,
        threshold_setter=lambda *values: thresholds.append(values),
    )

    status = guard.check()

    assert calls == []
    assert len(thresholds) == 1
    assert status["enabled"] is False
    assert status["budget_bytes"] is None
    assert status["pressure"] is False
