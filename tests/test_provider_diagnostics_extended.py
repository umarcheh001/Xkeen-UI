from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import copy
import socket
import threading

from flask import Flask
import pytest

from services import provider_diagnostics as base
from services import provider_diagnostics_extended as extended
from routes.provider_diagnostics import create_provider_diagnostics_blueprint


@pytest.fixture
def http_origin():
    stop = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302 if self.path == "/redirect" else 200)
            self.send_header("Content-Length", str(262144))
            self.send_header("Location", "/complete")
            self.end_headers()
            if self.path == "/redirect":
                return
            try:
                self.wfile.write(b"x" * (18000 if self.path in {"/short", "/stall"} else 262144))
                self.wfile.flush()
                if self.path == "/stall":
                    stop.wait(2)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    yield server.server_port
    stop.set()
    server.shutdown()
    worker.join(2)
    server.server_close()


@pytest.mark.parametrize(("path", "status", "count"), [
    ("/complete", "transfer_ok", 262144),
    ("/short", "transfer_short", 18000),
    ("/stall", "transfer_timeout", 18000),
    ("/redirect", "unexpected_response", 0),
])
def test_stream_records_partial_data_and_has_a_total_deadline(http_origin, path, status, count):
    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", http_origin))
    result = base._resource_http_request(("http", "origin.example", http_origin, path), address=address,
                                         transfer_bytes=262144, duration=0.2)
    assert result["status"] == status
    assert result["bytes_received"] == count
    assert result["total_ms"] < 1500
    assert result["stage"] == ("http_headers" if path == "/redirect" else "body")
    if count:
        assert result["first_byte_ms"] is not None
        assert result["last_progress_ms"] >= result["first_byte_ms"]
        assert any(item["bytes"] == 16384 for item in result["checkpoints"])
    if count == 18000:
        assert not any(item["bytes"] == 20480 for item in result["checkpoints"])


def test_stream_through_http_proxy_pins_destination_and_keeps_host(http_origin):
    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80))
    result = base._resource_http_request(("http", "origin.example", 80, "/complete"), address=address,
                                         proxy_port=http_origin, transfer_bytes=262144)
    assert result["status"] == "transfer_ok"
    assert result["connected_ip"] == "8.8.8.8"


