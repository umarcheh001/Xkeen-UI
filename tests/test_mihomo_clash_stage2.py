from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from services.mihomo_clash_cache import (
    MihomoClashCache,
    build_cache_key,
    target_fingerprint,
)
from services.mihomo_clash_client import MihomoClashClientError, MihomoClashJSONResponse
from services.mihomo_clash_dns import normalize_dns_query, probe_dns_listener
from services.mihomo_clash_target import MihomoClashTarget


class _Clock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value


def test_common_cache_coalesces_equal_keys_and_reports_waiters():
    clock = _Clock()
    cache = MihomoClashCache(max_entries=4, clock=clock)
    started = threading.Event()
    release = threading.Event()
    calls = 0
    calls_lock = threading.Lock()

    def loader():
        nonlocal calls
        with calls_lock:
            calls += 1
        started.set()
        assert release.wait(2)
        return {"value": 7}

    key = build_cache_key("groups", target_fingerprint_value="target", config_fingerprint_value="config")
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = [executor.submit(cache.fetch, key, loader, ttl_seconds=10)]
        assert started.wait(2)
        futures.extend(
            executor.submit(cache.fetch, key, loader, ttl_seconds=10)
            for _ in range(5)
        )
        release.set()
        results = [future.result(timeout=2) for future in futures]

    assert calls == 1
    assert all(result.value == {"value": 7} for result in results)
    assert sum(result.waited for result in results) >= 1
    assert cache.stats()["misses"] == 1
    assert cache.stats()["waiters"] >= 1

    cached = cache.fetch(key, lambda: pytest.fail("cache miss"), ttl_seconds=10)
    assert cached.hit is True
    assert cached.value == {"value": 7}


def test_common_cache_is_bounded_and_expires_entries():
    clock = _Clock()
    cache = MihomoClashCache(max_entries=2, clock=clock)

    for name in ("one", "two"):
        cache.get_or_set(name, lambda name=name: {"name": name}, ttl_seconds=5)
    cache.get_or_set("three", lambda: {"name": "three"}, ttl_seconds=5)
    assert cache.stats()["entries"] == 2
    assert cache.stats()["evictions"] == 1

    clock.value = 6
    expired = cache.fetch("three", lambda: {"fresh": True}, ttl_seconds=5)
    assert expired.hit is False
    assert expired.value == {"fresh": True}
    assert cache.stats()["misses"] == 4


def test_common_cache_invalidation_does_not_reinsert_inflight_mutation_result():
    cache = MihomoClashCache()
    started = threading.Event()
    release = threading.Event()
    key = build_cache_key("groups", target_fingerprint_value="target")

    def loader():
        started.set()
        assert release.wait(2)
        return {"stale": True}

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(cache.get_or_set, key, loader, ttl_seconds=60)
        assert started.wait(2)
        cache.invalidate(namespaces={"groups"})
        release.set()
        assert future.result(timeout=2) == {"stale": True}

    fresh = cache.fetch(key, lambda: {"fresh": True}, ttl_seconds=60)
    assert fresh.hit is False
    assert fresh.value == {"fresh": True}


def test_cache_key_and_target_fingerprint_never_expose_secret():
    target = MihomoClashTarget(
        transport="tcp",
        port=9090,
        loopback_host="127.0.0.1",
        secret="fixture-secret",
    )
    key = build_cache_key("status", target=target, config_fingerprint_value="cfg")
    serialized = json.dumps(key.as_tuple())
    assert "fixture-secret" not in serialized
    assert target_fingerprint(target) != "fixture-secret"


