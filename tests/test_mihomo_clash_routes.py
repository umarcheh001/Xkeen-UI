from __future__ import annotations

import json
from pathlib import Path

from flask import Flask

from routes.mihomo_clash import create_mihomo_clash_blueprint
from services.mihomo_clash_client import MihomoClashClientError, MihomoClashJSONResponse
from services.mihomo_clash_target import (
    MihomoClashDiagnostic,
    MihomoClashDiscovery,
    MihomoClashTarget,
)


class StubClient:
    def __init__(self, responses=None, error: MihomoClashClientError | None = None):
        self.responses = responses or {}
        self.error = error
        self.operations: list[str] = []

    def request_json(self, operation: str):
        self.operations.append(operation)
        if self.error:
            raise self.error
        return self.responses[operation]


def make_app(discovery, client: StubClient) -> Flask:
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(
        create_mihomo_clash_blueprint(
            mihomo_config_file="/safe/mihomo/config.yaml",
            mihomo_root="/safe/mihomo",
            discovery_factory=lambda _config, _root: discovery,
            client_factory=lambda _target: client,
        )
    )
    return app


def ready_discovery(*, secret: str = "fixture-secret") -> MihomoClashDiscovery:
    target = MihomoClashTarget(
        transport="tcp",
        port=9090,
        loopback_host="127.0.0.1",
        secret=secret,
    )
    return MihomoClashDiscovery(
        configured=True,
        target=target,
        secret_configured=bool(secret),
    )


def test_status_route_returns_versioned_redacted_dto():
    client = StubClient(
        responses={
            "version": MihomoClashJSONResponse(
                payload={"version": "alpha-test", "secret": "upstream-leak"},
                status=200,
                elapsed_ms=1.5,
                size_bytes=40,
            ),
            "configs": MihomoClashJSONResponse(
                payload={"mode": "rule", "secret": "upstream-leak", "tun": {"enable": True}},
                status=200,
                elapsed_ms=2.5,
                size_bytes=100,
            ),
        }
    )
    response = make_app(ready_discovery(), client).test_client().get("/api/mihomo/clash/status")

    body = response.get_json()
    serialized = json.dumps(body).lower()
    assert response.status_code == 200
    assert body["ok"] is True
    assert body["state"] == "ready"
    assert body["schema_version"] == 1
    assert body["core"]["version"] == "alpha-test"
    assert body["runtime"]["mode"] == "rule"
    assert body["api"]["transport"] == "tcp"
    assert body["api"]["secret_configured"] is True
    assert body["capabilities"]["status"] is True
    assert body["capabilities"]["proxy_groups"] is None
    assert body["security"] == {
        "mode": "tcp_authenticated",
        "recommended_transport": "unix",
        "panel_password_reuse": False,
        "migration_required": False,
    }
    assert body["telemetry"]["version"]["size_bytes"] == 40
    assert "fixture-secret" not in serialized
    assert "upstream-leak" not in serialized
    assert client.operations == ["version", "configs"]


def test_status_route_reports_missing_controller_as_operational_state():
    discovery = MihomoClashDiscovery(
        configured=False,
        diagnostics=(MihomoClashDiagnostic("controller_missing"),),
    )
    response = make_app(discovery, StubClient()).test_client().get("/api/mihomo/clash/status")
    body = response.get_json()
    assert response.status_code == 200
    assert body["ok"] is False
    assert body["state"] == "controller_missing"
    assert body["capabilities"]["status"] is False


def test_status_route_marks_lan_controller_without_secret_for_migration():
    discovery = MihomoClashDiscovery(
        configured=True,
        target=MihomoClashTarget(
            transport="tcp",
            port=9090,
            loopback_host="127.0.0.1",
        ),
        diagnostics=(MihomoClashDiagnostic("secret_missing_on_lan_bind", "warning"),),
    )
    client = StubClient(
        responses={
            "version": MihomoClashJSONResponse({}, 200, 1, 2),
            "configs": MihomoClashJSONResponse({}, 200, 1, 2),
        }
    )
    body = make_app(discovery, client).test_client().get("/api/mihomo/clash/status").get_json()
    assert body["security"] == {
        "mode": "tcp_lan_unprotected",
        "recommended_transport": "unix",
        "panel_password_reuse": False,
        "migration_required": True,
    }


