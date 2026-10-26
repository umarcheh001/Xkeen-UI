from __future__ import annotations

import copy
import json
import math
import threading
from pathlib import Path

import pytest

from services.system_resources_history import collector as collector_mod
from services.system_resources_history.collector import Collector, parse_net_dev, start_collector, stop_collector
from services.ui_settings import patch_settings

FIXTURES = Path(__file__).parent / "fixtures" / "system_resources_sensors"
T0 = 1_800_000_000.0
ISP = "GigabitEthernet1"
USB = "UsbQmi0"
MBIT = 125_000  # bytes per second at 1 Mbit/s


def fixture_json(router: str, name: str):
    return json.loads((FIXTURES / router / name).read_text(encoding="utf-8"))


class FakeRouter:
    """Everything the collector reads, in memory; one `step()` is five seconds."""

    def __init__(self, router: str = "nc1812", *, with_usb: bool = False):
        self.now = T0
        self.show_interface = fixture_json(router, "rci_show_interface.json")
        self.show_version = fixture_json(router, "rci_show_version.json")
        self.sysnames = {"ISP": "eth3"}
        self.set_lan_speed("1000")  # the fixture has a real 100 Mbit/s port; tests that want it ask for it
        if with_usb:
            self.add_usb()
        self.route_iface = "eth3"
        self.counters: dict[str, list[int]] = {"eth3": [10_000, 5_000], "wwan0": [0, 0]}
        self.rate = {"eth3": (100, 20), "wwan0": (0, 0)}  # Mbit/s down, up
        self.busy, self.idle = 0, 0
        self.busy_share = 0.40
        self.uptime = 100_000.0
        self.internet = {"internet": True, "dns-accessible": True}
        self.rci_down = False
        self.calls: list[str] = []
        self.files: dict[str, str] = {}
        self.thermal_temp = 55_000

    def set_lan_speed(self, speed: str, only: str | None = None) -> None:
        def visit(record):
            if isinstance(record, dict):
                if record.get("type") == "Port" and record.get("speed") and str(record.get("id")) != "GigabitEthernet1/0":
                    if only is None or only in (str(record.get("id")), str(record.get("interface-name"))):
                        record["speed"] = speed
                for child in record.values():
                    visit(child)

        visit(self.show_interface)

    def add_usb(self) -> None:
        self.show_interface[USB] = {
            "id": USB, "interface-name": USB, "type": "UsbQmi", "global": True, "priority": 100,
            "connected": "yes", "description": "Билайн LTE", "defaultgw": False,
        }
        self.sysnames[USB] = "wwan0"

    # -- injected callables -------------------------------------------------
    def clock(self) -> float:
        return self.now

    def rci(self, path: str):
        self.calls.append(path)
        if self.rci_down:
            raise OSError("rci down")
        if path == "show/interface":
            return copy.deepcopy(self.show_interface)
        if path == "show/version":
            return copy.deepcopy(self.show_version)
        if path == "show/internet/status":
            return dict(self.internet)
        if path.startswith("show/interface/system-name?name="):
            return self.sysnames[path.split("=", 1)[1]]
        raise OSError("unknown " + path)

    def reader(self, path: Path) -> str:
        key = path.as_posix()
        if key in self.files:
            return self.files[key]
        if key == "/proc/stat":
            return (
                "cpu  1 2 3 4\n"
                f"cpu0 {self.busy // 2} 0 0 {self.idle // 2} 0 0 0 0 0 0\n"
                f"cpu1 {self.busy - self.busy // 2} 0 0 {self.idle - self.idle // 2} 0 0 0 0 0 0\n"
                "procs_running 3\n"
            )
        if key == "/proc/meminfo":
            return "MemTotal: 1000000 kB\nMemFree: 100000 kB\nMemAvailable: 400000 kB\nBuffers: 0 kB\nCached: 0 kB\n"
        if key == "/proc/uptime":
            return f"{self.uptime} 1.0\n"
        if key == "/proc/net/route":
            return (
                "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
                f"{self.route_iface}\t00000000\t0101A8C0\t0003\t0\t0\t1000\t00000000\t0\t0\t0\n"
            )
        if key == "/proc/net/dev":
            lines = ["Inter-|   Receive", " face |bytes"]
            for name, (rx, tx) in self.counters.items():
                lines.append(f"  {name}: {rx} 1 0 0 0 0 0 0 {tx} 1 0 0 0 0 0 0")
            return "\n".join(lines) + "\n"
        if key == "/sys/class/thermal/thermal_zone0/temp":
            return str(self.thermal_temp)
        if key == "/sys/class/thermal/thermal_zone0/type":
            return "soc_thermal"
        if key == "/proc/swaps":
            return "Filename Type Size Used Priority\n"
        raise FileNotFoundError(key)

    def lister(self, path: Path) -> list[str]:
        if path.as_posix() == "/sys/class/thermal":
            return ["thermal_zone0"]
        return []

    def step(self, c: Collector, n: int = 1) -> None:
        for _ in range(n):
            self.now += 5
            for name, (down, up) in self.rate.items():
                self.counters[name][0] += down * MBIT * 5
                self.counters[name][1] += up * MBIT * 5
            share = self.busy_share
            self.busy += int(share * 1000)
            self.idle += int((1 - share) * 1000)
            c.tick()