def test_dns_dto_keeps_ttl_latency_mode_and_normalized_error_reason():
    payload = normalize_dns_query(
        {
            "Status": 0,
            "Answer": [
                {"name": "example.invalid", "type": 1, "TTL": 60, "data": "192.0.2.44"},
            ],
        },
        name="example.invalid",
        qtype="A",
        latency_ms=12.34,
        config_payload={"dns": {"enhanced-mode": "fake-ip"}},
    )
    assert payload["ok"] is True
    assert payload["ttl"] == 60
    assert payload["latency_ms"] == 12.3
    assert payload["dns_mode"] == "fake-ip"
    assert payload["answers"][0]["type"] == "A"

    nxdomain = normalize_dns_query(
        {"Status": 3, "Answer": []},
        name="missing.invalid",
        qtype="A",
        latency_ms=3,
    )
    assert nxdomain["ok"] is False
    assert nxdomain["error_reason"] == "nxdomain"

    fake_ip = normalize_dns_query(
        {"Status": 0, "Answer": [{"type": 1, "TTL": 60, "data": "198.18.0.4"}]},
        name="example.invalid",
        qtype="A",
        latency_ms=2,
        config_payload={"dns": {"enhanced-mode": "fake-ip", "fake-ip-range": "198.18.0.1/16"}},
    )
    assert fake_ip["answer_observation"] == {
        "state": "fake-ip-range",
        "range": "198.18.0.1/16",
        "source": "controller-api",
    }
    assert fake_ip["route_check"]["state"] == "not-checked"

    real_ip = normalize_dns_query(
        {"Status": 0, "Answer": [{"type": 1, "TTL": 60, "data": "192.0.2.44"}]},
        name="example.invalid",
        qtype="A",
        latency_ms=2,
        config_payload={"dns": {"enhanced-mode": "fake-ip", "fake-ip-range": "198.18.0.1/16"}},
    )
    assert real_ip["answer_observation"]["state"] == "upstream-address"
    assert real_ip["route_check"]["state"] == "not-checked"

    unknown_range = normalize_dns_query(
        {"Status": 0, "Answer": [{"type": 1, "TTL": 60, "data": "198.18.0.4"}]},
        name="example.invalid",
        qtype="A",
        latency_ms=2,
        config_payload={"dns": {"enhanced-mode": "fake-ip"}},
    )
    assert unknown_range["answer_observation"]["state"] == "range-unavailable"
    assert unknown_range["answer_observation"]["range"] is None


class _DnsClient:
    def __init__(self, version="Mihomo Meta v1.19.12"):
        self.version = version
        self.operations: list[str] = []
        self.query_names: list[str] = []
        self.dns_flushes = 0
        self.fake_ip_flushes = 0

    def request_json(self, operation: str):
        self.operations.append(operation)
        if operation == "version":
            return MihomoClashJSONResponse(
                {"version": self.version},
                200,
                1,
                32,
            )
        if operation == "configs":
            return MihomoClashJSONResponse(
                {"dns": {"enhanced-mode": "fake-ip"}},
                200,
                1,
                32,
            )
        raise AssertionError(operation)

    def query_dns(self, name: str, qtype: str):
        self.query_names.append(name)
        return MihomoClashJSONResponse(
            {
                "Status": 0,
                "Answer": [{"name": name, "type": 1, "TTL": 42, "data": "192.0.2.44"}],
            },
            200,
            4.5,
            100,
        )

    def flush_dns_cache(self):
        self.dns_flushes += 1
        return MihomoClashJSONResponse(None, 204, 1, 0)

    def flush_fake_ip_cache(self):
        self.fake_ip_flushes += 1
        return MihomoClashJSONResponse(None, 204, 1, 0)


def test_dns_facade_is_strict_and_uses_bounded_query_cache(monkeypatch):
    from tests.test_mihomo_clash_routes import make_app, ready_discovery

    client = _DnsClient()
    monkeypatch.setenv("XKEEN_MIHOMO_DNS_QUERY_ENABLE", "1")
    monkeypatch.setenv("XKEEN_MIHOMO_CAPABILITY_PROBE", "1")
    response = make_app(ready_discovery(), client).test_client()

    first = response.get("/api/mihomo/clash/dns/query?name=example.invalid&type=A")
    second = response.get("/api/mihomo/clash/dns/query?name=example.invalid&type=A")
    invalid = response.get("/api/mihomo/clash/dns/query?name=bad%20name&type=A")

    assert first.status_code == 200
    assert first.get_json()["ttl"] == 42
    assert first.get_json()["cached"] is False
    assert second.status_code == 200
    assert second.get_json()["cached"] is True
    assert client.query_names == ["example.invalid"]
    assert invalid.status_code == 400
    assert invalid.get_json()["code"] == "dns_name_invalid"


