from __future__ import annotations

import json
import socket
import tempfile
import time
from pathlib import Path

import pytest
from flask import Flask

from routes.mihomo_clash import create_mihomo_clash_blueprint
from services.mihomo_clash_client import MihomoClashClient
from services.mihomo_clash_dto import build_mihomo_clash_log_entry_dto
from services.mihomo_clash_target import discover_mihomo_clash_target
from tests.support.fake_mihomo import FakeMihomo, FakeMihomoState


def _app(config: Path) -> Flask:
    app = Flask(__name__)
    app.secret_key = "fixture-app-secret"
    app.config["TESTING"] = True
    app.register_blueprint(
        create_mihomo_clash_blueprint(
            mihomo_config_file=str(config),
            mihomo_root=str(config.parent),
            device_map_factory=lambda: {
                "192.0.2.1": {"name": "fixture-laptop"},
            },
        )
    )
    return app


def _config(tmp_path: Path, port: int, secret: str = "fixture-secret") -> Path:
    config = tmp_path / "config.yaml"
    config.write_text(
        f'external-controller: "0.0.0.0:{port}"\nsecret: "{secret}"\n',
        encoding="utf-8",
    )
    return config


def _unix_config(tmp_path: Path, socket_path: Path, secret: str = "fixture-secret") -> Path:
    config = tmp_path / "config.yaml"
    config.write_text(
        f'external-controller-unix: "{socket_path.relative_to(tmp_path)}"\n'
        f'secret: "{secret}"\n',
        encoding="utf-8",
    )
    return config


def test_stateful_fake_mihomo_exercises_real_discovery_client_routes_and_mutations(
    tmp_path: Path,
    monkeypatch,
):
    state = FakeMihomoState(connection_count=3)
    with FakeMihomo(state) as upstream:
        monkeypatch.setenv("XKEEN_CLASH_API_ALLOWED_PORTS", str(upstream.port))
        client = _app(_config(tmp_path, upstream.port)).test_client()

        status = client.get("/api/mihomo/clash/status")
        groups = client.get("/api/mihomo/clash/proxy-groups")
        rules = client.get("/api/mihomo/clash/rules")
        providers = client.get("/api/mihomo/clash/providers")
        updated_proxy = client.post("/api/mihomo/clash/providers/proxy/fixture-proxy/update")
        updated_rules = client.post("/api/mihomo/clash/providers/rule/fixture-rules/update")
        healthcheck = client.post("/api/mihomo/clash/providers/proxy/fixture-proxy/healthcheck")
        discovery = discover_mihomo_clash_target(str(tmp_path / "config.yaml"), str(tmp_path))
        assert discovery.target is not None
        log_frames = list(MihomoClashClient(discovery.target).iter_json_frames("logs_stream"))
        normalized_logs = [
            build_mihomo_clash_log_entry_dto(
                frame,
                sequence=index,
                secret=discovery.target.secret,
            )
            for index, frame in enumerate(log_frames, 1)
        ]
        selected = client.put(
            "/api/mihomo/clash/proxy-groups/AUTO",
            json={"name": "node-b"},
        )
        delay = client.post(
            "/api/mihomo/clash/delay",
            json={"scope": "proxy", "name": "node-b", "preset": "google"},
        )
        before = client.get("/api/mihomo/clash/connections")
        first_id = before.get_json()["connections"][0]["id"]
        disconnected = client.delete(f"/api/mihomo/clash/connections/{first_id}")
        after_one = client.get("/api/mihomo/clash/connections")
        repeated_disconnect = client.delete(f"/api/mihomo/clash/connections/{first_id}")
        disconnected_all = client.delete(
            "/api/mihomo/clash/connections",
            json={"confirm": True, "count": 2},
        )
        after_all = client.get("/api/mihomo/clash/connections")

    assert status.status_code == 200
    assert status.get_json()["core"]["version"] == "Mihomo Meta fake-pr8"
    assert groups.get_json()["groups"][0]["now"] == "node-a"
    assert rules.get_json()["rules"][0]["target"] == "AUTO"
    assert [item["kind"] for item in providers.get_json()["providers"]] == ["proxy", "rule"]
    assert updated_proxy.status_code == 200
    assert updated_rules.status_code == 200
    assert healthcheck.status_code == 200
    assert state.provider_updates == [("proxy", "fixture-proxy"), ("rule", "fixture-rules")]
    assert state.provider_healthchecks == ["fixture-proxy"]
    assert len(normalized_logs) == 2
    assert normalized_logs[1]["message"] == "Bearer [redacted]"
    assert normalized_logs[1]["fields"] == {"host": "fixture.test"}
    assert selected.get_json()["reconciled"] is True
    assert selected.get_json()["group"]["now"] == "node-b"
    assert delay.get_json()["results"] == [{"name": "node-b", "delay_ms": 42}]
    assert before.get_json()["total_connections"] == 3
    assert before.get_json()["connections"][0]["metadata"]["source_name"] == "fixture-laptop"
    assert disconnected.status_code == 200
    assert after_one.get_json()["total_connections"] == 2
    assert first_id not in {item["id"] for item in after_one.get_json()["connections"]}
    assert repeated_disconnect.status_code == 409
    assert repeated_disconnect.get_json()["code"] == "connection_not_found"
    assert disconnected_all.get_json()["count"] == 2
    assert after_all.get_json()["total_connections"] == 0
    assert all(
        item["authorization"] == "Bearer fixture-secret"
        for item in state.requests
    )
    assert "fixture-secret" not in json.dumps(
        [
            status.get_json(),
            groups.get_json(),
            rules.get_json(),
            providers.get_json(),
            selected.get_json(),
            delay.get_json(),
            before.get_json(),
        ]
    )


