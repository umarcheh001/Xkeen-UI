from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "xkeen-ui"))

from services.system_resources_history.problems import RETENTION_S, ProblemTracker  # noqa: E402
from services.system_resources_history.zones import hotter_than_usual, zone  # noqa: E402

T0 = 1_800_000_000.0


@pytest.mark.parametrize(
    "metric,value,kwargs,expected",
    [
        ("cpu", 59.9, {}, 0), ("cpu", 60, {}, 1), ("cpu", 84.9, {}, 1), ("cpu", 85, {}, 2),
        ("memory", 74.9, {}, 0), ("memory", 75, {}, 1), ("memory", 89.9, {}, 1), ("memory", 90, {}, 2),
        ("link_up", 69.9, {}, 0), ("link_up", 70, {}, 1), ("link_up", 89.9, {}, 1), ("link_up", 90, {}, 2),
        ("link_down", 70, {}, 1), ("link_down", 90, {}, 2),
        ("temp:chip", 79.9, {"kind": "chip"}, 0), ("temp:chip", 80, {"kind": "chip"}, 1),
        ("temp:chip", 94.9, {"kind": "chip"}, 1), ("temp:chip", 95, {"kind": "chip"}, 2),
        ("temp:wifi5", 84.9, {"kind": "wifi"}, 0), ("temp:wifi5", 85, {"kind": "wifi"}, 1),
        ("temp:wifi5", 99.9, {"kind": "wifi"}, 1), ("temp:wifi5", 100, {"kind": "wifi"}, 2),
        ("queue", 2.0, {"cores": 3}, 0), ("queue", 2.1, {"cores": 3}, 1),
        ("queue", 2.9, {"cores": 3}, 1), ("queue", 3.0, {"cores": 3}, 2),
        ("cpu", None, {}, None), ("temp:chip", None, {"kind": "chip"}, None),
    ],
)
def test_zone_thresholds_table(metric, value, kwargs, expected):
    assert zone(metric, value, **kwargs) == expected


def test_link_over_100_is_red():
    assert zone("link_down", 105) == 2


def test_unknown_metric_is_none():
    assert zone("nonsense", 50) is None


def test_hotter_than_usual():
    assert hotter_than_usual(75, 60) == 15
    assert hotter_than_usual(74.9, 60) is None
    assert hotter_than_usual(75, None) is None


def _tr():
    return ProblemTracker(lambda: T0)


def _run(tr, seconds, zones, start=T0, step=5, details=None):
    out = []
    t = start
    while t <= start + seconds:
        out += tr.update(t, zones, details or {})
        t += step
    return out


def test_red_needs_3_minutes():
    tr = _tr()
    out = _run(tr, 175, {"cpu": 2})
    assert out == [] and tr.active() == []
    out = tr.update(T0 + 180, {"cpu": 2}, {"cpu": "92 %"})
    assert [e["type"] for e in out] == ["cpu_overload"]
    ev = out[0]
    assert ev["title"] == "Процессор перегружен" and ev["until"] is None
    assert ev["at"] == T0 and ev["detail"] == "92 %"
    assert tr.active() == [ev]
    json.dumps(ev)


def test_short_spike_no_event():
    tr = _tr()
    _run(tr, 150, {"cpu": 2})
    _run(tr, 60, {"cpu": 0}, start=T0 + 155)
    out = _run(tr, 150, {"cpu": 2}, start=T0 + 220)
    assert out == [] and tr.events(0) == []


def test_clear_needs_2_minutes_and_reports_duration():
    tr = _tr()
    _run(tr, 200, {"memory": 2})
    assert len(tr.active()) == 1
    # out of red 100 s: still open
    _run(tr, 100, {"memory": 1}, start=T0 + 205)
    assert len(tr.active()) == 1
    # back to red resets clearing
    tr.update(T0 + 310, {"memory": 2}, {})
    out = _run(tr, 125, {"memory": 0}, start=T0 + 315)
    assert tr.active() == []
    (ev,) = tr.events(0)
    assert ev["type"] == "memory_low" and ev["until"] is not None
    assert ev["until"] - ev["at"] > 300
    assert ev["title"] == "Память занята больше чем на 90 %"
    assert any(e["id"] == ev["id"] for e in out)


def test_none_zone_is_gap():
    tr = _tr()
    _run(tr, 200, {"cpu": 2})
    _run(tr, 300, {"cpu": None}, start=T0 + 205)
    assert len(tr.active()) == 1


def test_clear_after_gap_needs_full_120s():
    tr = _tr()
    _run(tr, 200, {"cpu": 2})
    _run(tr, 100, {"cpu": 0}, start=T0 + 205)  # clear timer running (100 s)
    _run(tr, 300, {"cpu": None}, start=T0 + 310)
    tr.update(T0 + 620, {"cpu": 0}, {})
    assert len(tr.active()) == 1
    tr.update(T0 + 735, {"cpu": 0}, {})
    assert len(tr.active()) == 1
    tr.update(T0 + 740, {"cpu": 0}, {})
    assert tr.active() == []


def test_red_gap_red_restarts_run():
    tr = _tr()
    _run(tr, 100, {"cpu": 2})
    _run(tr, 300, {"cpu": None}, start=T0 + 105)
    out = _run(tr, 175, {"cpu": 2}, start=T0 + 410)
    assert out == []
    out = tr.update(T0 + 590, {"cpu": 2}, {})
    assert len(out) == 1 and out[0]["at"] == T0 + 410


def test_vanished_key_is_gap():
    tr = _tr()
    _run(tr, 200, {"temp:chip": 2})
    tr.update(T0 + 205, {"temp:chip": 0}, {})
    tr.update(T0 + 210, {}, {})
    tr.update(T0 + 400, {"temp:chip": 0}, {})
    assert len(tr.active()) == 1