def test_dns_query_falls_back_to_redacted_local_config_when_configs_omits_dns(monkeypatch, tmp_path):
    from tests.test_mihomo_clash_routes import make_app, ready_discovery

    class ConfigOmittingDnsClient(_DnsClient):
        def request_json(self, operation: str):
            if operation == "configs":
                self.operations.append(operation)
                return MihomoClashJSONResponse(
                    {"mode": "rule", "log-level": "info"},
                    200,
                    1,
                    32,
                )
            return super().request_json(operation)

    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        "dns:\n"
        "  enable: true\n"
        "  enhanced-mode: fake-ip\n"
        "  fake-ip-range: 198.18.0.1/16\n"
        "  nameserver:\n"
        "    - https://secret-user:secret-pass@example.test/dns-query\n",
        encoding="utf-8",
    )
    client = ConfigOmittingDnsClient()
    monkeypatch.setenv("XKEEN_MIHOMO_DNS_QUERY_ENABLE", "1")
    response = make_app(
        ready_discovery(),
        client,
        mihomo_config_file=str(config_file),
        mihomo_root=str(tmp_path),
    ).test_client().get("/api/mihomo/clash/dns/query?name=example.invalid&type=A")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["dns_mode"] == "fake-ip"
    assert payload["route_check"]["state"] == "not-checked"
    assert payload["answer_observation"]["state"] == "upstream-address"
    serialized = json.dumps(payload, ensure_ascii=False)
    assert "secret-user" not in serialized
    assert "secret-pass" not in serialized
    assert "example.test" not in serialized


def test_dns_listener_probe_classifies_fake_ip_without_confusing_controller_answers(monkeypatch):
    import socket
    import struct

    txid = 1234
    packet = struct.pack("!HHHHHH", txid, 0x8180, 1, 1, 0, 0)
    packet += b"\x07example\x03com\x00" + struct.pack("!HH", 1, 1)
    packet += b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 1, 4) + bytes([198, 18, 0, 7])

    class FakeSocket:
        def __init__(self, *args):
            self.args = args

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def settimeout(self, value):
            self.timeout = value

        def sendto(self, payload, target):
            self.sent = (payload, target)

        def recvfrom(self, size):
            return packet, ("127.0.0.1", 53)

    monkeypatch.setattr(socket, "socket", FakeSocket)
    monkeypatch.setattr("services.mihomo_clash_dns.random.randint", lambda _low, _high: txid)
    result = probe_dns_listener(
        "example.com",
        qtype="A",
        config_payload={"dns": {"enhanced-mode": "fake-ip", "listen": "0.0.0.0:53", "fake-ip-range": "198.18.0.1/16"}},
    )
    assert result["ok"] is True
    assert result["state"] == "fake-ip"
    assert result["source"] == "local-listener"
    assert result["addresses"] == ["198.18.0.7"]


def test_dns_route_check_is_separate_read_only_endpoint(monkeypatch):
    from tests.test_mihomo_clash_routes import make_app, ready_discovery
    import routes.mihomo_clash as mihomo_clash_routes

    client = _DnsClient()
    monkeypatch.setattr(
        mihomo_clash_routes,
        "probe_dns_listener",
        lambda name, *, qtype, config_payload: {
            "ok": True,
            "state": "fake-ip",
            "source": "local-listener",
            "range": "198.18.0.1/16",
            "addresses": ["198.18.0.7"],
            "qtype": qtype,
        },
    )
    http = make_app(ready_discovery(), client).test_client()
    response = http.get("/api/mihomo/clash/dns/route-check?name=example.invalid&type=A")
    invalid = http.get("/api/mihomo/clash/dns/route-check?name=example.invalid&type=TXT")

    assert response.status_code == 200
    assert response.get_json()["source"] == "local-listener"
    assert response.get_json()["state"] == "fake-ip"
    assert invalid.status_code == 400
    assert invalid.get_json()["code"] == "dns_route_type_invalid"