def test_fake_mihomo_error_restart_and_timeout_recovery_are_safe(
    tmp_path: Path,
    monkeypatch,
):
    state = FakeMihomoState(connection_count=1, forced_status={"/version": 503})
    with FakeMihomo(state) as upstream:
        monkeypatch.setenv("XKEEN_CLASH_API_ALLOWED_PORTS", str(upstream.port))
        client = _app(_config(tmp_path, upstream.port)).test_client()

        unavailable = client.get("/api/mihomo/clash/status").get_json()
        state.forced_status.clear()
        recovered = client.get("/api/mihomo/clash/status").get_json()
        state.delay_seconds = 2.2
        started = time.monotonic()
        timed_out = client.get("/api/mihomo/clash/status").get_json()
        elapsed = time.monotonic() - started
        state.delay_seconds = 0
        recovered_again = client.get("/api/mihomo/clash/status").get_json()

    assert unavailable["state"] == "error"
    assert unavailable["error"]["code"] == "upstream_http_error"
    assert recovered["state"] == "ready"
    assert timed_out["state"] == "core_stopped"
    assert timed_out["error"]["code"] == "upstream_timeout"
    assert 1.8 <= elapsed < 3.5
    assert recovered_again["state"] == "ready"


def test_fake_mihomo_auth_failure_recovers_after_config_correction(
    tmp_path: Path,
    monkeypatch,
):
    state = FakeMihomoState(secret="upstream-fixture-secret")
    with FakeMihomo(state) as upstream:
        monkeypatch.setenv("XKEEN_CLASH_API_ALLOWED_PORTS", str(upstream.port))
        config = _config(tmp_path, upstream.port, secret="wrong-fixture-secret")
        client = _app(config).test_client()

        unauthorized = client.get("/api/mihomo/clash/status").get_json()
        config.write_text(
            f'external-controller: "127.0.0.1:{upstream.port}"\n'
            'secret: "upstream-fixture-secret"\n',
            encoding="utf-8",
        )
        recovered = client.get("/api/mihomo/clash/status").get_json()

    assert unauthorized["state"] == "unauthorized"
    assert unauthorized["error"] == {"code": "api_unauthorized", "retryable": False}
    assert recovered["state"] == "ready"
    assert "upstream-fixture-secret" not in json.dumps([unauthorized, recovered])


@pytest.mark.skipif(not hasattr(socket, "AF_UNIX"), reason="Unix sockets are unavailable")
def test_stateful_fake_mihomo_exercises_unix_discovery_client_and_facade():
    # macOS limits AF_UNIX paths to 103 bytes; pytest's nested tmp_path can
    # exceed that before the fixture even adds a socket filename.
    short_tmp = "/tmp" if Path("/tmp").is_dir() else None
    with tempfile.TemporaryDirectory(prefix="xk-pr8-", dir=short_tmp) as temp_root:
        root = Path(temp_root)
        socket_path = root / "mihomo.sock"
        state = FakeMihomoState(connection_count=2)
        with FakeMihomo(state, socket_path=socket_path):
            client = _app(_unix_config(root, socket_path)).test_client()

            status = client.get("/api/mihomo/clash/status")
            connections = client.get("/api/mihomo/clash/connections")

    assert status.status_code == 200
    assert status.get_json()["state"] == "ready"
    assert status.get_json()["api"]["transport"] == "unix"
    assert status.get_json()["security"]["mode"] == "unix_socket"
    assert str(socket_path) not in json.dumps(status.get_json())
    assert connections.status_code == 200
    assert connections.get_json()["total_connections"] == 2
    assert all(item["authorization"] == "Bearer fixture-secret" for item in state.requests)


def test_fake_mihomo_large_snapshot_is_bounded_and_fast_locally(
    tmp_path: Path,
    monkeypatch,
):
    state = FakeMihomoState(connection_count=500)
    with FakeMihomo(state) as upstream:
        monkeypatch.setenv("XKEEN_CLASH_API_ALLOWED_PORTS", str(upstream.port))
        client = _app(_config(tmp_path, upstream.port)).test_client()
        started = time.perf_counter()
        response = client.get("/api/mihomo/clash/connections")
        elapsed_ms = (time.perf_counter() - started) * 1000

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["total_connections"] == 500
    assert payload["truncated"] is True
    assert len(payload["connections"]) == 250
    assert len(response.data) < 512 * 1024
    # A generous desktop/CI budget catches accidental quadratic work without
    # pretending to be a mipsle router measurement.
    assert elapsed_ms < 1500
