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


def test_network_card_has_40_individual_five_second_samples(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    tariffs(tmp_path, {ISP: {'up_mbps': 500, 'down_mbps': 500}})
    c.refresh_tariffs()
    r.step(c, 42)
    r.rate['eth3'] = (20, 0)
    r.step(c)
    r.rate['eth3'] = (0, 0)
    r.step(c)
    bars = c.snapshot()['cards']['link']['bars']
    assert len(bars['down']['values']) == 40
    assert bars['down']['values'][-3:] == pytest.approx([20, 4, 0])
    assert bars['step_s'] == 5
    assert len(c.snapshot()['cards']['cpu']['bars']['values']) == 40


def test_network_card_keeps_gaps_and_clears_backwards_clock(tmp_path):
    r = FakeRouter(); c = make(tmp_path, r)
    r.step(c, 4)
    r.now += 10
    r.step(c)
    values = c.snapshot()['cards']['link']['bars']['down']['values']
    assert values[-3:-1] == [None, None]
    r.now -= 600
    r.step(c)
    values = c.snapshot()['cards']['link']['bars']['down']['values']
    assert all(v is None for v in values[:-1])


def test_network_card_duplicate_time_slot_keeps_earlier_samples(tmp_path):
    r = FakeRouter(); c = make(tmp_path, r)
    r.step(c, 4)
    c.tick()
    values = c.snapshot()['cards']['link']['bars']['down']['values']
    assert values[-3:-1] == [100, 100]


def test_network_card_keeps_latest_sample_when_http_poll_crosses_slot_boundary(tmp_path):
    r = FakeRouter(); r.now += 4.5
    c = make(tmp_path, r)
    r.step(c, 4)
    r.now += 1
    assert c.snapshot()['cards']['link']['bars']['down']['values'][-1] == 100


@pytest.mark.parametrize('kind', ['tmp', 'flash'])
def test_network_card_restores_samples_but_not_restart_gap_or_first_rate(tmp_path, kind):
    r = FakeRouter(); c = make(tmp_path, r)
    r.step(c, 4)
    r.rate['eth3'] = (20, 0)
    r.step(c)
    c.save(kind)
    r.now += 10
    r.uptime += 10
    restarted = make(tmp_path, r)
    r.step(restarted)
    values = restarted.snapshot()['cards']['link']['bars']['down']['values']
    assert values[-6:] == [100, 100, 20, None, None, None]
    r.step(restarted)
    assert restarted.snapshot()['cards']['link']['bars']['down']['values'][-1] == 20


def test_network_card_old_copy_does_not_fill_recent_window(tmp_path):
    r = FakeRouter(); c = make(tmp_path, r)
    r.step(c, 4)
    c.save('tmp')
    r.now += 300
    restarted = make(tmp_path, r)
    r.step(restarted)
    assert restarted.snapshot()['cards']['link']['bars']['down']['values'] == [None] * 40


def test_network_card_malformed_metadata_keeps_valid_history(tmp_path):
    r = FakeRouter(); c = make(tmp_path, r)
    r.step(c, 4)
    c.save('tmp')
    path = tmp_path / 'tmp' / 'resource-history.json'
    payload = json.loads(path.read_text(encoding='utf-8'))
    payload['meta']['network_recent'] = [
        None, [True, {}], ['bad', {}], [r.now, []],
        [r.now + 5, {f'rate_down:{ISP}': 999}],
        [r.now, {f'rate_down:{ISP}': 20, f'rate_up:{ISP}': True,
                 'cpu': 999, f'link_down:{ISP}': -5}],
    ]
    path.write_text(json.dumps(payload), encoding='utf-8')
    restarted = make(tmp_path, r)
    r.step(restarted)
    bars = restarted.snapshot()['cards']['link']['bars']
    assert bars['down']['values'][-2:] == [20, None]
    assert bars['up']['values'][-2:] == [None, None]
    assert any(v is not None for v in series(restarted, 'cpu'))


@pytest.mark.parametrize('raw', [None, {}, 'broken'])
def test_network_card_legacy_or_invalid_metadata_keeps_main_history(tmp_path, raw):
    r = FakeRouter(); c = make(tmp_path, r)
    r.step(c, 4)
    c.save('tmp')
    path = tmp_path / 'tmp' / 'resource-history.json'
    payload = json.loads(path.read_text(encoding='utf-8'))
    payload['meta']['network_recent'] = raw
    path.write_text(json.dumps(payload), encoding='utf-8')
    restarted = make(tmp_path, r)
    r.step(restarted)
    assert restarted.snapshot()['cards']['link']['bars']['down']['values'] == [None] * 40
    assert any(v is not None for v in series(restarted, 'cpu'))


@pytest.mark.parametrize('correction', [-600, 600])
def test_network_card_restart_rebases_cold_boot_samples_with_ntp(tmp_path, correction):
    r = FakeRouter()
    r.uptime = 40
    r.files['/proc/sys/kernel/random/boot_id'] = 'cold-network-boot'
    c = make(tmp_path, r)
    for _ in range(4):
        r.uptime += 5
        r.step(c)
    c.save('flash')
    r.now += correction + 10
    r.uptime += 10
    restarted = make(tmp_path, r)
    r.uptime += 5
    r.step(restarted)
    assert restarted.snapshot()['cards']['link']['bars']['down']['values'][-6:] == [
        100, 100, 100, None, None, None,
    ]


@pytest.mark.parametrize('sample', [
    [10**400, {}], [T0 + 20, {f'rate_down:{ISP}': 10**400}],
])
def test_network_card_oversized_json_number_does_not_break_start(tmp_path, sample):
    r = FakeRouter(); c = make(tmp_path, r)
    r.step(c, 4)
    c.save('tmp')
    path = tmp_path / 'tmp' / 'resource-history.json'
    payload = json.loads(path.read_text(encoding='utf-8'))
    payload['meta']['network_recent'] = [sample]
    path.write_text(json.dumps(payload), encoding='utf-8')
    restarted = make(tmp_path, r)
    r.step(restarted)
    assert restarted.snapshot()['cards']['link']['bars']['down']['values'] == [None] * 40
    assert any(v is not None for v in series(restarted, 'cpu'))


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
    assert values["temp:cpu"] == pytest.approx(55.0)
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
    switched_at = r.now
    assert c.snapshot()["primary"] == USB
    assert not c.events(0)  # a switch has to hold for a minute before it is an event
    r.step(c, 12)
    (event,) = c.events(0)
    assert event["type"] == "wan_failover" and event["until"] is None
    assert event["at"] == switched_at
    assert event["title"] == "Интернет переключился на резервное подключение Билайн LTE"
    r.step(c, 5)
    r.route_iface = "eth3"
    r.step(c)
    assert c.snapshot()["primary"] == ISP
    (event,) = c.events(0)
    assert event["until"] is not None and event["until"] - event["at"] == pytest.approx(90.0)
    assert not [p for p in c.snapshot()["problems"] if p["type"] == "wan_failover"]


def test_a_flapping_route_makes_no_failover_events(tmp_path):
    r = FakeRouter(with_usb=True)
    c = make(tmp_path, r)
    r.step(c, 3)
    for _ in range(10):
        r.route_iface = "wwan0"
        r.step(c, 4)  # 20 s on the reserve
        r.route_iface = "eth3"
        r.step(c, 4)
    assert c.events(0) == []


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


@pytest.mark.parametrize("router", ["nc1812", "kn1811"])
def test_reboot_waits_for_first_internet_without_red_bars_or_recovery(tmp_path, router):
    r = FakeRouter(router)
    c = make(tmp_path, r)
    r.step(c, 24)
    c.save("flash")
    since = c.history("7d")["history_since"]
    r.uptime = 40.0
    r.internet = {"internet": False, "dns-accessible": False}
    restarted = make(tmp_path, r)
    r.step(restarted, 6)
    snap = restarted.snapshot()
    assert snap["values"]["online"] is None
    assert snap["cards"]["internet"]["state"] is None
    assert 0.0 not in series(restarted, "online")
    assert not [e for e in restarted.events(0) if e["type"] in ("internet_lost", "internet_restored", "dns_failed")]

    r.uptime = 70.0
    r.internet = {"internet": True, "dns-accessible": True}
    r.step(restarted, 6)
    assert restarted.snapshot()["cards"]["internet"]["state"] == "online"
    assert restarted.snapshot()["values"]["online"] == 1.0
    assert not [e for e in restarted.events(0) if e["type"] in ("internet_lost", "internet_restored")]
    assert restarted.history("7d")["history_since"] == since
    assert "без перерывов 2 мин" in restarted.snapshot()["cards"]["internet"]["text"]


@pytest.mark.parametrize("uptime, expected", [(119.0, None), (120.0, 0.0), (1000.0, 0.0), (None, 0.0)])
def test_internet_startup_grace_ends_at_router_uptime_120(tmp_path, uptime, expected):
    r = FakeRouter()
    if uptime is None:
        r.files["/proc/uptime"] = ""
    else:
        r.uptime = uptime
    r.internet = {"internet": False, "dns-accessible": False}
    c = make(tmp_path, r)
    r.step(c)
    assert c.snapshot()["values"]["online"] == expected
    lost = [e for e in c.events(0) if e["type"] == "internet_lost"]
    assert len(lost) == (0 if expected is None else 1)


def test_internet_startup_timeout_reports_only_confirmed_failure_after_deadline(tmp_path):
    r = FakeRouter()
    r.uptime = 90.0
    r.internet = {"internet": False}
    c = make(tmp_path, r)
    r.step(c, 6)
    r.uptime = 120.0
    r.step(c, 6)
    (lost,) = [e for e in c.events(0) if e["type"] == "internet_lost"]
    assert lost["at"] == T0 + 35
    assert c.snapshot()["values"]["online"] == 0.0
    online_before = list(series(c, "online"))
    assert None in online_before and 0.0 in online_before
    r.internet = {"internet": True, "dns-accessible": True}
    r.uptime = 150.0
    r.step(c, 6)
    (lost,) = [e for e in c.events(0) if e["type"] == "internet_lost"]
    assert lost["until"] == T0 + 65
    assert len([e for e in c.events(0) if e["type"] == "internet_restored"]) == 1
    assert c.snapshot()["cards"]["internet"]["state"] == "online"


def test_real_internet_loss_after_first_success_is_not_hidden_during_startup(tmp_path):
    r = FakeRouter()
    r.uptime = 30.0
    c = make(tmp_path, r)
    r.step(c, 6)
    r.uptime = 60.0
    r.internet = {"internet": False}
    r.step(c, 6)
    assert c.snapshot()["values"]["online"] == 0.0
    assert [e["type"] for e in c.events(0)].count("internet_lost") == 1


@pytest.mark.parametrize("next_boot_id, expected", [("boot-a", 0.0), ("boot-b", None), ("", None)])
def test_early_panel_restart_preserves_first_success_only_in_same_boot(tmp_path, next_boot_id, expected):
    r = FakeRouter()
    r.uptime = 30.0
    r.files["/proc/sys/kernel/random/boot_id"] = "boot-a\n"
    c = make(tmp_path, r)
    r.step(c)
    c.stop()  # normal panel restart saves the history, including startup readiness

    r.uptime = 60.0
    r.files["/proc/sys/kernel/random/boot_id"] = next_boot_id
    r.internet = {"internet": False}
    restarted = make(tmp_path, r)
    r.step(restarted)
    assert restarted.snapshot()["values"]["online"] == expected
    lost = [e for e in restarted.events(0) if e["type"] == "internet_lost"]
    assert len(lost) == (1 if expected == 0.0 else 0)


def test_unavailable_startup_probe_keeps_gap_until_first_success(tmp_path):
    r = FakeRouter()
    r.uptime = 30.0
    r.rci_down = True
    c = make(tmp_path, r)
    r.step(c, 6)
    assert c.snapshot()["values"]["online"] is None
    r.rci_down = False
    r.uptime = 60.0
    r.internet = {"internet": False}
    r.step(c, 6)
    assert c.snapshot()["values"]["online"] is None
    r.uptime = 90.0
    r.internet = {"internet": True, "dns-accessible": True}
    r.step(c, 6)
    assert c.snapshot()["values"]["online"] == 1.0
    assert not [e for e in c.events(0) if e["type"] in ("internet_lost", "internet_restored")]


FREQ_CUR = "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"
FREQ_MAX = "/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq"


def test_throttle_needs_two_slow_samples_below_max_and_a_warm_chip(tmp_path):
    r = FakeRouter()
    r.files[FREQ_CUR], r.files[FREQ_MAX] = "1000000", "1350000"
    r.thermal_temp = 85_000  # orange for a chip
    c = make(tmp_path, r)
    r.step(c, 2)  # the first 60 s sample
    assert c.events(0) == [] and c.hardware()["throttle"]["throttled"] is False
    r.step(c, 11)  # the second one
    assert [e["type"] for e in c.events(0)] == ["cpu_throttled"]
    assert c.hardware()["throttle"]["throttled"] is True
    r.files[FREQ_CUR] = "1350000"
    r.step(c, 12)
    assert c.events(0)[0]["until"] is not None
    assert c.hardware()["throttle"]["throttled"] is False


def test_an_idle_governor_on_a_cool_chip_is_never_throttling(tmp_path):
    r = FakeRouter()
    r.files[FREQ_CUR], r.files[FREQ_MAX] = "600000", "1350000"  # ondemand at idle
    r.thermal_temp = 55_000
    c = make(tmp_path, r)
    r.step(c, 60)  # five minutes
    assert c.events(0) == []
    assert c.hardware()["throttle"]["throttled"] is False


def test_one_slow_sample_below_max_when_hot_is_not_enough(tmp_path):
    r = FakeRouter()
    r.files[FREQ_CUR], r.files[FREQ_MAX] = "1000000", "1350000"
    r.thermal_temp = 85_000
    c = make(tmp_path, r)
    r.step(c, 2)
    r.files[FREQ_CUR] = "1350000"  # the next sample is at the maximum: the streak is broken
    r.step(c, 11)
    r.files[FREQ_CUR] = "1000000"
    r.step(c, 12)
    assert c.events(0) == []


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


def _spy_saves(monkeypatch) -> list[str]:
    saved: list[str] = []
    real = collector_mod.save_history

    def spy(path, *args, **kwargs):
        saved.append(Path(path).parent.name)
        return real(path, *args, **kwargs)

    monkeypatch.setattr(collector_mod, "save_history", spy)
    return saved


def test_restart_with_an_old_flash_copy_saves_flash_on_the_first_tick(tmp_path, monkeypatch):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 3)
    c.save("flash")
    saved = _spy_saves(monkeypatch)
    r2 = FakeRouter()
    r2.now = r.now + 7 * 3600  # the panel was down for seven hours
    c2 = make(tmp_path, r2)
    r2.step(c2)
    assert "state" in saved  # not six hours from this start: the copy on flash is already old


