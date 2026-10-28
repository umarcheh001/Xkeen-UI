from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "xkeen-ui"))


def test_rebase_process_leaders_keeps_values_in_new_calendar_window():
    from services.system_resources_history.top_procs import TopStore
    store = TopStore()
    store.add(1_800_000_000, {"xray": 25.0})
    store.add(1_800_000_060, {"xray": 50.0})
    store.rebase_time(3600, since=1_800_000_000)
    assert store.columns(60, 1_800_003_600, 2) == [[["xray", 25.0]], [["xray", 50.0]]]
    assert store.columns(60, 1_800_000_000, 2) == [None, None]


def test_rebase_process_open_point_follows_actual_last_scan():
    from services.system_resources_history.top_procs import TopStore
    store = TopStore()
    store.add(1021, {"a": 10})
    store.add(1079, {"b": 20})
    store.rebase_time(62, since=1021)
    assert store.columns(60, 1140, 1) == [[["b", 10.0], ["a", 5.0]]]


def test_rebase_process_points_merge_when_partial_intervals_coincide():
    from services.system_resources_history.top_procs import TopStore
    store = TopStore()
    store.add(1079, {"a": 10})
    store.add(1081, {"b": 20})
    store.rebase_time(3, since=1079)
    assert store.columns(60, 1080, 1) == [[["b", 10.0], ["a", 5.0]]]
    store.rebase_time(0, since=1082)
    assert store.columns(60, 1080, 1) == [[["b", 10.0], ["a", 5.0]]]

from services.system_resources_history.top_procs import (  # noqa: E402
    TopStore,
    cpu_shares,
    leaders_text,
    parse_pid_stat,
    process_name,
    scan_processes,
    total_ticks,
)

T0 = 1_000_000 * 1800  # aligned to every tier step


def stat_line(pid: int, comm: str, utime: int, stime: int) -> str:
    return f"{pid} ({comm}) S 1 1 1 0 -1 4194560 100 0 0 0 {utime} {stime} 0 0 20 0 1 0 100 1000 200"


def test_parse_pid_stat_reads_name_and_ticks():
    assert parse_pid_stat(stat_line(42, "xray", 100, 23)) == ("xray", 123)
    # a name with spaces and brackets: the last ")" ends it
    assert parse_pid_stat(stat_line(7, "my (odd) name", 1, 2)) == ("my (odd) name", 3)
    assert parse_pid_stat("garbage") is None
    assert parse_pid_stat("") is None


def test_process_name_folds_kernel_thread_numbers():
    assert process_name("ksoftirqd/0") == "ksoftirqd"
    assert process_name("kworker/u4:2") == "kworker"
    assert process_name("xray") == "xray"
    assert process_name("  ") == "?"


def test_total_ticks_sums_the_cores():
    stat = "cpu  10 0 10 80\ncpu0 5 0 5 40 0 0 0 0 0 0\ncpu1 5 0 5 40 0 0 0 0 0 0\nintr 1\n"
    assert total_ticks(stat) == 100
    assert total_ticks("cpu  10 0 10 80\n") == 100  # one core: only the summary line
    assert total_ticks("") is None


def test_scan_processes_skips_vanished_and_non_pid_entries():
    files = {
        "/proc/1/stat": stat_line(1, "init", 1, 1),
        "/proc/42/stat": stat_line(42, "xray", 300, 100),
    }

    def reader(path):
        try:
            return files[path.as_posix()]
        except KeyError:
            raise FileNotFoundError(path) from None

    got = scan_processes(reader, lambda path: ["1", "42", "77", "self", "net"])
    assert got == {1: ("init", 2), 42: ("xray", 400)}