def make(tmp_path, router: FakeRouter, **kw) -> Collector:
    return Collector(
        str(tmp_path / "state"),
        reader=router.reader,
        clock=router.clock,
        sleeper=lambda s: None,
        rci=router.rci,
        tmp_dir=str(tmp_path / "tmp"),
        lister=router.lister,
        **kw,
    )


def tariffs(tmp_path, data: dict) -> None:
    patch_settings({"diagnostics": {"tariffs": data}}, str(tmp_path / "state"))


def series(c: Collector, metric: str, range_id: str = "15m"):
    cols = c.history(range_id)["metrics"][metric]
    return cols["avg"]


def test_parse_net_dev_reads_rx_and_tx():
    text = (FIXTURES / "nc1812" / "net_dev").read_text(encoding="utf-8")
    counters = parse_net_dev(text)
    assert counters["br0"] == (439929519, 1781745214)
    assert all(isinstance(v, tuple) and len(v) == 2 for v in counters.values())


def test_tick_records_all_metrics(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    tariffs(tmp_path, {ISP: {"up_mbps": 100, "down_mbps": 400}})
    c.refresh_tariffs()
    r.step(c, 13)
    snap = c.snapshot()
    values = snap["values"]
    assert values["cpu"] == pytest.approx(40.0, abs=1)
    assert values["memory"] == pytest.approx(60.0)
    assert values["queue"] == 2.0
    assert values["online"] == 1.0
    assert values[f"rate_down:{ISP}"] == pytest.approx(100.0)
    assert values[f"rate_up:{ISP}"] == pytest.approx(20.0)
    assert values[f"link_down:{ISP}"] == pytest.approx(25.0)
    assert values[f"link_up:{ISP}"] == pytest.approx(20.0)
    assert values["temp:soc"] == pytest.approx(55.0)
    assert snap["zones"]["cpu"] == 0 and snap["zones"][f"link_down:{ISP}"] == 0
    assert snap["primary"] == ISP
    hist = c.history("15m")
    for metric in values:
        assert any(v is not None for v in hist["metrics"][metric]["avg"]), metric
    assert hist["zones"]["cpu"]["avg"][-1] in (0, None)
    assert "rate_down:" + ISP not in hist["zones"]


def test_first_sample_is_no_data_not_idle(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c)
    assert c.snapshot()["values"]["cpu"] is None
    assert c.snapshot()["values"][f"rate_down:{ISP}"] is None
    r.step(c)
    assert c.snapshot()["values"]["cpu"] is not None


def test_counter_reset_skips_point(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 4)
    assert c.snapshot()["values"][f"rate_down:{ISP}"] == pytest.approx(100.0)
    r.counters["eth3"] = [50, 10]  # the counter went down: reconnect / reset
    r.step(c)
    values = c.snapshot()["values"]
    assert values[f"rate_down:{ISP}"] is None and values[f"rate_up:{ISP}"] is None
    assert values[f"link_down:{ISP}"] is None
    r.step(c)  # the next sample goes on from the new baseline
    assert c.snapshot()["values"][f"rate_down:{ISP}"] == pytest.approx(100.0)
    for metric, cols in c.history("15m")["metrics"].items():
        if metric.startswith(("rate_", "link_")):
            assert all(v is None or v >= 0 for v in cols["avg"] + cols["max"]), metric


def test_wan_change_skips_point(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 11)  # the 60 s refresh comes with the 13th tick
    # the provider session came back under another kernel name; its counter is far
    # above the old one, so only the name change keeps a spike of thousands of percent out
    r.sysnames["ISP"] = "ppp0"
    r.show_interface[ISP]["connected"] = "no"
    r.counters["ppp0"] = [10**12, 10**12]
    r.rate["ppp0"] = (100, 20)
    r.route_iface = "ppp0"
    r.step(c)
    r.step(c)  # tick 13: list changed, name re-read
    assert c.snapshot()["values"][f"rate_down:{ISP}"] is None
    r.step(c)
    assert c.snapshot()["values"][f"rate_down:{ISP}"] == pytest.approx(100.0)


def test_two_connections_each_own_series_and_tariff(tmp_path):
    r = FakeRouter(with_usb=True)
    r.rate["wwan0"] = (10, 2)
    c = make(tmp_path, r)
    tariffs(tmp_path, {ISP: {"up_mbps": 200, "down_mbps": 200}})
    c.refresh_tariffs()
    r.step(c, 4)
    values = c.snapshot()["values"]
    assert values[f"rate_down:{ISP}"] == pytest.approx(100.0)
    assert values[f"rate_down:{USB}"] == pytest.approx(10.0)
    assert values[f"rate_up:{USB}"] == pytest.approx(2.0)
    assert values[f"link_down:{ISP}"] == pytest.approx(50.0)
    assert values[f"link_down:{USB}"] is None and values[f"link_up:{USB}"] is None
    links = {link["id"]: link for link in c.snapshot()["links"]}
    assert links[ISP]["primary"] is True and links[USB]["primary"] is False
    assert links[USB]["tariff"] == {"up_mbps": None, "down_mbps": None}
    assert links[USB]["label"] == "Билайн LTE" and links[USB]["kernel"] == "wwan0"
    assert {m for m in c.history("15m")["metrics"] if m.endswith(USB)} == {
        f"{p}:{USB}" for p in ("rate_up", "rate_down", "link_up", "link_down")
    }


def test_no_tariff_link_none(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 4)
    values = c.snapshot()["values"]
    assert values[f"rate_down:{ISP}"] == pytest.approx(100.0)
    assert values[f"link_down:{ISP}"] is None and values[f"link_up:{ISP}"] is None
    assert all(v is None for v in series(c, f"link_down:{ISP}"))
    assert c.events(0) == []


def test_failover_event_and_primary_switch(tmp_path):
    r = FakeRouter(with_usb=True)
    c = make(tmp_path, r)
    r.step(c, 3)
    assert c.snapshot()["primary"] == ISP and not c.events(0)
    r.route_iface = "wwan0"
    r.step(c)
    assert c.snapshot()["primary"] == USB
    (event,) = c.events(0)
    assert event["type"] == "wan_failover" and event["until"] is None
    assert event["title"] == "Интернет переключился на резервное подключение Билайн LTE"
    r.step(c, 5)
    r.route_iface = "eth3"
    r.step(c)
    assert c.snapshot()["primary"] == ISP
    (event,) = c.events(0)
    assert event["until"] is not None and event["until"] - event["at"] == pytest.approx(30.0)
    assert not [p for p in c.snapshot()["problems"] if p["type"] == "wan_failover"]


def test_no_default_route_keeps_state(tmp_path):
    r = FakeRouter(with_usb=True)
    c = make(tmp_path, r)
    r.step(c, 3)
    r.route_iface = "tun0"  # not one of the internet connections
    r.step(c, 2)
    assert c.snapshot()["primary"] == ISP and not c.events(0)


def test_new_connection_adds_metrics_without_losing_history(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 12)
    before = [v for v in series(c, "cpu") if v is not None]
    assert before and f"rate_down:{USB}" not in c.history("15m")["metrics"]
    r.add_usb()  # the firmware shows a second connection
    r.rate["wwan0"] = (10, 1)
    r.step(c, 2)  # tick 13 reads the list again
    metrics = c.history("15m")["metrics"]
    assert f"rate_down:{USB}" in metrics and f"link_up:{USB}" in metrics
    cpu = metrics["cpu"]["avg"]
    assert [v for v in cpu if v is not None][: len(before) - 1] == before[:-1]
    assert all(v is None for v in metrics[f"rate_down:{USB}"]["avg"][:-2])  # NaN back in time
    r.step(c, 3)
    assert c.snapshot()["values"][f"rate_down:{USB}"] == pytest.approx(10.0)


def test_rci_every_60s_not_every_tick(tmp_path):
    r = FakeRouter(with_usb=True)
    c = make(tmp_path, r)
    r.step(c, 24)  # two minutes
    assert r.calls.count("show/interface") == 2  # ticks 1 and 13
    assert r.calls.count("show/internet/status") == 4  # every 30 s
    assert r.calls.count("show/version") == 1  # asked until it answered
    system_names = [p for p in r.calls if p.startswith("show/interface/system-name")]
    assert len(system_names) == 2  # one per connection, cached while the list is unchanged


def test_rci_down_keeps_proc_metrics(tmp_path):
    r = FakeRouter()
    r.rci_down = True
    c = make(tmp_path, r)
    r.step(c, 4)
    values = c.snapshot()["values"]
    assert values["cpu"] is not None and values["memory"] is not None
    assert values["online"] is None and c.events(0) == []


def test_internet_and_dns_events(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 2)
    r.internet = {"internet": False, "dns-accessible": False}
    r.step(c, 6)
    assert [e["type"] for e in c.events(0)] == ["internet_lost"]
    r.internet = {"internet": True, "dns-accessible": False}
    r.step(c, 6)
    types = [e["type"] for e in c.events(0)]
    assert types == ["internet_lost", "internet_restored", "dns_failed"]
    assert c.events(0)[0]["until"] is not None
    r.internet = {"internet": True, "dns-accessible": True}
    r.step(c, 6)
    assert all(e["until"] is not None for e in c.events(0))


def test_throttle_and_slow_port_events(tmp_path):
    r = FakeRouter()
    r.files["/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"] = "1000000"
    r.files["/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq"] = "1350000"
    c = make(tmp_path, r)
    r.step(c, 2)
    assert [e["type"] for e in c.events(0)] == ["cpu_throttled"]
    r.files["/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"] = "1350000"
    r.step(c, 12)
    assert c.events(0)[0]["until"] is not None


def test_red_cpu_for_three_minutes_makes_a_problem(tmp_path):
    r = FakeRouter()
    r.busy_share = 0.95
    c = make(tmp_path, r)
    r.step(c, 30)  # 150 s
    assert not c.snapshot()["problems"]
    r.step(c, 10)
    assert [p["type"] for p in c.snapshot()["problems"]] == ["cpu_overload"]


def test_link_problem_follows_only_the_primary_connection(tmp_path):
    r = FakeRouter(with_usb=True)
    r.rate["wwan0"] = (95, 0)
    r.rate["eth3"] = (10, 0)
    c = make(tmp_path, r)
    tariffs(tmp_path, {ISP: {"down_mbps": 100}, USB: {"down_mbps": 100}})
    c.refresh_tariffs()
    r.step(c, 50)
    assert c.snapshot()["zones"][f"link_down:{USB}"] == 2
    assert not [p for p in c.snapshot()["problems"] if p["type"] == "link_saturated"]
    r.rate["eth3"] = (95, 0)
    r.step(c, 40)
    assert [p["key"] for p in c.snapshot()["problems"] if p["type"] == "link_saturated"] == ["link_down"]


def test_hardware_has_chip_wide_shutdown_and_identity(tmp_path):
    r = FakeRouter()
    r.files["/sys/class/thermal/thermal_zone0/trip_point_0_temp"] = "125000"
    r.files["/sys/class/thermal/thermal_zone0/trip_point_0_type"] = "critical"
    r.lister = lambda path: ["thermal_zone0", "thermal_zone1"] if path.as_posix() == "/sys/class/thermal" else (
        ["trip_point_0_temp", "trip_point_0_type"] if path.name == "thermal_zone0" else []
    )
    r.files["/sys/class/thermal/thermal_zone1/temp"] = "50000"
    r.files["/sys/class/thermal/thermal_zone1/type"] = "mcusys_thermal0"
    c = make(tmp_path, r)
    r.step(c, 2)
    hard = c.hardware()
    assert hard["model"] and hard["firmware"].startswith("KeeneticOS")
    by_id = {t["id"]: t for t in hard["temperatures"]}
    assert by_id["cpu"]["shutdown_c"] == 125.0  # the zone without its own trip gets the chip-wide one
    assert by_id["soc"]["shutdown_c"] == 125.0
    assert hard["cores"] == 2 and [p["id"] for p in hard["ports"]][0] == "WAN"


def test_saves_tmp_every_300s_and_flash_every_21600s(tmp_path, monkeypatch):
    saved: list[str] = []
    real = collector_mod.save_history

    def spy(path, *args, **kwargs):
        saved.append(Path(path).parent.name)
        return real(path, *args, **kwargs)

    monkeypatch.setattr(collector_mod, "save_history", spy)
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 59)  # 295 s
    assert saved == []
    r.step(c)  # 300 s
    assert saved == ["tmp"]
    r.step(c, 59)
    assert saved == ["tmp"]
    r.step(c)
    assert saved == ["tmp", "tmp"]
    r.now += 21_000  # panel asleep for hours
    r.step(c)
    assert sorted(saved[2:]) == ["state", "tmp"]  # both copies are due after the long sleep
    assert (tmp_path / "state" / "resource-history.json").is_file()
    assert (tmp_path / "tmp" / "resource-history.json").is_file()
    flash_count = saved.count("state")
    r.step(c, 5)
    assert saved.count("state") == flash_count  # not again within six hours


