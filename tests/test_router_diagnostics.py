from __future__ import annotations

import json
from types import SimpleNamespace
from pathlib import Path

from services.router_diagnostics import (
    channel_check,
    fetch_rci_json,
    normalize_internet_status,
    normalize_interfaces,
    normalize_capabilities,
    normalize_clients,
    normalize_lte,
    normalize_processes,
    reset_router_diagnostic_sampler,
    sample_conntrack,
    sample_router_diagnostics,
)


def test_normalize_internet_status_handles_keenetic_accessibility_flags():
    payload = normalize_internet_status(
        {
            "internet": True,
            "gateway-accessible": "yes",
            "dns-accessible": "yes",
            "captive-accessible": False,
            "gateway": [{"interface": "ISP", "address": "192.0.2.2"}],
        }
    )

    assert payload["internet"] is True
    assert payload["gateway"] is True
    assert payload["dns"] is True
    assert payload["captive"] is False
    assert payload["interface"] == "ISP"
    assert payload["address"] == "192.0.2.2"


def test_conntrack_reads_count_and_limit_from_procfs():
    values = {
        "/proc/sys/net/netfilter/nf_conntrack_count": "2048\n",
        "/proc/sys/net/netfilter/nf_conntrack_max": "8192\n",
    }

    payload = sample_conntrack(reader=lambda path: values[path.as_posix()])

    assert payload == {
        "available": True,
        "count": 2048,
        "max": 8192,
        "available_entries": 6144,
        "percent": 25.0,
        "tone": "normal",
    }


def test_interfaces_compute_rates_and_prioritize_default_wan():
    first = [
        {"id": "Bridge0", "type": "Bridge", "state": "up", "link": "up", "rxbytes": 100, "txbytes": 200},
        {"id": "ISP", "type": "PPPoE", "state": "up", "connected": "yes", "defaultgw": True, "rxbytes": 1000, "txbytes": 2000},
    ]
    second = [dict(item) for item in first]
    second[1]["rxbytes"] = 2000
    second[1]["txbytes"] = 2500

    reset_router_diagnostic_sampler()
    normalize_interfaces(first, now=10)
    payload = normalize_interfaces(second, now=12)

    assert payload["items"][0]["name"] == "ISP"
    assert payload["items"][0]["kind"] == "wan"
    assert payload["items"][0]["receive_bits_per_second"] == 4000
    assert payload["items"][0]["send_bits_per_second"] == 2000


def test_process_normalizer_keeps_bounded_top_cpu_and_memory_fields():
    payload = normalize_processes(
        {
            "process": [
                {"id": "DNS", "name": "ndnproxy", "pid": 12, "vm-size": 2048, "statistics": {"cpu": {"cur": 3}}},
                {"id": "HTTP", "name": "ndm", "pid": 2, "vm-size": 4096, "statistics": {"cpu": {"cur": 9}}},
            ]
        },
        sampled_at=42,
    )

    assert payload["items"][0]["name"] == "ndm"
    assert payload["items"][0]["cpu_percent"] == 9.0
    assert payload["items"][0]["memory_bytes"] == 4 * 1024 * 1024


def test_process_normalizer_understands_real_keenetic_comm_and_kb_fields():
    payload = normalize_processes(
        {
            "process": [
                {
                    "comm": "ndm",
                    "pid": "415",
                    "vm-size": "87592 kB",
                    "vm-rss": "48156 kB",
                    "object": {"id": "KeeneticOS core"},
                    "statistics": {"cpu": {"cur": 2}},
                }
            ]
        },
        sampled_at=42,
    )

    assert payload["items"][0]["name"] == "ndm"
    assert payload["items"][0]["memory_bytes"] == 48156 * 1024
    assert payload["items"][0]["service"] == "KeeneticOS core"


def test_client_normalizer_sorts_top_traffic_and_keeps_negative_rssi():
    payload = normalize_clients(
        {
            "clients": [
                {"hostname": "tablet", "mac": "AA:02", "ip": "192.0.2.2", "rssi": -61, "rxbytes": 500, "txbytes": 100, "rxrate": 24000},
                {"hostname": "laptop", "mac": "AA:01", "ip": "192.0.2.1", "rssi": -48, "rxbytes": 900, "txbytes": 300, "interface": "WifiMaster0"},
            ]
        },
        sampled_at=42,
    )

    assert payload["top"][0]["name"] == "laptop"
    assert payload["top"][0]["traffic_bytes"] == 1200
    assert payload["top"][0]["rssi"] == -48
    assert payload["wifi"][0]["interface"] == "WifiMaster0"


def test_optional_metrics_normalizers_keep_signal_values():
    capabilities = normalize_capabilities({"model": "Hero", "version": "4.2", "components": ["WifiMaster0", "lte"]}, sampled_at=42)
    lte = normalize_lte({"modem": {"operator": "Test", "rsrp": -97, "rsrq": -11, "cinr": 18, "band": "B3"}}, sampled_at=42)

    assert capabilities["wifi"] is True
    assert capabilities["lte"] is True
    assert capabilities["model"] == "Hero"
    assert lte["rsrp"] == -97
    assert lte["rsrq"] == -11
    assert lte["band"] == "B3"


def test_channel_check_calculates_loss_latency_jitter_and_trace():
    calls = []

    def runner(command, **_kwargs):
        calls.append(command[0])
        if command[0] == "ping":
            return SimpleNamespace(stdout="64 bytes from 1.1.1.1: time=10.0 ms\n64 bytes from 1.1.1.1: time=14.0 ms\n0% packet loss", stderr="")
        return SimpleNamespace(stdout="1  gateway  1 ms\n2  target  12 ms", stderr="")

    payload = channel_check("1.1.1.1", include_trace=True, runner=runner, clock=lambda: 77)

    assert calls == ["ping", "traceroute"]
    assert payload["received"] == 2
    assert payload["latency_ms"] == 12.0
    assert payload["jitter_ms"] == 2.0
    assert payload["loss_percent"] == 0.0
    assert "gateway" in payload["trace"]


def test_light_snapshot_never_requests_processes():
    requested = []
    proc = {
        "/proc/sys/net/netfilter/nf_conntrack_count": "1",
        "/proc/sys/net/netfilter/nf_conntrack_max": "10",
    }

    def fetch(path):
        requested.append(path)
        if path == "show/internet/status":
            return {"internet": True, "gateway-accessible": True, "dns-accessible": True}
        return [{"id": "ISP", "defaultgw": True, "state": "up"}]

    payload = sample_router_diagnostics(
        reader=lambda path: proc[path.as_posix()],
        rci_fetcher=fetch,
        clock=lambda: 100,
    )

    assert requested == ["show/internet/status", "show/interface"]
    assert payload["conntrack"]["percent"] == 10.0


def test_rci_fetcher_uses_tokenized_request_and_decodes_json():
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return json.dumps({"internet": True}).encode()

    captured = {}

    def opener(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        return Response()

    assert fetch_rci_json("show/internet/status", opener=opener) == {"internet": True}
    assert captured["url"].endswith("/rci/show/internet/status")
    assert captured["timeout"] == 2.0
