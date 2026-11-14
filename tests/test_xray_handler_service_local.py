"""Isolated real-Xray checks for HandlerService and subscription recovery.

These tests deliberately use Xray's own CLI client, so they need no grpcio or
router.  Set ``XKEEN_REAL_XRAY`` to a real Xray binary to run them; the panel's
E2E stub (``#!/bin/sh; exit 0``) is ignored automatically.
"""

from __future__ import annotations

import json
import os
import socket
import socketserver
import ssl
import struct
import subprocess
import threading
import time
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


def _real_xray() -> str | None:
    candidate = str(os.environ.get("XKEEN_REAL_XRAY") or "").strip()
    if not candidate:
        return None
    path = Path(candidate)
    if not path.is_file() or not os.access(path, os.X_OK):
        return None
    try:
        probe = subprocess.run([str(path), "version"], capture_output=True, text=True, timeout=5, check=False)
    except OSError:
        return None
    return str(path) if probe.returncode == 0 and "Xray " in probe.stdout else None


XRAY = _real_xray()
pytestmark = pytest.mark.skipif(not XRAY, reason="set XKEEN_REAL_XRAY to a real Xray binary")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _reality_outbound(*, address: str, server_name: str, short_id: str) -> dict:
    return {
        "protocol": "vless",
        "settings": {
            "vnext": [
                {
                    "address": address,
                    "port": 443,
                    "users": [
                        {
                            "id": "11111111-1111-1111-1111-111111111111",
                            "encryption": "none",
                            "flow": "xtls-rprx-vision",
                        }
                    ],
                }
            ]
        },
        "streamSettings": {
            "network": "tcp",
            "security": "reality",
            "realitySettings": {
                "serverName": server_name,
                "fingerprint": "chrome",
                "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "shortId": short_id,
            },
        },
        "tag": "dynamic-reality",
    }


def _write_config(path: Path, api_port: int) -> dict:
    config = {
        "log": {"loglevel": "warning"},
        "api": {
            "tag": "api",
            "listen": f"127.0.0.1:{api_port}",
            "services": ["HandlerService", "RoutingService", "ReflectionService"],
        },
        "outbounds": [
            {"protocol": "freedom", "tag": "direct"},
            _reality_outbound(
                address="example.com",
                server_name="example.com",
                short_id="0123456789abcdef",
            ),
        ],
        "routing": {
            "rules": [
                {"type": "field", "outboundTag": "dynamic-reality", "domain": ["domain:example.com"]}
            ]
        },
        "observatory": {
            "subjectSelector": ["dynamic-reality"],
            "probeUrl": "https://example.com/generate_204",
            "probeInterval": "1m",
        },
    }
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return config