def test_save_failure_does_not_stop_sampling(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(collector_mod, "save_history", boom)
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 70)
    assert c.snapshot()["values"]["memory"] is not None


def test_restores_and_marks_gap_on_start(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 24)
    c._tracker.emit("dns_failed", r.now)
    c.save("tmp")
    last_ts = r.now

    r2 = FakeRouter()
    r2.now = last_ts + 600  # ten minutes with the panel stopped
    r2.uptime = 100_000.0 + 600
    c2 = make(tmp_path, r2)
    assert c2.snapshot()["restored_gap_s"] == pytest.approx(600.0)
    assert [e["type"] for e in c2.events(0)] == ["dns_failed"]
    r2.step(c2, 3)
    cpu = c2.history("1h")["metrics"]["cpu"]["avg"]
    assert any(v is not None for v in cpu)  # old data is there
    tail = cpu[-60:]
    first = next(i for i, v in enumerate(tail) if v is not None)
    last_before_gap = max(i for i, v in enumerate(tail[:-4]) if v is not None)
    assert first <= last_before_gap
    assert all(v is None for v in tail[last_before_gap + 1 : -3])  # the stopped time is a gap, not zeros
    assert not [e for e in c2.events(0) if e["type"] == "router_rebooted"]


def test_restart_after_reboot_marks_router_rebooted(tmp_path):
    r = FakeRouter()
    r.uptime = 90_000.0
    c = make(tmp_path, r)
    r.step(c, 3)
    c.save("tmp")
    r2 = FakeRouter()
    r2.now = r.now + 400
    r2.uptime = 800.0  # smaller than the saved one: the router restarted
    c2 = make(tmp_path, r2)
    assert [e["type"] for e in c2.events(0)] == ["router_rebooted"]


