"""Real-Xray smoke tests for the local HandlerService hot-apply path.

These tests deliberately use Xray's own CLI client, so they need no grpcio or
router.  Set ``XKEEN_REAL_XRAY`` to a real Xray binary to run them; the panel's
E2E stub (``#!/bin/sh; exit 0``) is ignored automatically.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import time
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