def test_restart_with_a_fresh_flash_copy_does_not_write_flash(tmp_path, monkeypatch):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 3)
    c.save("flash")
    saved = _spy_saves(monkeypatch)
    r2 = FakeRouter()
    r2.now = r.now + 600  # well inside FLASH_SAVE_EVERY_S
    c2 = make(tmp_path, r2)
    r2.step(c2, 3)
    assert "state" not in saved


def test_only_a_tmp_copy_after_reboot_still_gets_flash_on_the_first_tick(tmp_path, monkeypatch):
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 3)
    c.save("tmp")  # flash has never been written
    saved = _spy_saves(monkeypatch)
    r2 = FakeRouter()
    r2.now = r.now + 60
    c2 = make(tmp_path, r2)
    r2.step(c2)
    assert "state" in saved


def test_sigterm_handler_saves_flash_then_dies_as_the_signal_would(tmp_path, monkeypatch):
    import signal

    handlers: dict = {}
    killed: list = []
    monkeypatch.setattr(collector_mod.os, "kill", lambda pid, sig: killed.append(sig))
    monkeypatch.setattr(signal, "signal", lambda sig, handler: handlers.__setitem__(sig, handler))
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 3)
    monkeypatch.setattr(collector_mod, "_collector", c)
    assert collector_mod.install_terminate_save() is True
    handler = handlers[signal.SIGTERM]
    assert not (tmp_path / "state" / "resource-history.json").exists()
    handler(signal.SIGTERM, None)
    assert (tmp_path / "state" / "resource-history.json").is_file()
    assert handlers[signal.SIGTERM] == signal.SIG_DFL and killed == [signal.SIGTERM]