def test_family_selection_does_not_hide_ipv6_after_many_ipv4_addresses():
    addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (f"198.51.100.{i}", 443)) for i in range(1, 8)]
    addresses.append((socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2001:db8::1", 443, 0, 0)))
    assert [item[0] for item in base._distinct_addresses(addresses, 2)] == [socket.AF_INET, socket.AF_INET6]


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_basic_probe_preserves_mixed_family_results(monkeypatch, platform):
    monkeypatch.setattr(base.sys, "platform", platform)
    monkeypatch.setattr(base.socket, "getaddrinfo", lambda *_a, **_k: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.1", 443)),
        (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2001:db8::1", 443, 0, 0)),
    ])
    monkeypatch.setattr(base, "_xkeen_direct_mark", lambda *, ipv6=False: 0)
    monkeypatch.setattr(base, "_probe_address", lambda _t, a, _m: {
        "ip": a[4][0], "status": "reachable" if a[0] == socket.AF_INET else "tls_timeout", "stage": "tls",
    })
    result = base.probe_target(base.make_target("node.example", 443, tls=True))
    assert result["status"] == "reachable"
    assert result["mixed_addresses"] is True
    assert [item["status"] for item in result["address_results"]] == ["reachable", "tls_timeout"]


@pytest.mark.parametrize(("sni_result", "no_sni_result", "expected"), [
    ("tls_timeout", "tls_timeout", "tls_stalled"),
    ("tcp_timeout", "tcp_timeout", "tcp_unresponsive"),
    ("tls_timeout", "tls_ok", "tls_sni_filtering"),
])
def test_tls_diagnosis_distinguishes_stages_and_survives_failed_cloudflare(monkeypatch, sni_result, no_sni_result, expected):
    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.1", 443))
    monkeypatch.setattr(base.socket, "getaddrinfo", lambda *_a, **_k: [address])
    monkeypatch.setattr(base, "_xkeen_direct_mark", lambda: 0)
    monkeypatch.setattr(base, "lookup_public_lists", lambda _r: {"status": "unavailable"})

    def attempt(a, *, server_name, bypass_mark):
        if a[4][0] == "1.1.1.1":
            return "tcp_timeout"
        if a[4][0] == "8.8.8.8":
            return "tls_ok"
        return sni_result if server_name else no_sni_result

    monkeypatch.setattr(base, "_tls_comparison_attempt", attempt)
    result = base.compare_tls_path(base.make_target("node.example", 443, tls=True))
    assert result["verdict"] == expected
    assert [item["result"] for item in result["controls"]] == ["tcp_timeout", "tls_ok"]


def stalled(count=18000, **kwargs):
    return {"status": "transfer_timeout", "stage": "body", "bytes_received": count, "requested_bytes": 262144, "total_ms": 4000, **kwargs}


def test_stall_diagnosis_requires_repeats_and_independent_controls():
    one = {"attempts": [stalled(), stalled(18500), stalled(17800)], "direct": {"status": "transfer_ok"}, "paced_direct": {"status": "transfer_ok"}}
    assert extended._diagnose([one])["verdict"] == "repeatable_stall"
    result = extended._diagnose([one, copy.deepcopy(one)])
    assert result["verdict"] == "byte_limit_pattern"
    assert result["confidence"] == "medium"
    assert 17000 < result["approx_bytes"] < 19000
    assert extended._diagnose([{**one, "attempts": [stalled()]}])["verdict"] == "undetermined"
    assert extended._diagnose([{**one, "attempts": [stalled(), {"status": "transfer_ok"}]}])["verdict"] == "partial_success"
    assert extended._diagnose([{**one, "paced": stalled(4000)}])["verdict"] == "duration_sensitive"
    assert extended._diagnose([one, {**one, "attempts": [stalled(60000), stalled(60000)]}])["verdict"] != "byte_limit_pattern"
    assert extended._diagnose([{**one, "attempts": [stalled(budget_limited=True), stalled(budget_limited=True)]}])["verdict"] == "undetermined"
    assert extended._diagnose([{**one, "paced": {"status": "transfer_ok", "bytes_received": 65536}}])["verdict"] == "pace_sensitive"


def test_pinning_xray_preserves_tls_profile_and_credentials_without_mutation():
    entry = {"protocol": "vless", "settings": {"vnext": [{"address": "node.example", "port": 443, "users": [{"id": "secret"}]}]},
             "streamSettings": {"security": "tls", "tlsSettings": {"fingerprint": "chrome", "alpn": ["h2"]}}}
    saved = copy.deepcopy(entry)
    pinned = extended._pin_entry(entry, base.make_target("node.example", 443, tls=True), "2001:db8::1")
    assert pinned["settings"]["vnext"][0]["address"] == "2001:db8::1"
    assert pinned["streamSettings"]["tlsSettings"] == {"fingerprint": "chrome", "alpn": ["h2"], "serverName": "node.example"}
    assert pinned["settings"]["vnext"][0]["users"][0]["id"] == "secret"
    assert entry == saved


@pytest.mark.parametrize("raw_yaml", [False, True])
def test_pinning_mihomo_keeps_sni_including_without_pyyaml(raw_yaml):
    entry = {"_diagnostics_engine": "mihomo", **({"proxy_yaml": "  - name: N\n    type: trojan\n    server: node.example\n    port: 443\n    password: secret\n"} if raw_yaml else {"proxy": {"name": "N", "type": "trojan", "server": "node.example", "port": 443, "password": "secret"}})}
    target = base.make_target("node.example", 443, tls=True)
    pinned = extended._pin_entry(entry, target, "2001:db8::1")
    if raw_yaml:
        assert 'server: "2001:db8::1"' in pinned["proxy_yaml"]
        assert 'servername: "node.example"' in pinned["proxy_yaml"]
    else:
        assert pinned["proxy"]["server"] == "2001:db8::1"
        assert pinned["proxy"]["servername"] == "node.example"


def test_hysteria_pinning_preserves_implicit_tls_sni_for_udp():
    entry = {"_diagnostics_engine": "mihomo", "proxy": {"name": "HY2", "type": "hysteria2", "server": "udp.example", "port": 443, "password": "secret"}}
    target = base.make_target("udp.example", 443, network="udp", protocol="hysteria2")
    pinned = extended._pin_entry(entry, target, "198.51.100.1")
    assert pinned["proxy"]["sni"] == "udp.example"
    assert pinned["proxy"]["server"] == "198.51.100.1"


def test_websocket_pinning_preserves_implicit_host():
    entry = {"protocol": "vless", "settings": {"vnext": [{"address": "node.example", "port": 443}]}, "streamSettings": {"network": "ws"}}
    pinned = extended._pin_entry(entry, base.make_target("node.example", 443), "198.51.100.1")
    assert pinned["streamSettings"]["wsSettings"]["headers"]["Host"] == "node.example"


def test_paced_transfer_is_requested_from_origin_instead_of_delaying_reads(monkeypatch):
    seen = []
    monkeypatch.setattr(base, "_resource_http_request", lambda parts, **kw: seen.append((parts, kw)) or {"status": "transfer_ok"})
    control = {"host": "httpbingo.org", "path": "/bytes/{size}", "paced_path": "/drip?numbytes={size}&duration=6", "address": ()}
    extended._transfer(control, 65536, deadline=extended.time.monotonic() + 20, paced=True)
    assert seen[0][0][3] == "/drip?numbytes=65536&duration=6"
    assert seen[0][1]["paced"] is True


def test_size_steps_repeat_the_first_incomplete_response_without_hiding_small_successes(monkeypatch):
    sizes = []
    def transfer(_control, size, **kwargs):
        sizes.append(size)
        if size <= 16384:
            return {"status": "transfer_ok", "requested_bytes": size, "bytes_received": size}
        return stalled(requested_bytes=size)
    monkeypatch.setattr(extended, "_transfer", transfer)
    steps = extended._step_transfers({}, deadline=extended.time.monotonic() + 30, proxy_port=12345)
    assert sizes == [8192, 16384, 20480, 20480, 20480]
    assert extended._step_boundary(steps) == {"last_complete_bytes": 16384, "first_incomplete_bytes": 20480, "repeatable": True}
    control = {"attempts": steps, "direct": {"status": "transfer_ok"}}
    assert extended._diagnose([control, copy.deepcopy(control)])["verdict"] == "byte_limit_pattern"
    # A passing retry at the failed size contradicts a stable threshold.
    steps[-1] = {"status": "transfer_ok", "requested_bytes": 20480, "bytes_received": 20480}
    assert extended._step_boundary(steps)["repeatable"] is False
    assert extended._diagnose([{**control, "attempts": steps}])["verdict"] == "undetermined"


def test_small_steps_alone_do_not_claim_a_successful_256kb_transfer():
    steps = [{"status": "transfer_ok", "requested_bytes": size, "bytes_received": size} for size in (8192, 16384)]
    assert extended._diagnose([{"attempts": steps}, {"attempts": steps}])["verdict"] == "undetermined"


@pytest.mark.parametrize("engine", ["xray", "mihomo", "mihomo_yaml"])
def test_tls_fingerprint_variants_only_change_the_fingerprint(engine):
    if engine == "xray":
        entry = {"protocol": "vless", "settings": {"key": "secret"}, "streamSettings": {"security": "reality", "realitySettings": {"fingerprint": "safari", "serverName": "front.example", "publicKey": "public"}}}
        variant = extended._with_tls_fingerprint(entry, "firefox")
        assert variant["streamSettings"]["realitySettings"]["fingerprint"] == "firefox"
        variant["streamSettings"]["realitySettings"]["fingerprint"] = "safari"
    elif engine == "mihomo":
        entry = {"_diagnostics_engine": "mihomo", "proxy": {"type": "vless", "server": "node.example", "client-fingerprint": "safari", "servername": "front.example", "uuid": "secret"}}
        variant = extended._with_tls_fingerprint(entry, "firefox")
        assert variant["proxy"]["client-fingerprint"] == "firefox"
        variant["proxy"]["client-fingerprint"] = "safari"
    else:
        entry = {"_diagnostics_engine": "mihomo", "proxy_yaml": "  - name: N\n    type: trojan\n    password: secret\n    client-fingerprint: safari\n    servername: front.example\n"}
        variant = extended._with_tls_fingerprint(entry, "firefox")
        assert "client-fingerprint: firefox" in variant["proxy_yaml"]
        variant["proxy_yaml"] = variant["proxy_yaml"].replace("client-fingerprint: firefox", "client-fingerprint: safari")
    assert variant == entry


def test_ipv6_checks_its_own_firewall_before_claiming_a_direct_path(monkeypatch):
    monkeypatch.setattr(base.sys, "platform", "linux")
    calls = []
    monkeypatch.setattr(base, "_xkeen_direct_mark", lambda **kw: calls.append(kw) or None)
    address = (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2001:db8::1", 443, 0, 0))
    assert base._address_direct_mark(address, 0xff) is None
    assert calls == [{"ipv6": True}]


def test_wireguard_targets_and_pin_keep_the_actual_udp_endpoint():
    entry = {"protocol": "wireguard", "settings": {"secretKey": "secret", "peers": [{"publicKey": "public", "endpoint": "wg.example:51820"}]}}
    target = base.xray_outbound_targets(entry)[0]
    assert target["network"] == "udp"
    pinned = extended._pin_entry(entry, target, "2001:db8::1")
    assert pinned["settings"]["peers"][0]["endpoint"] == "[2001:db8::1]:51820"
    assert pinned["settings"]["secretKey"] == "secret"


@pytest.mark.parametrize("network", ["tcp", "udp"])
def test_advanced_api_uses_cached_node_and_actual_engine_with_bounded_trials(monkeypatch, tmp_path, network):
    target = base.make_target("node.example", 443, network=network, protocol="vless", tls=True)
    entry = {"protocol": "vless", "settings": {"vnext": [{"address": "node.example", "port": 443, "users": [{"id": "private-uuid"}]}]}}
    ref = base.register_proxy_context([entry], 1, [target])
    monkeypatch.setattr(base.socket, "getaddrinfo", lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.1", 443))])
    monkeypatch.setattr(base, "_resource_addresses", lambda _h, _p: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))])
    monkeypatch.setattr(base, "_xkeen_direct_mark", lambda: 0)
    port_calls = []
    monkeypatch.setattr(base, "_probe_address", lambda _t, a, _m, **_k: port_calls.append(a[4][1]) or {"status": "reachable", "tcp_ms": 1})
    sessions = []

    @contextmanager
    def session(pinned):
        sessions.append(pinned)
        yield {"status": "ok", "port": 12345}
        sessions.append("terminated")

    monkeypatch.setattr(base, "_resource_proxy_session", session)
    calls = []

    def transfer(_parts, *, address, proxy_port=None, bypass_mark=0, transfer_bytes, duration, paced=False):
        assert 0 < duration <= 12
        calls.append((proxy_port, transfer_bytes, paced, address[4][0]))
        return {"status": "transfer_ok", "stage": "body", "bytes_received": transfer_bytes, "requested_bytes": transfer_bytes}

    monkeypatch.setattr(base, "_resource_http_request", transfer)
    app = Flask(__name__)
    app.register_blueprint(create_provider_diagnostics_blueprint(xray_configs_dir=str(tmp_path), mihomo_config_file=str(tmp_path / "mihomo.yaml")))
    response = app.test_client().post("/api/provider-diagnostics/advanced-probe", json={"ref": ref, "index": 0, "ports": "22,8443", "target": {"host": "attacker.example", "port": 22}})
    assert response.status_code == 200
    result = response.json["result"]
    assert result["address_results"][0]["diagnosis"]["verdict"] == "transfer_ok"
    assert result["address_results"][0]["transport_verified"] is True
    assert sessions[0]["settings"]["vnext"][0]["address"] == "198.51.100.1"
    assert sessions[-1] == "terminated"
    assert port_calls == ([443, 22, 8443] if network == "tcp" else [])
    assert len(calls) == 16  # two direct large checks, then seven sizes through each destination
    assert "private-uuid" not in response.get_data(as_text=True)
    assert base._proxy_context(ref, 0)[0] == entry


def test_tls_profile_probe_uses_the_actual_core_and_returns_only_safe_profile(monkeypatch):
    target = base.make_target("node.example", 443, protocol="vless", tls=True, sni="front.example")
    entry = {"protocol": "vless", "settings": {"vnext": [{"address": "node.example", "port": 443, "users": [{"id": "private"}]}]},
             "streamSettings": {"security": "tls", "tlsSettings": {"fingerprint": "chrome", "serverName": "front.example", "alpn": ["h2"]}}}
    ref = base.register_proxy_context([entry], 1, [target])
    monkeypatch.setattr(base, "_resource_addresses", lambda _h, _p: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("203.0.113.8", 443))])
    monkeypatch.setattr(base.socket, "getaddrinfo", lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.1", 443))])

    variants = []
    @contextmanager
    def session(pinned):
        assert pinned["settings"]["vnext"][0]["users"][0]["id"] == "private"
        assert pinned["settings"]["vnext"][0]["address"] == "198.51.100.1"
        assert pinned["streamSettings"]["tlsSettings"]["serverName"] == "front.example"
        variants.append(pinned["streamSettings"]["tlsSettings"]["fingerprint"])
        yield {"status": "ok", "port": 12345}

    monkeypatch.setattr(base, "_resource_proxy_session", session)
    calls = []
    def request(*args, **kwargs):
        calls.append(kwargs)
        return {"status": "transfer_ok", "stage": "body", "bytes_received": 8192, "requested_bytes": 8192, "tls_ms": 12, "total_ms": 20}
    monkeypatch.setattr(base, "_resource_http_request", request)
    result = extended.tls_profile_probe({"ref": ref, "index": 0})
    assert result["status"] == "ok"
    assert result["engine"] == "Xray"
    assert result["configured"] == {"fingerprint": "chrome", "server_name": "front.example", "alpn": ["h2"]}
    assert [item["fingerprint"] for item in result["profiles"]] == ["configured", "chrome", "firefox"]
    assert result["verdict"] == "profile_not_sensitive"
    assert all(item["transfer_bytes"] == 8192 for item in calls)
    assert len(calls) == 6
    assert variants == ["chrome", "chrome", "firefox", "firefox", "chrome", "chrome"]
    assert base._proxy_context(ref, 0)[0] == entry
    assert "private" not in str(result)


@pytest.mark.parametrize(("original_statuses", "alternate_status", "verdict"), [
    (["transfer_timeout", "transfer_timeout"], "transfer_ok", "profile_sensitive"),
    (["transfer_timeout", "transfer_ok"], "transfer_ok", "undetermined"),
    (["core_start_failed", "core_start_failed"], "transfer_ok", "undetermined"),
    (["transfer_timeout", "transfer_timeout"], "transfer_timeout", "undetermined"),
])
def test_tls_profile_requires_repeatable_network_results(monkeypatch, original_statuses, alternate_status, verdict):
    entry = {"protocol": "vless", "settings": {"vnext": [{"address": "node.example", "port": 443}]}}
    ref = base.register_proxy_context([entry], 1, [base.make_target("node.example", 443, tls=True)])
    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.1", 443))
    monkeypatch.setattr(base, "_resource_addresses", lambda *_a: [address])
    monkeypatch.setattr(base.socket, "getaddrinfo", lambda *_a, **_k: [address])
    original = iter(original_statuses * 2)
    def attempt(_entry, _address, *, fingerprint, deadline):
        return {"status": next(original) if fingerprint is None else alternate_status}
    monkeypatch.setattr(extended, "_tls_profile_attempt", attempt)
    assert extended.tls_profile_probe({"ref": ref, "index": 0})["verdict"] == verdict


def test_tls_profile_api_rejects_expired_context_and_invalid_payload(tmp_path):
    app = Flask(__name__)
    app.register_blueprint(create_provider_diagnostics_blueprint(xray_configs_dir=str(tmp_path), mihomo_config_file=str(tmp_path / "mihomo.yaml")))
    client = app.test_client()
    for payload in ([], {}, {"ref": "expired", "index": 0}):
        response = client.post("/api/provider-diagnostics/tls-profile", json=payload)
        assert response.status_code == 400


@pytest.mark.parametrize("payload", [{}, {"target": []}, {"ref": "expired", "index": 0}, {"target": {"host": "node.example", "port": 443}, "ports": [0]}, {"target": {"host": "node.example", "port": 443}, "ports": [22, 23, 24, 25, 26]}])
def test_advanced_rejects_invalid_requests_without_network(payload):
    with pytest.raises(ValueError):
        extended.advanced_probe(payload)


def test_advanced_session_is_terminated_even_when_a_probe_fails(monkeypatch):
    # Cover the shared lifecycle with an exception thrown after the yield.
    from services import xray_subscriptions

    class Process:
        pass

    stopped = []
    monkeypatch.setattr(xray_subscriptions, "_find_xray_binary", lambda: "/fake/xray")
    monkeypatch.setattr(xray_subscriptions, "_reserve_local_port", lambda: 12345)
    monkeypatch.setattr(xray_subscriptions, "_start_probe_process", lambda **_k: (Process(), ""))
    monkeypatch.setattr(xray_subscriptions, "_terminate_process", lambda p: stopped.append(p))
    with pytest.raises(RuntimeError):
        with base._resource_proxy_session({"protocol": "freedom"}):
            raise RuntimeError("probe failed")
    assert len(stopped) == 1