def test_saved_copy_from_the_future_gives_no_negative_gap(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 5)
    c.save("tmp")
    r2 = FakeRouter()
    r2.now = r.now - 7200  # the clock was wrong while saving
    c2 = make(tmp_path, r2)
    assert c2.snapshot()["restored_gap_s"] == 0.0
    r2.step(c2, 3)  # does not raise
    assert c2.snapshot()["values"]["memory"] is not None


def test_metric_absent_on_first_tick_after_restore_keeps_its_history(tmp_path):
    r = FakeRouter(with_usb=True)
    r.rate["wwan0"] = (10, 2)
    c = make(tmp_path, r)
    r.step(c, 6)
    c.save("tmp")
    r2 = FakeRouter()  # the modem is not in the list on the first look (flapping, not up yet)
    r2.now = r.now + 15
    c2 = make(tmp_path, r2)
    r2.step(c2, 3)
    metrics = c2.history("15m")["metrics"]
    assert any(v is not None for v in metrics[f"rate_down:{USB}"]["avg"])  # restored data survives
    assert metrics[f"rate_down:{USB}"]["avg"][-1] is None  # and is fed "no data" meanwhile
    assert f"rate_down:{ISP}" in metrics
    # the modem comes back: the same series goes on
    r3 = r2
    r3.add_usb()
    r3.rate["wwan0"] = (10, 2)
    r3.step(c2, 13)
    assert c2.snapshot()["values"][f"rate_down:{USB}"] == pytest.approx(10.0)