def test_sigterm_handler_without_a_collector_still_exits(monkeypatch):
    import signal

    handlers: dict = {}
    killed: list = []
    monkeypatch.setattr(collector_mod.os, "kill", lambda pid, sig: killed.append(sig))
    monkeypatch.setattr(signal, "signal", lambda sig, handler: handlers.__setitem__(sig, handler))
    monkeypatch.setattr(collector_mod, "_collector", None)
    collector_mod.install_terminate_save()
    handlers[signal.SIGTERM](signal.SIGTERM, None)
    assert killed == [signal.SIGTERM]


@pytest.mark.parametrize('flash_errno', [28, 30])
def test_shutdown_keeps_fresh_tmp_history_when_flash_cannot_finish(tmp_path, monkeypatch, flash_errno):
    r = FakeRouter(); c = make(tmp_path, r)
    r.step(c, 3)
    c.save('flash')
    r.step(c, 3)
    real = collector_mod.save_history

    def blocked_flash(path, *args, **kwargs):
        if path == c._paths['flash']:
            raise OSError(flash_errno, 'Flash unavailable')
        return real(path, *args, **kwargs)

    monkeypatch.setattr(collector_mod, 'save_history', blocked_flash)
    monkeypatch.setattr(collector_mod, '_collector', c)
    assert collector_mod.flush_collector() is False
    restarted = make(tmp_path, r)
    r.step(restarted)
    bars = restarted.snapshot()['cards']['link']['bars']['down']['values']
    assert bars[-4:] == [100, 100, 100, None]


