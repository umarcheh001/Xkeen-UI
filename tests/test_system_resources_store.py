from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "xkeen-ui"))

from services.system_resources_history.store import TIERS, HistoryStore  # noqa: E402

T0 = 1_000_000 * 1800  # aligned to every tier step and every column step


def feed(store, start, seconds, value, step=5, metric="cpu"):
    t = start
    while t < start + seconds:
        store.add(t, {metric: value})
        t += step
    return t


def test_tiers_constants():
    assert TIERS == {"fresh": (15, 240), "day": (300, 288), "week": (1800, 336)}


def test_fresh_point_avg_and_max():
    s = HistoryStore(("cpu",))
    s.add(T0, {"cpu": 10})
    s.add(T0 + 5, {"cpu": 20})
    s.add(T0 + 10, {"cpu": 60})
    res = s.columns("15m", T0 + 10)
    assert res["step_s"] == 15
    last = res["metrics"]["cpu"]
    assert last["avg"][-1] == 30
    assert last["max"][-1] == 60
    assert len(last["avg"]) == 60
    assert last["avg"][0] is None


def test_1h_has_60_columns_of_4_points():
    s = HistoryStore(("cpu",))
    end = feed(s, T0, 3600, 40)
    res = s.columns("1h", end - 5)
    assert res["step_s"] == 60
    assert len(res["metrics"]["cpu"]["avg"]) == 60
    assert res["metrics"]["cpu"]["avg"][:59] == [40] * 59
    assert res["start"] == T0
    assert res["history_since"] == T0


def test_24h_96_cells():
    s = HistoryStore(("cpu",))
    end = feed(s, T0, 86400, 10, step=15)
    res = s.columns("24h", end - 15)
    assert res["step_s"] == 900
    assert len(res["metrics"]["cpu"]["avg"]) == 96
    assert res["metrics"]["cpu"]["avg"][5] == 10


def test_7d_336_cells():
    s = HistoryStore(("cpu",))
    end = feed(s, T0, 7 * 86400, 7, step=60)
    res = s.columns("7d", end - 60)
    assert res["step_s"] == 1800
    assert len(res["metrics"]["cpu"]["avg"]) == 336
    assert res["metrics"]["cpu"]["avg"][0] == 7
    res6 = s.columns("6h", end - 60)
    assert len(res6["metrics"]["cpu"]["avg"]) == 72


def test_gap_is_none_not_zero():
    s = HistoryStore(("cpu",))
    feed(s, T0, 120, 50)
    feed(s, T0 + 120 + 600, 60, 50)
    res = s.columns("15m", T0 + 120 + 600 + 55)
    avg = res["metrics"]["cpu"]["avg"]
    assert None in avg
    assert 0 not in avg
    gap = [v for v in avg[-40:-5]]
    assert any(v is None for v in gap)


def test_clock_jump_forward_makes_gap():
    s = HistoryStore(("cpu",))
    feed(s, T0, 300, 30)
    s.add(T0 + 3 * 3600, {"cpu": 90})
    res = s.columns("6h", T0 + 3 * 3600)
    avg = res["metrics"]["cpu"]["avg"]
    assert avg[-1] == 90
    # the skipped three hours stay empty, no interpolation
    assert all(v is None for v in avg[-30:-1])
    assert avg[-37] == 30


def test_clock_jump_back_resets_only_fresh():
    s = HistoryStore(("cpu",))
    feed(s, T0, 600, 30)
    s.add(T0 + 600 - 3600, {"cpu": 5})
    fresh = s.columns("15m", T0 + 600 - 3600)["metrics"]["cpu"]["avg"]
    assert [v for v in fresh if v is not None] == [5]
    day = s.columns("6h", T0 + 600)["metrics"]["cpu"]["avg"]
    assert day[-1] == 30 or day[-2] == 30