def test_status_route_maps_upstream_auth_failure_without_exception_details():
    error = MihomoClashClientError(
        "api_unauthorized",
        "must-not-leak-secret-value",
        upstream_status=401,
    )
    response = make_app(ready_discovery(), StubClient(error=error)).test_client().get(
        "/api/mihomo/clash/status"
    )
    body = response.get_json()
    assert response.status_code == 200
    assert body["state"] == "unauthorized"
    assert body["error"] == {"code": "api_unauthorized", "retryable": False}
    assert "must-not-leak" not in json.dumps(body)


def test_status_route_maps_unreachable_core_without_disclosing_target():
    error = MihomoClashClientError(
        "upstream_unreachable",
        "socket path /private/mihomo.sock failed",
        retryable=True,
    )
    response = make_app(ready_discovery(secret=""), StubClient(error=error)).test_client().get(
        "/api/mihomo/clash/status"
    )
    serialized = json.dumps(response.get_json())
    assert response.status_code == 200
    assert response.get_json()["state"] == "core_stopped"
    assert "/private/mihomo.sock" not in serialized


def test_routes_registry_registers_mihomo_clash_status(monkeypatch):
    import routes
    from core.context import AppContext
    from core.settings import Settings

    app = Flask(__name__)
    app.config["TESTING"] = True
    monkeypatch.setattr("routes.mihomo_clash.discover_mihomo_clash_target", lambda *_args: None)

    # Register only enough of the real registry to assert the route contract:
    # replacing Flask.register_blueprint keeps unrelated optional services out
    # of this focused test while preserving factory construction.
    registered: list[str] = []
    original_register = app.register_blueprint

    def capture(blueprint, *args, **kwargs):
        registered.append(blueprint.name)
        if blueprint.name == "mihomo_clash":
            return original_register(blueprint, *args, **kwargs)
        return None

    monkeypatch.setattr(app, "register_blueprint", capture)
    context = AppContext(
        settings=Settings(
            ui_state_dir="/tmp/state",
            base_etc_dir="/tmp/etc",
            base_var_dir="/tmp/var",
        ),
        logger=app.logger,
        ui_state_dir="/tmp/state",
        github_owner="owner",
        github_repo="repo",
        mihomo_config_file="/tmp/mihomo/config.yaml",
        mihomo_templates_dir="/tmp/mihomo/templates",
        mihomo_default_template="/tmp/mihomo/templates/custom.yaml",
        xray_configs_dir="/tmp/xray",
        xray_configs_dir_real="/tmp/xray",
        routing_file="/tmp/xray/05.json",
        routing_file_raw="/tmp/xray/05.jsonc",
        inbounds_file="/tmp/xray/03.json",
        outbounds_file="/tmp/xray/04.json",
        backup_dir="/tmp/backup",
        backup_dir_real="/tmp/backup",
        xray_error_log="/tmp/error.log",
        load_json=lambda *_a, **_k: {},
        save_json=lambda *_a, **_k: None,
        strip_json_comments_text=lambda value: value,
        snapshot_xray_config_before_overwrite=lambda *_a, **_k: None,
        list_backups=lambda *_a, **_k: [],
        detect_backup_target_file=lambda *_a, **_k: None,
        find_latest_auto_backup_for=lambda *_a, **_k: None,
        restart_xkeen=lambda *_a, **_k: None,
        append_restart_log=lambda *_a, **_k: None,
    )

    routes.register_blueprints(app, context)

    assert "mihomo_clash" in registered
    assert any(rule.rule == "/api/mihomo/clash/status" for rule in app.url_map.iter_rules())
