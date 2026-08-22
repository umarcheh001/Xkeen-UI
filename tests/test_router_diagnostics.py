from __future__ import annotations

import json
from pathlib import Path

from services.router_diagnostics import (
    fetch_rci_json,
    normalize_internet_status,
    normalize_interfaces,
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
