from __future__ import annotations

import json
import re
from pathlib import Path

from services.system_resources_history.hardware import (
    default_route_iface,
    wan_label,
    parse_ports,
    parse_system_name,
    router_identity,
    slow_ports,
    wan_interface,
    wifi_temperatures,
)

FIXTURES = Path(__file__).parent / "fixtures" / "system_resources_sensors"


def load(router: str, name: str):
    return json.loads((FIXTURES / router / name).read_text(encoding="utf-8"))


def net_dev_names(router: str) -> set[str]:
    names = set()
    for line in (FIXTURES / router / "net_dev").read_text(encoding="utf-8").splitlines():
        match = re.match(r"\s*([^\s:]+):", line)
        if match:
            names.add(match.group(1))
    return names


def test_ports_nc1812():
    ports = parse_ports(load("nc1812", "rci_show_interface.json"))
    assert [p.id for p in ports] == ["WAN", "1", "2", "3", "4", "5"]
    wan = ports[0]
    assert wan.is_wan and wan.label == "WAN" and wan.link
    assert wan.speed_mbps == 1000 and wan.duplex == "full"
    assert wan.description == "МТС"
    port4 = ports[4]
    assert not port4.is_wan and port4.link and port4.speed_mbps == 100 and port4.duplex == "full"
    assert not ports[5].link and ports[5].speed_mbps is None
    assert len({p.id for p in ports}) == len(ports)


def test_slow_port_detected():
    ports = parse_ports(load("nc1812", "rci_show_interface.json"))
    assert [p.id for p in slow_ports(ports)] == ["4"]


def test_kn1811_six_ports_no_slow():
    ports = parse_ports(load("kn1811", "rci_show_interface.json"))
    assert [p.id for p in ports] == ["WAN", "1", "2", "3", "4", "5"]
    assert [p.speed_mbps for p in ports] == [1000, 1000, 1000, 1000, None, None]
    assert slow_ports(ports) == []


def test_slow_ports_needs_a_gigabit_port():
    ports = parse_ports(load("nc1812", "rci_show_interface.json"))
    only_slow = [p for p in ports if p.speed_mbps != 1000]
    assert slow_ports(only_slow) == []


def test_wifi_temps():
    assert wifi_temperatures(load("nc1812", "rci_show_interface.json")) == {"wifi24": 49, "wifi5": 53}
    assert wifi_temperatures(load("kn1811", "rci_show_interface.json")) == {"wifi24": 70, "wifi5": 63}


def test_wifi_temps_missing_or_off():
    assert wifi_temperatures({}) == {"wifi24": None, "wifi5": None}
    off = {"WifiMaster0": {"link": "down"}, "WifiMaster1": {"temperature": "bad"}}
    assert wifi_temperatures(off) == {"wifi24": None, "wifi5": None}


def test_identity():
    assert router_identity(load("nc1812", "rci_show_version.json")) == {
        "model": "Netcraze Ultra (NC-1812)",
        "firmware": "KeeneticOS 5.1.8",
    }
    assert router_identity(load("kn1811", "rci_show_version.json"))["model"] == "Keenetic Ultra (KN-1811)"


def test_wan_kernel_name_in_net_dev():
    for router in ("nc1812", "kn1811"):
        assert wan_interface(load(router, "rci_show_interface.json")) == "ISP"
        kernel = parse_system_name(load(router, "rci_system_name_ISP.json"))
        assert kernel == "eth3"
        assert kernel in net_dev_names(router)


def test_parse_system_name_rejects_junk():
    assert parse_system_name("  eth3\n") == "eth3"
    for bad in ("", "  ", None, 5, {"a": 1}, ["eth3"]):
        assert parse_system_name(bad) is None


def test_default_route_iface_fixtures():
    for router in ("nc1812", "kn1811"):
        text = (FIXTURES / router / "net_route").read_text(encoding="utf-8")
        assert default_route_iface(text) == "eth3"
        assert "eth3" in net_dev_names(router)


ROUTE_HEAD = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"


def _route(iface: str, flags: str, metric: int, dest: str = "00000000", mask: str = "00000000") -> str:
    return f"{iface}\t{dest}\t0101A8C0\t{flags}\t0\t0\t{metric}\t{mask}\t0\t0\t0\n"


def test_default_route_lowest_metric_wins():
    table = ROUTE_HEAD + _route("eth3", "0003", 1000) + _route("ppp0", "0003", 0)
    assert default_route_iface(table) == "ppp0"


def test_default_route_absent_or_down():
    assert default_route_iface(ROUTE_HEAD + _route("br0", "0001", 0, "0001A8C0", "00FFFFFF")) is None
    assert default_route_iface(ROUTE_HEAD + _route("ppp0", "0000", 0) + _route("eth3", "0003", 1000)) == "eth3"
    assert default_route_iface("") is None
    assert default_route_iface("garbage") is None


def test_wan_label():
    data = load("nc1812", "rci_show_interface.json")
    assert wan_label(data, "eth3", "eth3") == "МТС"
    assert wan_label(data, "ppp0", "eth3") == "ppp0"
    assert wan_label(data, "eth3", None) == "eth3"


def test_garbage_input_does_not_raise():
    assert parse_ports({}) == []
    assert parse_ports(None) == []
    assert wan_interface({}) is None
    assert router_identity({}) == {"model": None, "firmware": None}