def test_restored_open_event_is_tracked():
    tr = _tr()
    _run(tr, 200, {"cpu": 2})
    saved = json.loads(json.dumps(tr.events(0)))
    tr2 = ProblemTracker(lambda: T0, saved + [{"junk": 1}, "x", {"type": "cpu_overload"}])
    assert len(tr2.active()) == 1
    out = _run(tr2, 300, {"cpu": 2}, start=T0 + 300)
    assert out == [] and len(tr2.events(0)) == 1
    _run(tr2, 130, {"cpu": 0}, start=T0 + 610)
    assert tr2.active() == []


def test_open_event_survives_pruning():
    now = [T0]
    tr = ProblemTracker(lambda: now[0])
    old = tr.emit("internet_lost", T0)
    tr.emit("dns_failed", T0 + RETENTION_S + 100)
    assert old["id"] in [e["id"] for e in tr.active()]
    assert tr.close("internet_lost", T0 + RETENTION_S + 200) is old


def test_queue_makes_no_event():
    tr = _tr()
    _run(tr, 400, {"queue": 2})
    assert tr.events(0) == []


def test_temp_and_link_types():
    tr = _tr()
    out = _run(tr, 200, {"temp:chip": 2, "link_down": 2})
    assert sorted(e["type"] for e in out) == ["link_saturated", "overheat"]


def test_throttle_is_immediate():
    tr = _tr()
    ev = tr.emit("cpu_throttled", T0, "1200 → 800 МГц")
    assert ev["title"] == "Процессор замедлился из-за нагрева" and ev["until"] is None
    assert tr.active() == [ev]
    # second emit while open does not duplicate
    assert tr.emit("cpu_throttled", T0 + 5)["id"] == ev["id"]
    closed = tr.close("cpu_throttled", T0 + 60)
    assert closed["until"] == T0 + 60 and tr.active() == []
    assert tr.close("cpu_throttled", T0 + 70) is None


def test_port_slow_keyed():
    tr = _tr()
    a = tr.emit("port_slow", T0, key="4")
    b = tr.emit("port_slow", T0, key="2")
    assert a["title"] == "Порт 4 работает на 100 Мбит/с" and a["id"] != b["id"]
    tr.close("port_slow", T0 + 10, key="4")
    assert [e["id"] for e in tr.active()] == [b["id"]]


def test_internet_events_and_custom_title():
    tr = _tr()
    lost = tr.emit("internet_lost", T0)
    assert lost["title"] == "Связь с интернетом потеряна"
    tr.close("internet_lost", T0 + 90)
    back = tr.emit("internet_restored", T0 + 90)
    assert back["title"] == "Связь с интернетом восстановлена"
    assert tr.active() == []
    fo = tr.emit("wan_failover", T0, title="Интернет переключился на резервное подключение МТС")
    assert fo["title"].endswith("МТС")


@pytest.mark.parametrize(
    "uptime,persisted,rebooted",
    [(599, None, True), (600, None, False), (5000, 9000, True), (9000, 5000, False), (5000, None, False)],
)
def test_reboot_detected_by_uptime(uptime, persisted, rebooted):
    tr = _tr()
    tr.note_start(uptime, persisted)
    types = [e["type"] for e in tr.events(0)]
    assert (types == ["router_rebooted"]) is rebooted
    if rebooted:
        assert tr.events(0)[0]["title"] == "Роутер перезагружен"


def test_events_kept_7_days():
    now = [T0]
    tr = ProblemTracker(lambda: now[0])
    old = tr.emit("dns_failed", T0)
    tr.close("dns_failed", T0 + 10)
    now[0] = T0 + RETENTION_S + 100
    new = tr.emit("dns_failed", now[0])
    assert RETENTION_S == 604800
    ids = [e["id"] for e in tr.events(0)]
    assert ids == [new["id"]] and old["id"] not in ids


def test_events_since_filter_includes_open():
    tr = _tr()
    a = tr.emit("dns_failed", T0)
    tr.close("dns_failed", T0 + 10)
    b = tr.emit("internet_lost", T0 + 20)
    assert [e["id"] for e in tr.events(T0 + 15)] == [b["id"]]
    assert [e["id"] for e in tr.events(T0)] == [a["id"], b["id"]]
    assert [e["id"] for e in tr.events(T0 + 1000)] == [b["id"]]


def test_restore_skips_events_that_could_crash_the_collector():
    good = {"id": "dns_failed-1-1", "type": "dns_failed", "at": T0, "until": None, "key": ""}
    junk = [
        {"type": "dns_failed", "at": T0, "until": None},  # no id
        {"id": 5, "type": "dns_failed", "at": T0, "until": None},  # id is not a string
        {"id": "a", "type": "dns_failed", "at": T0, "until": "soon"},  # until is text
        {"id": "b", "type": "dns_failed", "at": T0, "until": float("inf")},
        {"id": "c", "type": "dns_failed", "at": T0, "until": float("nan")},
        {"id": "d", "type": "dns_failed", "at": float("nan"), "until": None},
        {"id": "e", "type": "dns_failed", "at": True, "until": None},
    ]
    tr = ProblemTracker(lambda: T0 + 10, events=junk + [good])
    assert [e["id"] for e in tr.events(0)] == ["dns_failed-1-1"]
    # the journal stays usable: pruning and closing do not raise
    tr.close("dns_failed", T0 + 20)
    tr.emit("internet_lost", T0 + 30)
    assert [e["type"] for e in tr.events(0)] == ["dns_failed", "internet_lost"]