def test_backward_jump_day_and_week_keep_recording():
    s = HistoryStore(("cpu",))
    feed(s, T0 + 4 * 3600, 600, 30)
    back = T0 + 600
    feed(s, back, 600, 70)
    now = back + 595
    for rng in ("6h", "24h", "7d"):
        avg = s.columns(rng, now)["metrics"]["cpu"]["avg"]
        assert avg[-1] == 70, rng
        # nothing dated after `now` leaks in, older data stays
        assert 30 not in avg, rng
    s2 = HistoryStore(("cpu",))
    feed(s2, T0, 600, 30)
    feed(s2, T0 - 3 * 3600, 600, 70)
    old = s2.columns("6h", T0 + 595)["metrics"]["cpu"]["avg"]
    assert old[-1] == 30
    assert s2.median("cpu") is not None


def test_restored_ahead_store_records_immediately():
    import json

    s = HistoryStore(("cpu",))
    feed(s, T0 + 2 * 3600, 600, 30)
    data = json.loads(json.dumps(s.to_dict()))
    r = HistoryStore.from_dict(data, ("cpu",))
    now = T0 + 120
    r.add(now, {"cpu": 55})
    for rng in ("15m", "6h", "7d"):
        avg = r.columns(rng, now)["metrics"]["cpu"]["avg"]
        assert avg[-1] == 55, rng
        assert 30 not in avg, rng


def test_small_backward_step_does_not_reset():
    s = HistoryStore(("cpu",))
    feed(s, T0, 300, 30)
    s.add(T0 + 290, {"cpu": 30})
    fresh = s.columns("15m", T0 + 290)["metrics"]["cpu"]["avg"]
    assert len([v for v in fresh if v is not None]) >= 15


def test_ring_wraps_after_7_days():
    s = HistoryStore(("cpu",))
    end = feed(s, T0, 8 * 86400, 1, step=60)
    feed(s, end, 3600, 99, step=60)
    res = s.columns("7d", end + 3540)
    avg = res["metrics"]["cpu"]["avg"]
    assert len(avg) == 336
    assert avg[-1] == 99
    assert avg[0] == 1
    assert all(v is not None for v in avg[:-3])


def test_median_week():
    s = HistoryStore(("cpu",))
    for i, v in enumerate([10, 20, 90, 30, 40]):
        s.add(T0 + i * 1800, {"cpu": v})
    assert s.median("cpu") == 30  # the open point counts too
    s.add(T0 + 5 * 1800, {"cpu": 0})
    assert s.median("cpu") == 25
    assert s.median("nothing") is None


def test_missing_metric_is_no_sample_and_none_value():
    s = HistoryStore(("cpu", "memory"))
    s.add(T0, {"cpu": 10})
    s.add(T0 + 5, {"cpu": 20, "memory": None})
    res = s.columns("15m", T0 + 5)["metrics"]
    assert res["cpu"]["avg"][-1] == 15
    assert res["memory"]["avg"][-1] is None
    assert res["memory"]["max"][-1] is None


def test_add_metric_runtime():
    s = HistoryStore(("cpu",))
    s.add(T0, {"cpu": 10})
    s.add_metric("rate_up:ISP")
    s.add_metric("rate_up:ISP")
    assert s.metrics == ("cpu", "rate_up:ISP")
    s.add(T0 + 5, {"cpu": 20, "rate_up:ISP": 7})
    res = s.columns("15m", T0 + 5)["metrics"]
    assert res["rate_up:ISP"]["avg"][-1] == 7
    assert res["cpu"]["avg"][-1] == 15


def test_unknown_metric_ignored():
    s = HistoryStore(("cpu",))
    s.add(T0, {"cpu": 1, "zzz": 5})
    assert "zzz" not in s.columns("15m", T0)["metrics"]


def test_roundtrip_dict():
    s = HistoryStore(("cpu",))
    feed(s, T0, 600, 25)
    data = s.to_dict()
    import json

    data = json.loads(json.dumps(data))
    r = HistoryStore.from_dict(data, ("cpu", "queue"))
    a = s.columns("15m", T0 + 595)
    b = r.columns("15m", T0 + 595)
    assert a["metrics"]["cpu"] == b["metrics"]["cpu"]
    assert all(v is None for v in b["metrics"]["queue"]["avg"])
    assert not any(isinstance(v, float) and math.isnan(v) for v in b["metrics"]["cpu"]["avg"])


def test_memory_budget():
    s = HistoryStore(tuple(f"m{i}" for i in range(14)))
    assert s.memory_bytes() < 110_000