def test_shutdown_tmp_failure_still_saves_fresh_flash(tmp_path, monkeypatch):
    r = FakeRouter(); c = make(tmp_path, r)
    r.step(c, 6)
    blocker = tmp_path / 'blocked-tmp'
    blocker.write_text('not a directory')
    c._paths['tmp'] = str(blocker / 'resource-history.json')
    monkeypatch.setattr(collector_mod, '_collector', c)
    assert collector_mod.flush_collector() is True
    restarted = make(tmp_path, r)
    r.step(restarted)
    assert restarted.snapshot()['cards']['link']['bars']['down']['values'][-4:] == [100, 100, 100, None]


def test_shutdown_keeps_fresh_tmp_before_waiting_for_flash(tmp_path, monkeypatch):
    r = FakeRouter(); c = make(tmp_path, r)
    r.step(c, 6)
    entered, release = threading.Event(), threading.Event()
    real = collector_mod.save_history

    def slow_flash(path, *args, **kwargs):
        if path == c._paths['flash']:
            entered.set()
            if not release.wait(timeout=5):
                raise TimeoutError('Test did not release flash')
        return real(path, *args, **kwargs)

    monkeypatch.setattr(collector_mod, 'save_history', slow_flash)
    monkeypatch.setattr(collector_mod, '_collector', c)
    worker = threading.Thread(target=collector_mod.flush_collector)
    worker.start()
    try:
        assert entered.wait(timeout=3)
        # This real tmpfs-equivalent file must already be usable while flash
        # is blocked, even if a hard timeout were to terminate the process now.
        payload = json.loads(Path(c._paths['tmp']).read_text(encoding='utf-8'))
        assert payload['store']['last_ts'] == r.now
        assert len(payload['meta']['network_recent']) == 6
    finally:
        release.set()
        worker.join(timeout=5)
    assert not worker.is_alive()