def test_snapshot_does_not_wait_for_a_slow_rci(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 2)
    gate, entered = threading.Event(), threading.Event()
    real = r.rci

    def slow_rci(path):
        if path == "show/internet/status":
            entered.set()
            gate.wait(5)
        return real(path)

    c._rci_fetch = slow_rci
    r.now += 5
    c._n = 6  # the next tick is a 30 s one
    ticker = threading.Thread(target=c.tick)
    ticker.start()
    try:
        assert entered.wait(2)
        result: list = []
        reader = threading.Thread(target=lambda: result.append((c.snapshot(), c.history("15m"), c.events(0))))
        reader.start()
        reader.join(2)
        assert not reader.is_alive() and result, "snapshot() was blocked by the RCI call"
    finally:
        gate.set()
        ticker.join(5)


def test_save_writes_outside_the_lock(tmp_path, monkeypatch):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 3)
    other = []
    t = threading.Thread(target=lambda: other.append(c._lock.acquire(blocking=False)))

    def spy2(path, store, events, **kwargs):
        t.start()
        t.join(2)

    monkeypatch.setattr(collector_mod, "save_history", spy2)
    c.save("tmp")
    assert other == [True]  # another thread could take the lock while the file was written


@pytest.mark.parametrize("target", ["internet_connections", "parse_ports", "wifi_temperatures", "router_identity"])
def test_a_raising_parser_does_not_cost_the_tick(tmp_path, monkeypatch, target):
    def boom(*a, **k):
        raise ValueError("parser broke")

    monkeypatch.setattr(collector_mod.hw, target, boom)
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 4)
    values = c.snapshot()["values"]
    assert values["cpu"] is not None and values["memory"] is not None