def _api(server: str, command: str, *args: str) -> subprocess.CompletedProcess[str]:
    assert XRAY is not None
    return subprocess.run(
        [XRAY, "api", command, f"--server={server}", *args],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


@pytest.fixture
def xray_runtime(tmp_path: Path):
    api_port = _free_port()
    config_path = tmp_path / "config.json"
    config = _write_config(config_path, api_port)
    assert XRAY is not None
    checked = subprocess.run(
        [XRAY, "-test", "-config", str(config_path)],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert checked.returncode == 0, checked.stderr or checked.stdout
    process = subprocess.Popen(
        [XRAY, "run", "-config", str(config_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    server = f"127.0.0.1:{api_port}"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout else ""
            raise AssertionError(f"Xray exited before API became ready: {output}")
        listed = _api(server, "lso")
        if listed.returncode == 0:
            break
        time.sleep(0.1)
    else:
        process.terminate()
        pytest.fail("Xray HandlerService did not become ready")
    try:
        yield process, server, config, config_path
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def test_handler_service_applies_reality_rotation_without_restarting_xray(xray_runtime, tmp_path: Path):
    process, server, original_config, config_path = xray_runtime
    original_pid = process.pid
    invalid = tmp_path / "invalid.json"
    invalid.write_text(json.dumps({"outbounds": [{"protocol": "unknown", "tag": "dynamic-reality"}]}), encoding="utf-8")

    rejected = _api(server, "ado", str(invalid))
    assert rejected.returncode != 0
    assert "dynamic-reality" in rejected.stdout
    assert "example.com" in _api(server, "lso").stdout

    removed = _api(server, "rmo", "dynamic-reality")
    assert removed.returncode == 0, removed.stderr
    rotated = tmp_path / "rotated.json"
    rotated.write_text(
        json.dumps(
            {
                "outbounds": [
                    _reality_outbound(
                        address="example.net",
                        server_name="example.net",
                        short_id="fedcba9876543210",
                    )
                ]
            }
        ),
        encoding="utf-8",
    )
    added = _api(server, "ado", str(rotated))
    assert added.returncode == 0, added.stderr

    listed = _api(server, "lso")
    assert listed.returncode == 0
    assert "example.net" in listed.stdout
    assert "example.com" not in listed.stdout
    runtime = json.loads(listed.stdout)
    dynamic = next(item for item in runtime["outbounds"] if item.get("tag") == "dynamic-reality")
    security = dynamic["senderSettings"]["streamSettings"]["securitySettings"][0]
    assert security["serverName"] == "example.net"
    assert security["shortId"] == [254, 220, 186, 152, 118, 84, 50, 16]
    assert process.poll() is None
    assert process.pid == original_pid

    # HandlerService changes runtime state only; the persisted panel config is
    # still the old validated document until the caller commits it separately.
    assert json.loads(config_path.read_text(encoding="utf-8")) == original_config


def test_handler_service_keeps_routing_api_alive_after_rotation(xray_runtime, tmp_path: Path):
    _process, server, _config, _config_path = xray_runtime
    removed = _api(server, "rmo", "dynamic-reality")
    assert removed.returncode == 0, removed.stderr
    rotated = tmp_path / "rotated.json"
    rotated.write_text(
        json.dumps(
            {
                "outbounds": [
                    _reality_outbound(
                        address="example.net",
                        server_name="example.net",
                        short_id="fedcba9876543210",
                    )
                ]
            }
        ),
        encoding="utf-8",
    )
    assert _api(server, "ado", str(rotated)).returncode == 0
    rules = _api(server, "lsrules")
    assert rules.returncode == 0, rules.stderr
    assert "dynamic-reality" in rules.stdout
    assert _api(server, "lso").returncode == 0


def test_panel_handler_service_applies_rotation_without_restart(xray_runtime, monkeypatch):
    from services import xray_handler_service as hot

    process, server, config, config_path = xray_runtime
    monkeypatch.setenv("XKEEN_SUBSCRIPTIONS_HOT_APPLY", "1")
    monkeypatch.setenv("XKEEN_XRAY_BINARY", XRAY)
    previous = {config_path.name: config_path.read_bytes()}
    config["outbounds"][1]["streamSettings"]["realitySettings"].update(serverName="example.net", shortId="fedcba9876543210")
    config_path.write_text(json.dumps(config), encoding="utf-8")

    result = hot.try_apply(str(config_path.parent), previous)

    assert result and result["hot_applied"] is True
    assert result["restarted"] is False
    assert process.poll() is None
    assert "example.net" in _api(server, "lso").stdout


@pytest.mark.parametrize("outcome", ["success", "stopped", "running", "recovery_failed"])
def test_subscription_batch_with_real_xray_preserves_validated_tree(tmp_path, monkeypatch, outcome):
    from services import xray_subscriptions as subs

    configs = tmp_path / "configs"
    state_dir = tmp_path / "state"
    jsonc_dir = tmp_path / "jsonc"
    for directory in (configs, state_dir, jsonc_dir):
        directory.mkdir()
    monkeypatch.setenv("XKEEN_XRAY_BINARY", XRAY)
    monkeypatch.setenv("XKEEN_SUBSCRIPTIONS_PREFLIGHT", "1")
    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    api_port = _free_port()
    base_path = configs / "00_base.json"
    base = _write_config(base_path, api_port)
    base["routing"] = {
        "balancers": [{"tag": "pool", "selector": ["sub--"], "strategy": {"type": "leastPing"}, "fallbackTag": "dynamic-reality"}],
        "rules": [{"type": "field", "inboundTag": ["dns-over-vless"], "balancerTag": "pool"}],
    }
    base["dns"] = {"tag": "dns-over-vless", "servers": ["https://1.1.1.1/dns-query"]}
    base["observatory"]["subjectSelector"] = ["sub--"]
    base_path.write_text(json.dumps(base), encoding="utf-8")
    node = _reality_outbound(address="example.com", server_name="example.com", short_id="0123456789abcdef")
    body = {"outbounds": [node]}
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda _: (json.dumps(body), {}))
    subs.upsert_subscription(str(state_dir), {
        "id": "sub", "tag": "sub", "url": "https://example.com/sub",
        "enabled": True, "ping_enabled": True, "interval_hours": 1,
    })
    first = subs.refresh_subscription(str(state_dir), "sub", xray_configs_dir=str(configs), restart=False)
    assert first["ok"], first
    assert subs.xray_transactions.check_confdir(str(configs))["ok"] is True
    before = {path.name: path.read_bytes() for path in configs.iterdir() if path.is_file()}
    process = None
    server = f"127.0.0.1:{api_port}"

    def stop():
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)

    def start():
        nonlocal process
        process = subprocess.Popen([XRAY, "run", "-confdir", str(configs)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and process.poll() is None:
            if _api(server, "lso").returncode == 0:
                return True
            time.sleep(0.1)
        return False

    calls = []

    def restart(**kwargs):
        calls.append(kwargs["source"])
        if len(calls) == 1 and outcome != "success":
            if outcome != "running":
                stop()
            return False
        stop()
        return False if outcome == "recovery_failed" else start()

    monkeypatch.setattr(subs, "_xkeen_runtime_stopped", lambda: process.poll() is not None)
    try:
        assert start(), "isolated Xray did not start"
        node["streamSettings"]["realitySettings"].update(serverName="example.net", shortId="fedcba9876543210")
        state = subs.load_subscription_state(str(state_dir))
        state["subscriptions"][0]["next_update_ts"] = 0
        subs._write_state(str(state_dir), state)
        result = subs.refresh_due_subscriptions(str(state_dir), xray_configs_dir=str(configs), restart_xkeen=restart)[0]
        assert result["ok"] is (outcome == "success"), result
        assert result["restarted"] is (outcome == "success")
        assert subs.xray_transactions.check_confdir(str(configs))["ok"] is True
        if outcome == "success":
            runtime = _api(server, "lso")
            assert "example.net" in runtime.stdout
            assert len(calls) == 1
            # The next identical download must leave the running process alone.
            pid = process.pid
            unchanged = subs.refresh_subscription(str(state_dir), "sub", xray_configs_dir=str(configs), restart_xkeen=restart)
            assert unchanged["ok"] and not unchanged["changed"]
            assert process.pid == pid and len(calls) == 1
            assert base_path.read_bytes() == before[base_path.name]
        else:
            assert {path.name: path.read_bytes() for path in configs.iterdir() if path.is_file()} == before
            assert result["recovered"] is (outcome == "stopped")
            assert subs.load_subscription_state(str(state_dir))["subscriptions"][0]["last_ok"] is False
            assert len(calls) == (1 if outcome == "running" else 2)
            if outcome != "recovery_failed":
                runtime = _api(server, "lso")
                assert runtime.returncode == 0
                assert "example.net" not in runtime.stdout
    finally:
        stop()


def _receive(sock, count):
    data = b""
    while len(data) < count:
        part = sock.recv(count - len(data))
        assert part, "proxy stream was closed"
        data += part
    return data


def _socks_stream(port, target):
    sock = socket.create_connection(("127.0.0.1", port), timeout=3)
    try:
        sock.sendall(b"\x05\x01\x00")
        assert _receive(sock, 2) == b"\x05\x00"
        sock.sendall(b"\x05\x01\x00\x01" + socket.inet_aton("127.0.0.1") + struct.pack("!H", target))
        assert _receive(sock, 10)[:2] == b"\x05\x00"
        return sock
    except Exception:
        sock.close()
        raise


@pytest.mark.parametrize("mode", ["manual", "batch", "api_failure"])
def test_real_reality_stream_leastping_fallback_and_dns_survive_panel_rotation(tmp_path, monkeypatch, mode):
    from services import xray_handler_service as hot
    from services import xray_subscriptions as subs

    probe_ready = threading.Event()

    class Echo(socketserver.BaseRequestHandler):
        def handle(self):
            while data := self.request.recv(4096):
                self.request.sendall(data)

    class Probe(BaseHTTPRequestHandler):
        def do_GET(self):
            probe_ready.wait(30)
            self.send_response(204)
            self.end_headers()

        def handle(self):
            try:
                super().handle()
            except (ssl.SSLError, ConnectionError):
                pass  # REALITY deliberately abandons its decoy handshake.

        def log_message(self, *_):
            pass

    class DNS(socketserver.BaseRequestHandler):
        def handle(self):
            query, sock = self.request
            answer = query[:2] + b"\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00" + query[12:]
            answer += b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04" + socket.inet_aton("127.0.0.42")
            sock.sendto(answer, self.client_address)

    with ExitStack() as stack:
        echo = stack.enter_context(socketserver.ThreadingTCPServer(("127.0.0.1", 0), Echo))
        probe = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 0), Probe))
        decoy = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 0), Probe))
        dns = stack.enter_context(socketserver.ThreadingUDPServer(("127.0.0.1", 0), DNS))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.minimum_version = ssl.TLSVersion.TLSv1_3
        # REALITY needs room to reproduce its EncryptedExtensions record.
        tls.set_alpn_protocols(["http/1.1"])
        tls.set_ecdh_curve("X25519")
        tls.load_cert_chain(Path(__file__).parent / "fixtures/xray_handler/decoy-test.pem")
        decoy.socket = tls.wrap_socket(decoy.socket, server_side=True, do_handshake_on_connect=False)
        for service in (echo, probe, decoy, dns):
            threading.Thread(target=service.serve_forever, daemon=True).start()
            stack.callback(service.shutdown)
        stack.callback(probe_ready.set)

        keys = subprocess.run([XRAY, "x25519"], capture_output=True, text=True, check=True).stdout.splitlines()
        private = next(line.split(":", 1)[1].strip() for line in keys if line.lower().startswith("private"))
        public = next(line.split(":", 1)[1].strip() for line in keys if line.lower().startswith(("password", "public")))
        uuid = "11111111-1111-1111-1111-111111111111"
        reality_port, api_port, socks_port, dns_port = [_free_port() for _ in range(4)]
        server_config = {
            "log": {"loglevel": "info"},
            "inbounds": [{"listen": "127.0.0.1", "port": reality_port, "protocol": "vless", "settings": {
                "clients": [{"id": uuid, "flow": "xtls-rprx-vision"}], "decryption": "none",
            }, "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": {
                "target": f"127.0.0.1:{decoy.server_port}", "serverNames": ["alpha.example.test", "beta.example.test"],
                "privateKey": private, "shortIds": ["0123456789abcdef", "fedcba9876543210"], "show": False,
            }}}],
            # Newer cores block private destinations of VLESS servers by
            # default; this isolated server must reach the local test peers.
            "outbounds": [{"protocol": "freedom", "tag": "direct", "settings": {
                "finalRules": [{"action": "allow", "ip": ["127.0.0.1/32"]}],
            }}],
        }
        server_path = tmp_path / "server.json"
        server_path.write_text(json.dumps(server_config), encoding="utf-8")
        backend_log = stack.enter_context((tmp_path / "server.log").open("w+", encoding="utf-8"))
        backend = subprocess.Popen([XRAY, "run", "-config", str(server_path)], stdout=backend_log, stderr=subprocess.STDOUT)
        stack.callback(lambda: backend.wait(timeout=5))
        stack.callback(backend.terminate)

        configs, state_dir, jsonc_dir = [tmp_path / name for name in ("configs", "state", "jsonc")]
        for directory in (configs, state_dir, jsonc_dir):
            directory.mkdir()
        monkeypatch.setenv("XKEEN_XRAY_BINARY", XRAY)
        monkeypatch.setenv("XKEEN_SUBSCRIPTIONS_HOT_APPLY", "1")
        monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
        monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
        node = _reality_outbound(address="127.0.0.1", server_name="alpha.example.test", short_id="0123456789abcdef")
        node["settings"]["vnext"][0]["port"] = reality_port
        node["streamSettings"]["realitySettings"]["publicKey"] = public
        reserve = json.loads(json.dumps(node))
        reserve["tag"] = "reserve"
        base = {
            "log": {"loglevel": "info"},
            "api": {"tag": "api", "listen": f"127.0.0.1:{api_port}", "services": ["HandlerService", "RoutingService"]},
            "inbounds": [
                {"tag": "socks", "listen": "127.0.0.1", "port": socks_port, "protocol": "socks", "settings": {"auth": "noauth"}},
                {"tag": "dns-over-vless", "listen": "127.0.0.1", "port": dns_port, "protocol": "dokodemo-door",
                 "settings": {"network": "udp", "address": "127.0.0.1", "port": dns.server_address[1]}},
            ],
            "outbounds": [{"protocol": "freedom", "tag": "direct"}, reserve],
            "routing": {"balancers": [{"tag": "pool", "selector": ["sub--"], "fallbackTag": "reserve", "strategy": {"type": "leastPing"}}],
                        "rules": [{"type": "field", "ruleTag": "issue43-pool", "inboundTag": ["socks", "dns-over-vless"], "balancerTag": "pool"}]},
            "observatory": {"subjectSelector": ["sub--"], "probeUrl": f"http://127.0.0.1:{probe.server_port}/", "probeInterval": "200ms"},
        }
        (configs / "05_routing.json").write_text(json.dumps({"routing": base.pop("routing")}), encoding="utf-8")
        (configs / "00_base.json").write_text(json.dumps(base), encoding="utf-8")
        monkeypatch.setattr(subs, "fetch_subscription_body", lambda _: (json.dumps({"outbounds": [node]}), {}))
        subs.upsert_subscription(str(state_dir), {
            "id": "sub", "tag": "sub", "url": "https://example.com/sub", "ping_enabled": True,
            "routing_balancer_tags": ["pool"], "routing_auto_rule": False,
            "sockopt_mark_255": False,
        })
        initial = subs.refresh_subscription(str(state_dir), "sub", xray_configs_dir=str(configs), restart=False)
        assert initial["ok"], initial
        process = None
        api = f"127.0.0.1:{api_port}"
        client_log = stack.enter_context((tmp_path / "client.log").open("w+", encoding="utf-8"))

        def stop_client():
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)

        stack.callback(stop_client)

        def start_client(**_kwargs):
            nonlocal process
            stop_client()
            process = subprocess.Popen([XRAY, "run", "-confdir", str(configs)], stdout=client_log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 10
            while process.poll() is None and time.monotonic() < deadline:
                if _api(api, "lso").returncode == 0:
                    return True
                time.sleep(0.05)
            return False

        assert start_client()
        assert "issue43-pool" in _api(api, "lsrules").stdout
        pid = process.pid
        query = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x04test\x07invalid\x00\x00\x01\x00\x01"

        def check_dns():
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(3)
                sock.sendto(query, ("127.0.0.1", dns_port))
                assert sock.recv(512).endswith(socket.inet_aton("127.0.0.42"))

        stream = stack.enter_context(_socks_stream(socks_port, echo.server_address[1]))
        stream.sendall(b"before")
        try:
            assert _receive(stream, 6) == b"before"
        except (OSError, AssertionError) as exc:
            pytest.fail(f"{exc}\n" + (tmp_path / "server.log").read_text(encoding="utf-8")[-5000:]
                        + (tmp_path / "client.log").read_text(encoding="utf-8")[-5000:])
        check_dns()
        assert "socks -> reserve" in (tmp_path / "client.log").read_text(encoding="utf-8")
        probe_ready.set()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if "sub--dynamic-reality" in _api(api, "bi", "pool").stdout:
                break
            time.sleep(0.1)
        else:
            pytest.fail("leastPing did not select the observed subscription node")
        # Keep a second stream through the observed node, as well as the
        # original stream opened while only the reserve was available.
        selected_stream = stack.enter_context(_socks_stream(socks_port, echo.server_address[1]))
        selected_stream.sendall(b"selected")
        assert _receive(selected_stream, 8) == b"selected"
        assert "socks -> sub--dynamic-reality" in (tmp_path / "client.log").read_text(encoding="utf-8")
        node["streamSettings"]["realitySettings"].update(serverName="beta.example.test", shortId="fedcba9876543210")
        failed = []
        if mode == "api_failure":
            original_api = hot._api

            def fail_once(binary, server, command, *args):
                if command == "ado" and not failed:
                    failed.append(True)
                    raise RuntimeError("injected API failure after removal")
                return original_api(binary, server, command, *args)

            monkeypatch.setattr(hot, "_api", fail_once)
        if mode == "batch":
            state = subs.load_subscription_state(str(state_dir))
            state["subscriptions"][0]["next_update_ts"] = 0
            subs._write_state(str(state_dir), state)
            result = subs.refresh_due_subscriptions(str(state_dir), xray_configs_dir=str(configs), restart_xkeen=start_client)[0]
        else:
            result = subs.refresh_subscription(str(state_dir), "sub", xray_configs_dir=str(configs), restart_xkeen=start_client)
        assert result["ok"], result
        if mode == "api_failure":
            assert failed and result["restarted"] and result["hot_apply_fallback"]
            assert process.pid != pid
        else:
            assert result["hot_applied"] and not result["restarted"]
            assert process.pid == pid
            stream.sendall(b"after")
            assert _receive(stream, 5) == b"after"
            selected_stream.sendall(b"selected-after")
            assert _receive(selected_stream, 14) == b"selected-after"
        check_dns()
        with _socks_stream(socks_port, echo.server_address[1]) as new_stream:
            new_stream.sendall(b"new")
            assert _receive(new_stream, 3) == b"new"
        assert "issue43-pool" in _api(api, "lsrules").stdout
        assert "beta.example.test" in _api(api, "lso").stdout