def test_boot_with_a_past_clock_then_ntp_jump_forward(tmp_path):
    r = FakeRouter()
    r.now = 1_000_000.0  # the router has just booted: the clock is not set yet
    r.uptime = 40.0
    c = make(tmp_path, r)
    r.step(c, 3)
    (boot,) = [e for e in c.events(0) if e["type"] == "router_rebooted"]
    assert boot["at"] < 2_000_000
    r.now = T0  # NTP sets the clock
    r.step(c, 3)
    r.step(c, 2)
    assert T0 - 10 <= c.history("15m")["history_since"] <= T0 + 30
    boots = [e for e in c.events(0) if e["type"] == "router_rebooted"]
    assert len(boots) == 1
    assert boots[0]["at"] == pytest.approx(T0 + 5 - r.uptime, abs=30) and boots[0]["until"] == boots[0]["at"]
    r.step(c, 5)
    assert [e["type"] for e in c.events(0)].count("router_rebooted") == 1  # not pruned later
    assert c.snapshot()["cards"]["internet"]["text"].count("без перерывов") <= 1
    assert "200 д" not in c.snapshot()["cards"]["internet"]["text"]


def test_clean_boot_clock_steps_rebase_history_and_port_event(tmp_path):
    r = FakeRouter()
    r.now, r.uptime = T0 - 42246, 40.0
    r.files["/proc/sys/kernel/random/boot_id"] = "cold-boot"
    r.set_lan_speed("100", only="4")
    c = make(tmp_path, r)
    def walk(n):
        for _ in range(n):
            r.uptime += 5
            r.step(c)
    walk(3)
    r.now += 41046  # intermediate firmware correction, still 20 minutes behind
    walk(1)
    r.now += 1200  # NTP final correction (< the old one-hour detector)
    walk(1)
    events = c.events(0)
    (port,) = [e for e in events if e["type"] == "port_slow"]
    assert port["at"] == pytest.approx(T0 + 5, rel=0, abs=0.01)
    assert c.history("15m")["history_since"] == pytest.approx(T0 + 5, rel=0, abs=0.01)
    (boot,) = [e for e in events if e["type"] == "router_rebooted"]
    assert boot["at"] == pytest.approx(r.now - r.uptime, rel=0, abs=0.01)
    assert not [e for e in events if e["type"] in ("internet_lost", "internet_restored")]
    c.save("tmp")
    payload = json.loads((tmp_path / "tmp" / "resource-history.json").read_text(encoding="utf-8"))
    assert payload["store"]["since"] >= T0
    assert all(t < 0 or t >= T0 for t in payload["store"]["tiers"]["week"]["starts"])