@pytest.mark.parametrize(
    "owner,name",
    [(collector_mod, "sample_conntrack"), (collector_mod, "normalize_internet_status"),
     (collector_mod.sensors, "zram_state"), (collector_mod.sensors, "cpu_frequency")],
)
def test_a_raising_refresh_step_does_not_cost_the_tick(tmp_path, monkeypatch, owner, name):
    def boom(*a, **k):
        raise ValueError("broke")

    monkeypatch.setattr(owner, name, boom)
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 4)
    values = c.snapshot()["values"]
    assert values["cpu"] is not None and values["memory"] is not None


def test_garbage_saved_file_does_not_break_start(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    (state / "resource-history.json").write_text("{not json", encoding="utf-8")
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 3)
    assert c.snapshot()["values"]["memory"] is not None


def test_history_zones_are_computed_per_column(tmp_path):
    r = FakeRouter()
    r.busy_share = 0.9
    c = make(tmp_path, r)
    r.step(c, 13)
    hist = c.history("15m")
    zones = [z for z in hist["zones"]["cpu"]["avg"] if z is not None]
    assert zones and set(zones) == {2}
    assert len(hist["zones"]["cpu"]["avg"]) == len(hist["metrics"]["cpu"]["avg"])
    assert not any(math.isnan(v) for v in hist["metrics"]["cpu"]["avg"] if v is not None)


def test_start_twice_one_thread(tmp_path, monkeypatch):
    release = threading.Event()
    monkeypatch.setattr(Collector, "_run", lambda self: release.wait(5))
    monkeypatch.setattr(collector_mod, "TMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setattr(collector_mod.atexit, "register", lambda fn: None)
    state = str(tmp_path / "state")
    try:
        first = start_collector(ui_state_dir=state)
        second = start_collector(ui_state_dir=state)
        assert first is second and collector_mod.get_collector() is first
        threads = [t for t in threading.enumerate() if t.name == "xkeen-resource-history"]
        assert len(threads) == 1 and threads[0].daemon
    finally:
        release.set()
        stop_collector()
    assert collector_mod.get_collector() is None
    assert (tmp_path / "state" / "resource-history.json").is_file()  # a stop saves to flash


def test_slow_port_event_opens_and_closes(tmp_path):
    r = FakeRouter()
    r.set_lan_speed("100", only="4")
    c = make(tmp_path, r)
    r.step(c, 2)
    (event,) = c.events(0)
    assert event["type"] == "port_slow" and event["key"] == "4" and event["until"] is None
    assert event["title"] == "Порт 4 работает на 100 Мбит/с"
    r.set_lan_speed("1000")
    r.step(c, 12)
    assert c.events(0)[0]["until"] is not None