def test_dns_flush_requires_confirmation_audits_and_invalidates_dns_cache(monkeypatch):
    from tests.test_mihomo_clash_routes import make_app, ready_discovery

    client = _DnsClient()
    audit: list[dict] = []
    monkeypatch.setenv("XKEEN_MIHOMO_DNS_FLUSH_ENABLE", "1")
    monkeypatch.setenv("XKEEN_MIHOMO_FAKE_IP_FLUSH_ENABLE", "1")
    app = make_app(ready_discovery(), client, audit_logger=lambda ok, **meta: audit.append({"ok": ok, **meta}))
    http = app.test_client()

    missing = http.post("/api/mihomo/clash/dns/flush", json={})
    flushed = http.post("/api/mihomo/clash/dns/flush", json={"confirmed": True})
    fake_ip = http.post("/api/mihomo/clash/fake-ip/flush", json={"confirmed": True})

    assert missing.status_code == 400
    assert missing.get_json()["code"] == "confirmation_required"
    assert flushed.status_code == 200
    assert fake_ip.status_code == 200
    assert client.dns_flushes == 1
    assert client.fake_ip_flushes == 1
    assert any(item["action"] == "dns-flush" and item["ok"] is True for item in audit)
    assert any(item["action"] == "fake-ip-flush" and item["ok"] is True for item in audit)


def test_dns_flush_allows_confirmed_unknown_hash_build_and_lets_endpoint_decide(monkeypatch):
    from tests.test_mihomo_clash_routes import make_app, ready_discovery

    client = _DnsClient(version="alpha-65287f0")
    monkeypatch.setenv("XKEEN_MIHOMO_DNS_FLUSH_ENABLE", "1")
    response = make_app(ready_discovery(), client).test_client().post(
        "/api/mihomo/clash/dns/flush", json={"confirmed": True}
    )

    assert response.status_code == 200
    assert response.get_json()["flushed"] is True
    assert client.dns_flushes == 1


def test_dns_cache_search_is_honestly_not_supported():
    from tests.test_mihomo_clash_routes import make_app, ready_discovery

    response = make_app(ready_discovery(), _DnsClient()).test_client().get(
        "/api/mihomo/clash/dns/cache?q=example"
    )
    assert response.status_code == 501
    assert response.get_json()["code"] == "not_supported"


def test_dns_diagnostics_ui_has_inline_actions_and_visibility_toggle():
    from pathlib import Path

    root = Path(__file__).parents[1]
    template = (root / "xkeen-ui" / "templates" / "panel.html").read_text(encoding="utf-8")
    styles = (root / "xkeen-ui" / "static" / "panel-operator.css").read_text(encoding="utf-8")
    script = (root / "xkeen-ui" / "static" / "js" / "features" / "mihomo_clash" / "dns.js").read_text(encoding="utf-8")

    assert 'id="mihomo-clash-dns-toggle"' in template
    assert 'aria-controls="mihomo-clash-dns-diagnostics"' in template
    assert 'id="mihomo-clash-dns-diagnostics" class="xk-mihomo-dns-diagnostics"' in template
    assert 'aria-busy="false" hidden' in template
    assert '.xk-mihomo-dns-query-row > button' in styles
    assert '.xk-mihomo-dns-maintenance-actions > button' in styles
    assert 'display: inline-flex !important;' in styles
    assert "xkeen:mihomo-clash-dns-visible" in script
    assert "applyVisibility(!expanded, { persist: true })" in script