def test_clean_boot_real_pause_does_not_shift_earlier_history(tmp_path):
    r = FakeRouter()
    r.uptime = 40.0
    c = make(tmp_path, r)
    r.step(c)
    before = c.history("15m")["history_since"]
    r.now += 7200
    r.uptime += 7200
    r.step(c)
    assert c.history("7d")["history_since"] == before


def test_clean_boot_panel_restart_corrects_jump_between_processes(tmp_path):
    r = FakeRouter()
    r.now, r.uptime = T0 - 42246, 40.0
    r.files["/proc/sys/kernel/random/boot_id"] = "cold-boot"
    r.set_lan_speed("100", only="4")
    c = make(tmp_path, r)
    r.uptime += 5
    r.step(c)
    c.stop()
    r.now += 42276
    r.uptime += 30
    restarted = make(tmp_path, r)
    r.step(restarted)
    assert restarted.history("15m")["history_since"] == pytest.approx(T0 + 5, rel=0, abs=0.01)
    (port,) = [e for e in restarted.events(0) if e["type"] == "port_slow"]
    assert port["at"] == pytest.approx(T0 + 5, rel=0, abs=0.01)
    assert len([e for e in restarted.events(0) if e["type"] == "router_rebooted"]) == 1


def test_clean_boot_delayed_save_does_not_fabricate_a_clock_step(tmp_path):
    r = FakeRouter()
    r.uptime = 40.0
    r.files["/proc/sys/kernel/random/boot_id"] = "cold-boot"
    c = make(tmp_path, r)
    r.uptime += 5
    r.step(c)
    r.now += 120
    r.uptime += 120
    c.save("flash")
    restarted = make(tmp_path, r)
    assert restarted.history("15m")["history_since"] == T0 + 5


def _soc_after_history(tmp_path, half_hours: int):
    r = FakeRouter()
    r.thermal_temp = 78_000
    c = make(tmp_path, r)
    c._store.add_metric("temp:cpu")
    for k in range(half_hours, 0, -1):  # oldest first, cool the whole time
        c._store.add(r.now - 1800 * k, {"temp:cpu": 55.0})
    r.step(c, 2)
    return next(t for t in c.hardware()["temperatures"] if t["id"] == "cpu")  # the fake router's only sensor is the processor


def test_hotter_than_usual_needs_a_day_of_history(tmp_path):
    soc = _soc_after_history(tmp_path, 10)  # five hours: not yet "usual"
    assert soc["usual_c"] is None and soc["hotter_by_c"] is None