def test_cpu_shares_are_parts_of_the_whole_processor_grouped_by_name():
    prev = {1: ("xray", 100), 2: ("ksoftirqd/0", 10), 3: ("ksoftirqd/1", 10), 4: ("sh", 5)}
    cur = {1: ("xray", 140), 2: ("ksoftirqd/0", 15), 3: ("ksoftirqd/1", 20), 5: ("new", 50)}
    shares = cpu_shares(prev, cur, 100)
    assert shares == {"xray": pytest.approx(40.0), "ksoftirqd": pytest.approx(15.0)}
    # a pid reused by another program, a counter that went back, no time: no share
    assert cpu_shares({1: ("a", 10)}, {1: ("b", 50)}, 100) == {}
    assert cpu_shares({1: ("a", 10)}, {1: ("a", 5)}, 100) == {}
    assert cpu_shares(prev, cur, 0) == {}


def test_top_store_minute_columns_and_folding():
    s = TopStore()
    s.add(T0, {"xray": 40.0, "ndm": 2.0})
    s.add(T0 + 60, {"xray": 20.0, "ksoftirqd": 30.0})
    # 1 h columns are minutes
    cols = s.columns(60, T0, 2)
    assert cols[0] == [["xray", 40.0], ["ndm", 2.0]]
    assert cols[1] == [["ksoftirqd", 30.0], ["xray", 20.0]]
    # a 15 s column takes the minute it lies in
    assert s.columns(15, T0 + 60 + 30, 1) == [[["ksoftirqd", 30.0], ["xray", 20.0]]]
    # a 2-minute column averages over the minutes with data
    (two,) = s.columns(120, T0, 1)
    assert two[0] == ["xray", 30.0] and two[1] == ["ksoftirqd", 15.0] and two[2] == ["ndm", 1.0]


def test_top_store_long_tiers_and_gaps():
    s = TopStore()
    for k in range(10):  # ten minutes of one leader
        s.add(T0 + 60 * k, {"xray": 50.0})
    cols = s.columns(300, T0, 3)
    assert cols[0] == [["xray", 50.0]] and cols[1] == [["xray", 50.0]]
    assert cols[2] is None  # no data is not "nobody"
    assert s.columns(1800, T0, 1) == [[["xray", 50.0]]]
    assert s.columns(900, T0 - 3600, 1) == [None]


def test_top_store_keeps_at_most_the_leaders():
    s = TopStore()
    s.add(T0, {f"p{i}": float(i) for i in range(20)})
    (col,) = s.columns(60, T0, 1)
    assert [name for name, _ in col] == ["p19", "p18", "p17"]


def test_top_store_ignores_tiny_shares():
    s = TopStore()
    s.add(T0, {"xray": 0.2})
    assert s.columns(60, T0, 1) == [[]]  # the minute was measured: nobody worth a line


def test_top_store_window_for_an_event():
    s = TopStore()
    for k in range(6):
        s.add(T0 + 60 * k, {"xray": 60.0 if k >= 2 else 5.0, "ndm": 3.0})
    assert s.window(T0 + 120, T0 + 360)[0] == ["xray", 60.0]
    long = TopStore()
    for k in range(3 * 60):  # three hours: older than the minute tier
        long.add(T0 + 60 * k, {"xray": 70.0})
    assert long.window(T0, T0 + 3 * 3600)[0] == ["xray", 70.0]


def test_top_store_roundtrip_and_bad_data():
    s = TopStore()
    s.add(T0, {"xray": 40.0})
    s.add(T0 + 60, {"ndm": 4.0})
    r = TopStore.from_dict(json.loads(json.dumps(s.to_dict())))
    assert r.columns(60, T0, 2) == s.columns(60, T0, 2)
    for bad in (None, "x", {"version": 99}, {"version": 1, "tiers": {"minute": {"starts": [1]}}}):
        assert TopStore.from_dict(bad).columns(60, T0, 1) == [None]


def test_leaders_text():
    assert leaders_text([["xray", 62.4], ["ndm", 3.0]]) == "xray 62 % · ndm 3 %"
    assert leaders_text([]) == ""
    assert leaders_text(None) == ""