def test_hotter_than_usual_shows_after_a_day(tmp_path):
    soc = _soc_after_history(tmp_path, 60)
    assert soc["usual_c"] == pytest.approx(55.0, abs=1) and soc["hotter_by_c"] == 23


def test_a_failed_zram_step_keeps_the_previous_value(tmp_path, monkeypatch):
    r = FakeRouter()
    r.files["/proc/swaps"] = "Filename Type Size Used Priority\n/dev/zram0 partition 1048576 2048 -2\n"
    r.files["/sys/block/zram0/disksize"] = "1073741824"
    c = make(tmp_path, r)
    r.step(c, 2)
    assert c.hardware()["zram"]["used_bytes"] == 2048 * 1024

    def boom(*a, **k):
        raise ValueError("garbled swaps")

    with monkeypatch.context() as patch:
        patch.setattr(collector_mod.sensors, "zram_state", boom)
        r.step(c, 12)  # the next 60 s step fails
    assert c.hardware()["zram"]["used_bytes"] == 2048 * 1024
    r.files["/proc/swaps"] = "Filename Type Size Used Priority\n"  # zram really switched off
    r.step(c, 12)
    assert c.hardware()["zram"] is None


def test_zone_types_and_trips_are_read_once_a_minute_not_every_tick(tmp_path):
    r = FakeRouter()
    reads: list[str] = []
    real_reader, real_lister = r.reader, r.lister

    def reader(path):
        reads.append(path.as_posix())
        return real_reader(path)

    def lister(path):
        reads.append("ls " + path.as_posix())
        return real_lister(path)

    c = make(tmp_path, r)
    c._reader, c._lister = reader, lister
    r.step(c, 12)  # ticks 0..11: one 60 s step
    types = [p for p in reads if p.endswith("thermal_zone0/type")]
    trips = [p for p in reads if p == "ls /sys/class/thermal/thermal_zone0"]
    temps = [p for p in reads if p.endswith("thermal_zone0/temp")]
    assert len(types) == 1 and len(trips) == 1
    assert len(temps) == 12  # the temperature itself every 5 s
    r.step(c, 1)
    assert len([p for p in reads if p.endswith("thermal_zone0/type")]) == 2


def test_no_phantom_tile_for_a_radio_the_router_does_not_have(tmp_path):
    r = FakeRouter()
    r.show_interface.pop("WifiMaster1", None)
    c = make(tmp_path, r)
    r.step(c, 2)
    ids = [t["id"] for t in c.hardware()["temperatures"]]
    assert "wifi5" not in ids and "wifi24" in ids
    assert "temp:wifi5" not in c.snapshot()["values"]


def test_reboot_before_ntp_keeps_the_history_from_flash(tmp_path):
    r = FakeRouter()
    c = make(tmp_path, r)
    for k in range(48, 0, -1):  # a day of history before the reboot
        c._store.add(r.now - 1800 * k, {"cpu": 30.0})
    r.step(c, 2)
    c.save("flash")
    before = c.history("7d")["history_since"]
    shutdown = r.now
    r.now = 1_000_000.0  # rebooted: the clock is not set yet
    r.uptime = 40.0
    c2 = make(tmp_path, r)
    r.step(c2, 20)
    c2.save("flash")  # a save before NTP must not spoil the copy either
    r.now = shutdown + 300  # NTP
    c3 = make(tmp_path, r)
    r.step(c3, 3)
    week = c3.history("7d")
    assert week["history_since"] == before
    assert 30.0 in [round(v) if v is not None else None for v in week["metrics"]["cpu"]["avg"]]


class BusyRouter(FakeRouter):
    """One xray process that takes `xray_share` of the whole processor."""

    def __init__(self, xray_share: float = 0.5):
        super().__init__()
        self.xray_share = xray_share
        self.xray_ticks = 0
        self._set_xray()

    def _set_xray(self) -> None:
        self.files["/proc/42/stat"] = f"42 (xray) S 1 1 1 0 -1 0 0 0 0 0 {self.xray_ticks} 0 0 0 20 0 1 0 1 1 1"

    def lister(self, path: Path) -> list[str]:
        if path.as_posix() == "/proc":
            return ["1", "42", "self"]
        return super().lister(path)

    def step(self, c: Collector, n: int = 1) -> None:
        for _ in range(n):
            self.xray_ticks += int(1000 * self.xray_share)  # a step adds 1000 ticks over both cores
            self._set_xray()
            super().step(c)


def test_history_says_who_loaded_the_processor(tmp_path):
    r = BusyRouter(0.5)
    c = make(tmp_path, r)
    r.step(c, 12 * 4)
    top = c.history("1h")["top"]
    assert len(top) == 60
    assert top[-2] == [["xray", 50.0]]
    assert all(col is None for col in top[:-4])  # before the panel ran: no data, not "nobody"
    assert c.history("24h")["top"][-1][0][0] == "xray"


def test_cpu_overload_names_the_leader(tmp_path):
    r = BusyRouter(0.6)
    r.busy_share = 0.95
    c = make(tmp_path, r)
    r.step(c, 12 * 5)
    (problem,) = c.snapshot()["status"]["problems"]
    assert problem["type"] == "cpu_overload"
    assert problem["leaders"][0] == ["xray", 60.0]
    assert problem["detail"] == "больше всех: xray 60 %"


def test_leaders_survive_a_restart(tmp_path):
    r = BusyRouter(0.5)
    c = make(tmp_path, r)
    r.step(c, 12 * 3)
    c.save("flash")
    c2 = make(tmp_path, r)
    assert c2.history("1h")["top"][-2] == [["xray", 50.0]]


def test_no_leaders_on_an_unset_clock(tmp_path):
    r = BusyRouter(0.5)
    c = make(tmp_path, r)
    r.step(c, 12 * 2)
    c.save("flash")
    shutdown = r.now
    r.now = 1_000_000.0
    c2 = make(tmp_path, r)
    r.step(c2, 12 * 3)
    assert all(col is None for col in c2.history("1h")["top"])
    r.now = shutdown + 600  # NTP
    r.step(c2, 12 * 2)
    assert [["xray", 50.0]] in c2.history("1h")["top"]


def test_reboot_with_the_clock_stepping_like_keeneticos(tmp_path):
    # seen on NC-1812 / 5.1.8: the clock boots 4 days back, steps to 20 minutes back, then NTP
    r = FakeRouter()
    c = make(tmp_path, r)
    r.step(c, 24)
    c.save("flash")
    flash = tmp_path / "state" / "resource-history.json"
    saved_at = json.loads(flash.read_text(encoding="utf-8"))["saved_at"]
    before = c.history("7d")["history_since"]
    shutdown = r.now
    r.now, r.uptime = shutdown - 4 * 86400, 30.0
    r.internet = {"internet": False}
    r.busy_share = 0.80
    c2 = make(tmp_path, r)

    def walk(n):
        for _ in range(n):
            r.uptime += 5
            r.step(c2)

    walk(8)
    r.now = shutdown - 1200
    walk(4)
    r.internet = {"internet": True, "dns-accessible": True}
    walk(6)
    assert json.loads(flash.read_text(encoding="utf-8"))["saved_at"] == saved_at  # nothing saved on that clock
    r.now = shutdown + 120  # NTP
    r.busy_share = 0.20
    walk(12)
    events = c2.events(0)
    (boot,) = [e for e in events if e["type"] == "router_rebooted"]
    assert boot["at"] == pytest.approx(r.now - r.uptime, abs=10)
    assert all(e["at"] > shutdown - 600 for e in events), events  # every event in real time
    assert not [e for e in events if e["type"] in ("internet_lost", "internet_restored")]
    assert c2.history("7d")["history_since"] == before
    assert c2.snapshot()["cards"]["internet"]["state"] == "online"
    cpu = series(c2, "cpu")
    assert 40 in cpu and 20 in cpu and 80 not in cpu


def test_reboot_event_is_the_router_start_not_the_panel_start(tmp_path):
    r = FakeRouter()
    r.uptime = 39.0  # the panel comes up 39 s after the router, the clock already set
    c = make(tmp_path, r)
    (boot,) = [e for e in c.events(0) if e["type"] == "router_rebooted"]
    assert boot["at"] == boot["until"] == pytest.approx(T0 - 39.0)
