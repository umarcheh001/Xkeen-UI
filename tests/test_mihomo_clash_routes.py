from __future__ import annotations

import json
from pathlib import Path

from flask import Flask

from routes.mihomo_clash import create_mihomo_clash_blueprint
from routes.mihomo_clash import _load_proxy_transport_index
import routes.mihomo_clash as mihomo_clash_routes
from services.mihomo_clash_client import MihomoClashClientError, MihomoClashJSONResponse
from services.mihomo_clash_guard import MihomoClashActionRejected
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
        self.selections: list[tuple[str, str]] = []
        self.unfixed: list[str] = []
        self.delays: list[tuple[str, str, str]] = []
        self.provider_delays: list[tuple[str, str, str]] = []
        self.disconnected: list[str] = []
        self.disconnected_all = 0
        self.provider_updates: list[tuple[str, str]] = []
        self.provider_healthchecks: list[str] = []
        self.runtime_modes: list[str] = []

    def request_json(self, operation: str):
        self.operations.append(operation)
        if self.error:
            raise self.error
        return self.responses[operation]

    def request_memory(self):
        if self.error:
            raise self.error
        return self.responses.get(
            "memory",
            MihomoClashJSONResponse({"inuse": 200}, 200, 1, 16),
        )

    def select_proxy(self, group_name: str, proxy_name: str):
        self.selections.append((group_name, proxy_name))
        if self.error:
            raise self.error
        return MihomoClashJSONResponse(None, 204, 1, 0)

    def unfix_proxy(self, group_name: str):
        self.unfixed.append(group_name)
        if self.error:
            raise self.error
        return MihomoClashJSONResponse(None, 204, 1, 0)

    def request_delay(self, scope: str, name: str, *, preset: str):
        self.delays.append((scope, name, preset))
        if self.error:
            raise self.error
        return self.responses["delay"]

    def request_provider_proxy_delay(self, provider: str, name: str, *, preset: str):
        self.provider_delays.append((provider, name, preset))
        if self.error:
            raise self.error
        return self.responses["delay"]

    def disconnect_connection(self, connection_id: str):
        self.disconnected.append(connection_id)
        if self.error:
            raise self.error
        return MihomoClashJSONResponse(None, 204, 1, 0)

    def disconnect_all_connections(self):
        self.disconnected_all += 1
        if self.error:
            raise self.error
        return MihomoClashJSONResponse(None, 204, 1, 0)

    def update_provider(self, kind: str, name: str):
        self.provider_updates.append((kind, name))
        if self.error:
            raise self.error
        return MihomoClashJSONResponse(None, 204, 1, 0)

    def healthcheck_provider(self, name: str):
        self.provider_healthchecks.append(name)
        if self.error:
            raise self.error
        return MihomoClashJSONResponse(None, 204, 1, 0)

    def set_runtime_mode(self, mode: str):
        self.runtime_modes.append(mode)
        if self.error:
            raise self.error
        current = self.responses.get("configs")
        if current and isinstance(current.payload, dict):
            current.payload["mode"] = mode
        return MihomoClashJSONResponse(None, 204, 1, 0)


def make_app(
    discovery,
    client: StubClient,
    *,
    audit_logger=None,
    device_map_factory=None,
    mihomo_config_file="/safe/mihomo/config.yaml",
    mihomo_root="/safe/mihomo",
    egress_info_factory=None,
) -> Flask:
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(
        create_mihomo_clash_blueprint(
            mihomo_config_file=mihomo_config_file,
            mihomo_root=mihomo_root,
            discovery_factory=lambda _config, _root: discovery,
            client_factory=lambda _target: client,
            audit_logger=audit_logger,
            **({"egress_info_factory": egress_info_factory} if egress_info_factory else {}),
            **({"device_map_factory": device_map_factory} if device_map_factory else {}),
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
    assert body["capabilities"]["runtime_mode_switch"] is True
    assert body["capabilities"]["proxy_groups"] is None
    assert body["capabilities"]["rules"] is True
    assert body["capabilities"]["providers"] is True
    assert body["capabilities"]["provider_update"] is True
    assert body["capabilities"]["provider_healthcheck"] is True
    assert body["capabilities"]["logs"] is True
    assert body["security"] == {
        "mode": "tcp_authenticated",
        "recommended_transport": "tcp-loopback",
        "recommended_value": "external-controller: 127.0.0.1:9090 + secret",
        "panel_password_reuse": False,
        "migration_required": False,
        "setup_required": False,
    }
    assert body["telemetry"]["version"]["size_bytes"] == 40
    assert "fixture-secret" not in serialized
    assert "upstream-leak" not in serialized
    assert client.operations == ["version", "configs"]


def test_egress_info_route_uses_mihomo_mixed_port_and_safe_dto():
    client = StubClient(responses={
        "configs": MihomoClashJSONResponse(
            payload={"mixed-port": 7890, "secret": "drop"},
            status=200,
            elapsed_ms=1,
            size_bytes=32,
        ),
    })
    calls = []

    def lookup(port, *, force_refresh=False):
        calls.append((port, force_refresh))
        return {
            "ip": "203.0.113.8",
            "ip_version": "IPv4",
            "city": "Helsinki",
            "region": "Uusimaa",
            "country": "Finland",
            "country_code": "FI",
            "asn": "AS64500",
            "organization": "Example Network",
            "timezone": "Europe/Helsinki",
            "cached": False,
            "cache_age_seconds": 0,
            "checked_at": 1786610000,
        }

    response = make_app(
        ready_discovery(), client, egress_info_factory=lookup,
    ).test_client().get("/api/mihomo/clash/egress-info?refresh=1")
    body = response.get_json()

    assert response.status_code == 200
    assert body["ok"] is True
    assert body["route_scope"] == "mihomo_proxy"
    assert body["lookup_host"] == "ipapi.co"
    assert body["ip"] == "203.0.113.8"
    assert body["organization"] == "Example Network"
    assert body["timezone"] == "Europe/Helsinki"
    assert calls == [(7890, True)]
    assert client.operations == ["configs"]


def test_egress_info_route_finds_private_listener_in_active_config(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text(
        "listeners:\n  - name: xkeen-ui-egress-check\n    type: mixed\n    port: 17890\n    listen: 127.0.0.1\n    udp: false\n    users: []\n",
        encoding="utf-8",
    )
    client = StubClient(responses={
        "configs": MihomoClashJSONResponse(
            payload={"mode": "rule"}, status=200, elapsed_ms=1, size_bytes=16,
        ),
    })
    calls = []

    def lookup(port, *, force_refresh=False):
        calls.append((port, force_refresh))
        return {"ip": "203.0.113.8", "ip_version": "IPv4"}

    response = make_app(
        ready_discovery(), client,
        mihomo_config_file=str(config), mihomo_root=str(tmp_path),
        egress_info_factory=lookup,
    ).test_client().get("/api/mihomo/clash/egress-info")
    assert response.status_code == 200
    assert calls == [(17890, False)]


def test_egress_info_missing_port_offers_safe_automatic_setup(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("mode: rule\n", encoding="utf-8")
    client = StubClient(responses={
        "configs": MihomoClashJSONResponse(
            payload={"mode": "rule"}, status=200, elapsed_ms=1, size_bytes=16,
        ),
    })

    response = make_app(
        ready_discovery(), client,
        mihomo_config_file=str(config), mihomo_root=str(tmp_path),
    ).test_client().get("/api/mihomo/clash/egress-info")
    body = response.get_json()
    assert response.status_code == 409
    assert body["code"] == "mihomo_proxy_port_unavailable"
    assert body["setup_available"] is True
    assert body["setup_endpoint"] == "/api/mihomo/security/egress-listener-preview"


def test_runtime_mode_route_switches_only_allowlisted_mode_and_reconciles():
    client = StubClient(
        responses={
            "configs": MihomoClashJSONResponse(
                payload={"mode": "rule", "secret": "must-not-leak"},
                status=200,
                elapsed_ms=1,
                size_bytes=32,
            ),
        }
    )
    response = make_app(ready_discovery(), client).test_client().put(
        "/api/mihomo/clash/runtime-mode",
        json={"mode": "GLOBAL"},
    )

    body = response.get_json()
    assert response.status_code == 200
    assert body == {
        "ok": True,
        "schema_version": 1,
        "mode": "global",
        "previous_mode": "rule",
        "changed": True,
        "reconciled": True,
        "persistent": False,
    }
    assert client.runtime_modes == ["global"]
    assert client.operations == ["configs", "configs"]
    assert "must-not-leak" not in json.dumps(body)


def test_runtime_mode_route_rejects_arbitrary_config_patch_before_upstream():
    client = StubClient()
    response = make_app(ready_discovery(), client).test_client().put(
        "/api/mihomo/clash/runtime-mode",
        json={"mode": "rule", "allow-lan": True},
    )
    assert response.status_code == 400
    assert response.get_json()["code"] == "invalid_runtime_mode_payload"
    assert client.runtime_modes == []

    invalid = make_app(ready_discovery(), client).test_client().put(
        "/api/mihomo/clash/runtime-mode",
        json={"mode": "script"},
    )
    assert invalid.status_code == 400
    assert invalid.get_json()["code"] == "invalid_runtime_mode"
    assert client.operations == []


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
    assert body["security"] == {
        "mode": "not_ready",
        "recommended_transport": "tcp-loopback",
        "recommended_value": "external-controller: 127.0.0.1:9090 + secret",
        "panel_password_reuse": False,
        "migration_required": False,
        "setup_required": True,
    }


def test_status_route_reports_lan_controller_without_forcing_migration():
    """Открытый в LAN controller без secret описывается, но не чинится сам.

    Пользователь мог открыть Clash API намеренно — например, чтобы ходить в
    Zashboard с другого устройства. Поэтому статус остаётся диагностическим:
    ``mode`` называет вещи своими именами, а ``migration_required`` не
    поднимается, чтобы панель не предлагала «защитить» одним кликом и не
    оборвала пользователю доступ.
    """
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
        "recommended_transport": "tcp-loopback",
        "recommended_value": "external-controller: 127.0.0.1:9090 + secret",
        "panel_password_reuse": False,
        "migration_required": False,
        "setup_required": False,
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


def groups_payload(now: str = "node-a", *, group_type: str = "Selector", fixed: str = ""):
    return {
        "proxies": {
            "GLOBAL": {"type": "Selector", "all": ["AUTO"], "now": "AUTO"},
            "AUTO": {
                "type": group_type,
                "all": ["node-a", "node-b"],
                "now": now,
                "fixed": fixed,
            },
            "node-a": {"name": "node-a", "type": "VLESS", "alive": True},
            "node-b": {"name": "node-b", "type": "Trojan", "alive": True},
        }
    }


def test_proxy_transport_index_reads_local_and_provider_cards(tmp_path: Path):
    provider_dir = tmp_path / "providers"
    provider_dir.mkdir()
    (provider_dir / "demo.yaml").write_text(
        "proxies:\n"
        "  - name: provider-node\n"
        "    type: vless\n"
        "    server: 203.0.113.20\n"
        "    port: 443\n"
        "    network: xhttp\n"
        "    tls: true\n"
        "    servername: cdn.example.test\n"
        "    xhttp-opts:\n"
        "      path: /api/v2/\n"
        "      host: cdn.example.test\n",
        encoding="utf-8",
    )
    config = tmp_path / "config.yaml"
    config.write_text(
        "proxies:\n"
        "  - name: local-node\n"
        "    type: trojan\n"
        "    server: 198.51.100.10\n"
        "    port: 8443\n"
        "    network: ws\n"
        "    ws-opts: {path: /ws}\n"
        "proxy-providers:\n"
        "  demo: {type: file, path: providers/demo.yaml}\n",
        encoding="utf-8",
    )

    details = _load_proxy_transport_index(str(config), str(tmp_path))
    assert details["local"]["local-node"]["server"] == "198.51.100.10"
    assert details["local"]["local-node"]["path"] == "/ws"
    assert details["providers"]["demo"]["provider-node"]["network"] == "xhttp"
    assert details["providers"]["demo"]["provider-node"]["security"] == "tls"
    assert details["providers"]["demo"]["provider-node"]["host"] == "cdn.example.test"


def test_proxy_transport_index_has_router_fallback_without_pyyaml(tmp_path: Path, monkeypatch):
    provider_dir = tmp_path / "proxy_providers"
    provider_dir.mkdir()
    (provider_dir / "shared.yaml").write_text(
        "proxies:\n"
        "  - name: shared-node\n"
        "    type: vless\n"
        "    server: 203.0.113.30\n"
        "    port: 443\n"
        "    network: ws\n"
        "    tls: true\n"
        "    ws-opts:\n"
        "      path: /socket\n"
        "      headers:\n"
        "        Host: cdn.router.test\n",
        encoding="utf-8",
    )
    config = tmp_path / "config.yaml"
    config.write_text(
        "proxies: []\n"
        "proxy-providers:\n"
        "  shared:\n"
        "    type: file\n"
        "    path: ./proxy_providers/shared.yaml\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(mihomo_clash_routes, "_yaml", None)

    details = _load_proxy_transport_index(str(config), str(tmp_path))
    node = details["providers"]["shared"]["shared-node"]
    assert node["server"] == "203.0.113.30"
    assert node["port"] == "443"
    assert node["network"] == "ws"
    assert node["security"] == "tls"
    assert node["path"] == "/socket"
    assert node["host"] == "cdn.router.test"


def test_proxy_groups_route_returns_versioned_normalized_payload():
    client = StubClient(
        responses={
            "proxies": MihomoClashJSONResponse(groups_payload(), 200, 2, 200),
            "providers_proxies": MihomoClashJSONResponse(
                {"providers": {}}, 200, 3, 100
            ),
        }
    )
    response = make_app(ready_discovery(), client).test_client().get(
        "/api/mihomo/clash/proxy-groups"
    )
    body = response.get_json()

    assert response.status_code == 200
    assert body["ok"] is True
    assert body["schema_version"] == 1
    assert body["groups"][0]["name"] == "AUTO"
    assert all(group["name"] != "GLOBAL" for group in body["groups"])
    assert body["global_group"]["name"] == "GLOBAL"
    assert body["global_group"]["now"] == "AUTO"
    assert [node["name"] for node in body["global_group"]["nodes"]] == ["AUTO"]
    assert body["capabilities"]["proxy_groups"] is True
    assert body["capabilities"]["proxy_select"] is True
    assert body["telemetry"]["providers"]["size_bytes"] == 100
    assert sorted(client.operations) == ["providers_proxies", "proxies"]


def test_proxy_groups_reads_independent_upstreams_concurrently():
    import threading
    import time

    client = StubClient(
        responses={
            "proxies": MihomoClashJSONResponse(groups_payload(), 200, 2, 200),
            "providers_proxies": MihomoClashJSONResponse({"providers": {}}, 200, 3, 100),
        }
    )
    barrier = threading.Barrier(2)

    def request_json(operation):
        client.operations.append(operation)
        barrier.wait(timeout=0.5)
        time.sleep(0.01)
        return client.responses[operation]

    client.request_json = request_json
    response = make_app(ready_discovery(), client).test_client().get(
        "/api/mihomo/clash/proxy-groups"
    )
    assert response.status_code == 200
    assert sorted(client.operations) == ["providers_proxies", "proxies"]


def test_rules_and_providers_routes_return_safe_versioned_dtos():
    client = StubClient(
        responses={
            "rules": MihomoClashJSONResponse(
                {"rules": [{"type": "DomainSuffix", "payload": "example.test", "proxy": "AUTO", "secret": "drop"}]},
                200, 2, 120,
            ),
            "providers_proxies": MihomoClashJSONResponse(
                {"providers": {"proxy-one": {"name": "proxy-one", "healthCheck": {"enable": True}, "proxies": [{"name": "node", "alive": True}], "url": "https://secret.invalid", "headers": {"X-Token": "secret"}, "subscriptionInfo": {"Upload": 10, "Download": 20, "Total": 1000, "Expire": 1780000000}}}},
                200, 3, 220,
            ),
            "providers_rules": MihomoClashJSONResponse(
                {"providers": {"rules-one": {"name": "rules-one", "ruleCount": 9, "behavior": "domain", "path": "/private/rules"}}},
                200, 4, 180,
            ),
        }
    )
    http = make_app(ready_discovery(), client).test_client()

    rules = http.get("/api/mihomo/clash/rules")
    providers = http.get("/api/mihomo/clash/providers")
    serialized = json.dumps([rules.get_json(), providers.get_json()])

    assert rules.status_code == 200
    assert rules.get_json()["rules"][0]["target"] == "AUTO"
    assert rules.get_json()["capabilities"]["rules"] is True
    assert providers.status_code == 200
    assert [item["kind"] for item in providers.get_json()["providers"]] == ["proxy", "rule"]
    assert providers.get_json()["capabilities"]["provider_update"] is True
    assert providers.get_json()["providers"][0]["subscription"] == {
        "used": 30,
        "total": 1000,
        "expires_at": 1780000000,
    }
    assert "secret.invalid" not in serialized
    assert "X-Token" not in serialized
    assert "/private/rules" not in serialized



def test_rule_provider_content_route_is_bounded_searchable_and_redacted(tmp_path: Path):
    config = tmp_path / "config.yaml"
    config.write_text(
        "rule-providers:\n"
        "  local/rules:\n"
        "    type: inline\n"
        "    behavior: domain\n"
        "    payload: [example.test, +.filtered.test]\n",
        encoding="utf-8",
    )
    http = make_app(
        ready_discovery(),
        StubClient(),
        mihomo_config_file=str(config),
        mihomo_root=str(tmp_path),
    ).test_client()

    response = http.get(
        "/api/mihomo/clash/providers/rule/local%2Frules/content?q=FILTER&limit=1&offset=0"
    )
    body = response.get_json()

    assert response.status_code == 200
    assert body["rules"] == ["+.filtered.test"]
    assert body["provider"]["name"] == "local/rules"
    assert body["limit"] == 1
    assert "path" not in json.dumps(body).lower()

    missing = http.get("/api/mihomo/clash/providers/rule/missing/content")
    assert missing.status_code == 404
    assert missing.get_json()["code"] == "provider_not_found"
    assert str(tmp_path) not in json.dumps(missing.get_json())

def test_provider_actions_revalidate_kind_name_and_healthcheck():
    proxy_payload = {
        "providers": {
            "proxy/one": {
                "name": "proxy/one",
                "healthCheck": {"enable": True},
                "proxies": [{"name": "node", "alive": True}],
            }
        }
    }
    rule_payload = {"providers": {"rules-one": {"name": "rules-one", "ruleCount": 2}}}
    client = StubClient(
        responses={
            "providers_proxies": MihomoClashJSONResponse(proxy_payload, 200, 1, 100),
            "providers_rules": MihomoClashJSONResponse(rule_payload, 200, 1, 100),
        }
    )
    http = make_app(ready_discovery(), client).test_client()

    updated_proxy = http.post("/api/mihomo/clash/providers/proxy/proxy%2Fone/update")
    updated_rule = http.post("/api/mihomo/clash/providers/rule/rules-one/update")
    checked = http.post("/api/mihomo/clash/providers/proxy/proxy%2Fone/healthcheck")
    stale = http.post("/api/mihomo/clash/providers/rule/missing/update")

    assert updated_proxy.status_code == 200
    assert updated_rule.status_code == 200
    assert checked.status_code == 200
    assert stale.status_code == 409
    assert client.provider_updates == [("proxy", "proxy/one"), ("rule", "rules-one")]
    assert client.provider_healthchecks == ["proxy/one"]


def test_proxy_select_is_reconciled_against_fresh_snapshot():
    audit_events = []
    client = StubClient(
        responses={
            "proxies": MihomoClashJSONResponse(groups_payload(now="node-b"), 200, 2, 200),
            "providers_proxies": MihomoClashJSONResponse(
                {
                    "providers": {
                        "demo-provider": {
                            "name": "demo-provider",
                            "proxies": [{"name": "node-b", "type": "VLESS", "alive": True}],
                        }
                    }
                },
                200,
                2,
                100,
            ),
        }
    )
    response = make_app(
        ready_discovery(),
        client,
        audit_logger=lambda ok, **metadata: audit_events.append((ok, metadata)),
    ).test_client().put(
        "/api/mihomo/clash/proxy-groups/AUTO",
        json={"name": "node-b"},
    )
    body = response.get_json()

    assert response.status_code == 200
    assert body["ok"] is True
    assert body["group"]["now"] == "node-b"
    node = next(item for item in body["group"]["nodes"] if item["name"] == "node-b")
    assert node["provider"] == "demo-provider"
    assert body["reconciled"] is True
    assert client.selections == [("AUTO", "node-b")]
    assert client.operations == ["proxies", "proxies", "providers_proxies"]
    assert audit_events == [
        (
            True,
            {"source": "mihomo-clash", "action": "proxy-select", "group": "AUTO"},
        )
    ]


def test_global_proxy_select_is_reconciled_against_fresh_snapshot():
    client = StubClient(
        responses={
            "proxies": MihomoClashJSONResponse(groups_payload(), 200, 2, 200),
            "providers_proxies": MihomoClashJSONResponse(
                {"providers": {}}, 200, 2, 100
            ),
        }
    )
    response = make_app(ready_discovery(), client).test_client().put(
        "/api/mihomo/clash/proxy-groups/GLOBAL",
        json={"name": "AUTO"},
    )
    body = response.get_json()

    assert response.status_code == 200
    assert body["ok"] is True
    assert body["group"]["name"] == "GLOBAL"
    assert body["group"]["now"] == "AUTO"
    assert body["reconciled"] is True
    assert client.selections == [("GLOBAL", "AUTO")]
    assert client.operations == ["proxies", "proxies", "providers_proxies"]


def test_global_proxy_select_rejects_stale_choice_or_missing_selector_before_mutation():
    missing_global = groups_payload()
    missing_global["proxies"].pop("GLOBAL")

    for payload, selection in (
        (groups_payload(), "removed-group"),
        (missing_global, "AUTO"),
    ):
        client = StubClient(
            responses={
                "proxies": MihomoClashJSONResponse(payload, 200, 2, 200),
            }
        )
        response = make_app(ready_discovery(), client).test_client().put(
            "/api/mihomo/clash/proxy-groups/GLOBAL",
            json={"name": selection},
        )

        assert response.status_code == 409
        assert response.get_json()["code"] == "proxy_selection_not_available"
        assert client.selections == []
        assert client.operations == ["proxies"]


def test_proxy_select_rejects_stale_or_unknown_choice_before_mutation():
    client = StubClient(
        responses={
            "proxies": MihomoClashJSONResponse(groups_payload(), 200, 2, 200),
        }
    )
    response = make_app(ready_discovery(), client).test_client().put(
        "/api/mihomo/clash/proxy-groups/AUTO",
        json={"name": "removed-node"},
    )

    assert response.status_code == 409
    assert response.get_json()["code"] == "proxy_selection_not_available"
    assert client.selections == []
    assert client.operations == ["proxies"]


def test_proxy_select_rejects_timeout_for_automatic_group_before_mutation():
    payload = groups_payload(group_type="URLTest")
    payload["proxies"]["node-b"]["history"] = [
        {"time": "2026-08-17T00:00:00Z", "delay": 0}
    ]
    client = StubClient(responses={
        "proxies": MihomoClashJSONResponse(payload, 200, 2, 200),
    })

    response = make_app(ready_discovery(), client).test_client().put(
        "/api/mihomo/clash/proxy-groups/AUTO",
        json={"name": "node-b"},
    )

    assert response.status_code == 409
    assert response.get_json()["code"] == "proxy_selection_timed_out"
    assert client.selections == []


def test_loadbalance_selection_is_locked_but_fixed_state_can_be_removed():
    locked = groups_payload(now="node-a", group_type="LoadBalance", fixed="node-a")
    unlocked = groups_payload(now="node-b", group_type="LoadBalance", fixed="")
    snapshots = iter([
        MihomoClashJSONResponse(locked, 200, 1, 100),
        MihomoClashJSONResponse(locked, 200, 1, 100),
        MihomoClashJSONResponse(unlocked, 200, 1, 100),
    ])
    client = StubClient(responses={
        "version": MihomoClashJSONResponse({"version": "Mihomo Meta v1.19.29"}, 200, 1, 40),
        "providers_proxies": MihomoClashJSONResponse({"providers": {}}, 200, 1, 100),
    })
    original_request = client.request_json

    def request_json(operation):
        if operation == "proxies":
            client.operations.append(operation)
            return next(snapshots)
        return original_request(operation)

    client.request_json = request_json
    http = make_app(ready_discovery(), client).test_client()
    selected = http.put("/api/mihomo/clash/proxy-groups/AUTO", json={"name": "node-b"})
    assert selected.status_code == 409
    assert selected.get_json()["code"] == "proxy_selection_locked"
    assert client.selections == []

    removed = http.delete("/api/mihomo/clash/proxy-groups/AUTO/fixed", json={})
    assert removed.status_code == 200
    assert removed.get_json()["reconciled"] is True
    assert client.unfixed == ["AUTO"]


def test_proxy_select_rejects_non_json_and_does_not_touch_upstream():
    client = StubClient()
    response = make_app(ready_discovery(), client).test_client().put(
        "/api/mihomo/clash/proxy-groups/AUTO",
        data="name=node-b",
        content_type="application/x-www-form-urlencoded",
    )

    assert response.status_code == 400
    assert response.get_json()["code"] == "invalid_proxy_selection"
    assert client.selections == []


def test_proxy_unfix_is_version_gated_reconciled_and_disconnects_only_affected_connections():
    before = groups_payload(now="node-b", group_type="URLTest", fixed="node-b")
    after = groups_payload(now="node-a", group_type="URLTest", fixed="")
    connection_payload = {
        "connections": [
            {"id": "affected", "chains": ["node-b", "AUTO"], "metadata": {}},
            {"id": "other", "chains": ["DIRECT"], "metadata": {}},
        ]
    }
    snapshots = iter([
        MihomoClashJSONResponse(before, 200, 1, 100),
        MihomoClashJSONResponse(after, 200, 1, 100),
    ])
    client = StubClient(responses={
        "version": MihomoClashJSONResponse({"version": "Mihomo Meta v1.19.29"}, 200, 1, 40),
        "connections_snapshot": MihomoClashJSONResponse(connection_payload, 200, 1, 100),
        "providers_proxies": MihomoClashJSONResponse({"providers": {}}, 200, 1, 100),
    })
    original_request = client.request_json

    def request_json(operation):
        if operation == "proxies":
            client.operations.append(operation)
            return next(snapshots)
        return original_request(operation)

    client.request_json = request_json
    response = make_app(ready_discovery(), client).test_client().delete(
        "/api/mihomo/clash/proxy-groups/AUTO/fixed",
        json={"disconnect_affected": True},
    )
    body = response.get_json()

    assert response.status_code == 200
    assert body["reconciled"] is True
    assert body["group"]["fixed"] == ""
    assert body["connections"] == {
        "requested": True,
        "matched": 1,
        "disconnected": 1,
        "failed": 0,
        "truncated": False,
    }
    assert client.unfixed == ["AUTO"]
    assert client.disconnected == ["affected"]


def test_proxy_unfix_rejects_old_mihomo_before_mutation():
    client = StubClient(responses={
        "version": MihomoClashJSONResponse({"version": "v1.18.8"}, 200, 1, 40),
    })
    response = make_app(ready_discovery(), client).test_client().delete(
        "/api/mihomo/clash/proxy-groups/AUTO/fixed",
        json={},
    )

    assert response.status_code == 409
    assert response.get_json()["code"] == "proxy_unfix_not_supported"
    assert client.unfixed == []


def test_delay_route_forwards_only_scope_name_and_preset_id():
    client = StubClient(
        responses={
            "delay": MihomoClashJSONResponse({"delay": 87, "raw": "dropped"}, 200, 3, 20)
        }
    )
    response = make_app(ready_discovery(), client).test_client().post(
        "/api/mihomo/clash/delay",
        json={
            "scope": "proxy",
            "name": "node-a",
            "preset": "google",
            "url": "http://127.0.0.1/private",
        },
    )
    body = response.get_json()

    assert response.status_code == 200
    assert body == {
        "ok": True,
        "schema_version": 1,
        "scope": "proxy",
        "name": "node-a",
        "preset": "google",
        "effective_preset": "google",
        "fallback_used": False,
        "results": [{"name": "node-a", "delay_ms": 87}],
        "truncated": False,
    }
    assert client.delays == [("proxy", "node-a", "google")]


def test_delay_route_retries_transient_auto_failure_with_allowlisted_cloudflare():
    class FallbackClient(StubClient):
        def request_delay(self, scope: str, name: str, *, preset: str):
            self.delays.append((scope, name, preset))
            if preset == "auto":
                raise MihomoClashClientError(
                    "upstream_timeout",
                    "private target timed out",
                    status=504,
                    retryable=True,
                )
            return MihomoClashJSONResponse({"delay": 91}, 200, 3, 20)

    client = FallbackClient()
    response = make_app(ready_discovery(), client).test_client().post(
        "/api/mihomo/clash/delay",
        json={"scope": "proxy", "name": "node-a", "preset": "auto"},
    )

    assert response.status_code == 200
    assert response.get_json()["results"] == [{"name": "node-a", "delay_ms": 91}]
    assert response.get_json()["effective_preset"] == "cloudflare"
    assert response.get_json()["fallback_used"] is True
    assert client.delays == [
        ("proxy", "node-a", "auto"),
        ("proxy", "node-a", "cloudflare"),
    ]


def test_delay_route_reports_zero_delay_as_timeout_after_fallback():
    class ZeroDelayClient(StubClient):
        def request_delay(self, scope: str, name: str, *, preset: str):
            self.delays.append((scope, name, preset))
            raise MihomoClashClientError(
                "upstream_timeout",
                "zero delay sentinel",
                status=504,
                retryable=True,
            )

    client = ZeroDelayClient()
    response = make_app(ready_discovery(), client).test_client().post(
        "/api/mihomo/clash/delay",
        json={"scope": "proxy", "name": "node-a", "preset": "auto"},
    )

    assert response.status_code == 504
    assert response.get_json()["code"] == "upstream_timeout"
    assert client.delays == [
        ("proxy", "node-a", "auto"),
        ("proxy", "node-a", "cloudflare"),
    ]


def test_explicit_google_preset_does_not_switch_targets_on_transient_failure():
    client = StubClient(error=MihomoClashClientError(
        "upstream_timeout",
        "google timed out",
        status=504,
        retryable=True,
    ))
    response = make_app(ready_discovery(), client).test_client().post(
        "/api/mihomo/clash/delay",
        json={"scope": "proxy", "name": "node-a", "preset": "google"},
    )

    assert response.status_code == 504
    assert response.get_json()["code"] == "upstream_timeout"
    assert client.delays == [("proxy", "node-a", "google")]


def test_delay_route_does_not_retry_semantic_google_failure():
    client = StubClient(
        error=MihomoClashClientError(
            "endpoint_not_supported",
            "private upstream path",
            status=502,
            upstream_status=404,
        )
    )
    response = make_app(ready_discovery(), client).test_client().post(
        "/api/mihomo/clash/delay",
        json={"scope": "proxy", "name": "node-a", "preset": "google"},
    )

    assert response.status_code == 502
    assert response.get_json()["code"] == "endpoint_not_supported"
    assert client.delays == [("proxy", "node-a", "google")]


def test_group_delay_route_returns_bounded_named_results():
    client = StubClient(
        responses={
            "delay": MihomoClashJSONResponse(
                {"node-a": 87, "node-b": 0, "invalid": "timeout"},
                200,
                3,
                40,
            )
        }
    )
    response = make_app(ready_discovery(), client).test_client().post(
        "/api/mihomo/clash/delay",
        json={"scope": "group", "name": "AUTO", "preset": "cloudflare"},
    )

    assert response.status_code == 200
    assert response.get_json()["results"] == [
        {"name": "node-a", "delay_ms": 87},
        {"name": "node-b", "delay_ms": 0},
    ]
    assert client.delays == [("group", "AUTO", "cloudflare")]


def test_provider_scoped_delay_route_forwards_provider_and_node_only():
    client = StubClient(
        responses={"delay": MihomoClashJSONResponse({"delay": 41}, 200, 2, 18)}
    )
    app = make_app(ready_discovery(), client)

    response = app.test_client().post(
        "/api/mihomo/clash/delay",
        json={
            "scope": "provider-proxy",
            "provider": "provider-a",
            "name": "same-name-node",
            "preset": "google",
        },
    )

    assert response.status_code == 200
    assert response.get_json()["results"] == [{"name": "same-name-node", "delay_ms": 41}]
    assert client.provider_delays == [("provider-a", "same-name-node", "google")]


def test_delay_route_returns_retry_after_when_action_guard_rejects():
    class RejectingGuard:
        def try_acquire(self, action: str, subject: str):
            assert action == "delay"
            assert subject == "authenticated"
            return None, MihomoClashActionRejected("action_busy", 3)

    client = StubClient()
    app = Flask(__name__)
    app.secret_key = "test-secret"
    app.config["TESTING"] = True
    app.register_blueprint(
        create_mihomo_clash_blueprint(
            mihomo_config_file="/safe/mihomo/config.yaml",
            mihomo_root="/safe/mihomo",
            discovery_factory=lambda _config, _root: ready_discovery(),
            client_factory=lambda _target: client,
            action_guard=RejectingGuard(),
        )
    )

    response = app.test_client().post(
        "/api/mihomo/clash/delay",
        json={"scope": "proxy", "name": "node-a", "preset": "google"},
    )

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "3"
    assert response.get_json()["code"] == "action_busy"
    assert client.delays == []


def test_connections_route_returns_bounded_normalized_snapshot():
    client = StubClient(
        responses={
            "connections_snapshot": MihomoClashJSONResponse(
                {
                    "downloadTotal": 100,
                    "uploadTotal": 50,
                    "memory": 200,
                    "connections": [
                        {
                            "id": "connection-1",
                            "metadata": {"host": "example.test", "sourceIP": "192.0.2.1"},
                            "chains": ["AUTO", "node-a"],
                        }
                    ],
                },
                200,
                4,
                300,
            )
        }
    )
    response = make_app(
        ready_discovery(),
        client,
        device_map_factory=lambda: {"192.0.2.1": {"name": "Laptop"}},
    ).test_client().get(
        "/api/mihomo/clash/connections"
    )
    body = response.get_json()

    assert response.status_code == 200
    assert body["ok"] is True
    assert body["schema_version"] == 1
    assert body["connections"][0]["id"] == "connection-1"
    assert body["connections"][0]["metadata"]["source_name"] == "Laptop"
    assert body["memory"] == 200
    assert body["capabilities"]["connections_snapshot"] is True
    assert body["capabilities"]["connections_stream"] is False
    assert body["capabilities"]["connection_disconnect"] is True
    assert body["fallback"] == {"transport": "http-snapshot", "poll_interval_ms": 2000}
    assert body["telemetry"]["size_bytes"] == 300


def _connection_snapshot(*ids: str):
    return MihomoClashJSONResponse(
        {
            "connections": [
                {"id": connection_id, "metadata": {"host": "example.test"}}
                for connection_id in ids
            ]
        },
        200,
        1,
        100,
    )


def test_disconnect_one_revalidates_id_before_allowlisted_mutation():
    client = StubClient(responses={"connections_snapshot": _connection_snapshot("active/one")})
    response = make_app(ready_discovery(), client).test_client().delete(
        "/api/mihomo/clash/connections/active%2Fone"
    )

    assert response.status_code == 200
    assert response.get_json()["disconnected"] is True
    assert client.disconnected == ["active/one"]
    assert client.operations == ["connections_snapshot"]


def test_disconnect_one_rejects_stale_id_without_mutation():
    client = StubClient(responses={"connections_snapshot": _connection_snapshot("active")})
    response = make_app(ready_discovery(), client).test_client().delete(
        "/api/mihomo/clash/connections/stale"
    )

    assert response.status_code == 409
    assert response.get_json()["code"] == "connection_not_found"
    assert client.disconnected == []


def test_disconnect_all_requires_confirmed_matching_count():
    client = StubClient(responses={"connections_snapshot": _connection_snapshot("one", "two")})
    http = make_app(ready_discovery(), client).test_client()

    missing = http.delete("/api/mihomo/clash/connections", json={"count": 2})
    changed = http.delete(
        "/api/mihomo/clash/connections", json={"confirm": True, "count": 1}
    )
    accepted = http.delete(
        "/api/mihomo/clash/connections", json={"confirm": True, "count": 2}
    )

    assert missing.status_code == 400
    assert missing.get_json()["code"] == "disconnect_all_confirmation_required"
    assert changed.status_code == 409
    assert changed.get_json()["current_count"] == 2
    assert accepted.status_code == 200
    assert accepted.get_json()["count"] == 2
    assert client.disconnected_all == 1


def test_facade_maps_client_error_without_leaking_exception_message():
    client = StubClient(
        error=MihomoClashClientError(
            "upstream_unreachable",
            "private socket /opt/etc/mihomo/controller.sock",
            retryable=True,
        )
    )
    response = make_app(ready_discovery(), client).test_client().get(
        "/api/mihomo/clash/proxy-groups"
    )
    serialized = json.dumps(response.get_json())

    assert response.status_code == 502
    assert response.get_json()["code"] == "upstream_unreachable"
    assert response.get_json()["retryable"] is True
    assert "/opt/etc/mihomo" not in serialized


def test_mutating_facade_uses_global_session_and_csrf_guard(monkeypatch, tmp_path):
    from services import auth_setup

    auth_setup.AUTH_DIR = str(tmp_path)
    auth_setup.AUTH_FILE = str(tmp_path / "auth.json")
    auth_setup.SECRET_KEY_FILE = str(tmp_path / "secret.key")
    (tmp_path / "auth.json").write_text(
        json.dumps({"username": "admin", "password_hash": "configured"}),
        encoding="utf-8",
    )

    client_stub = StubClient(
        responses={
            "delay": MihomoClashJSONResponse({"delay": 42}, 200, 1, 12),
        }
    )
    app = make_app(ready_discovery(), client_stub)
    auth_setup.init_auth(app)
    client = app.test_client()

    unauthorized = client.post(
        "/api/mihomo/clash/delay",
        json={"scope": "proxy", "name": "node-a", "preset": "google"},
    )
    assert unauthorized.status_code == 401

    with client.session_transaction() as session:
        session["auth"] = True
        session["user"] = "admin"
        session["csrf"] = "csrf-fixture"

    csrf_missing = client.post(
        "/api/mihomo/clash/delay",
        json={"scope": "proxy", "name": "node-a", "preset": "google"},
    )
    assert csrf_missing.status_code == 403
    assert csrf_missing.get_json()["error"] == "csrf_failed"

    allowed = client.post(
        "/api/mihomo/clash/delay",
        json={"scope": "proxy", "name": "node-a", "preset": "google"},
        headers={"X-CSRF-Token": "csrf-fixture"},
    )
    assert allowed.status_code == 200
    assert allowed.get_json()["results"] == [{"name": "node-a", "delay_ms": 42}]


def test_routes_registry_registers_mihomo_clash_facade(monkeypatch):
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
    rules: dict[str, set[str]] = {}
    for rule in app.url_map.iter_rules():
        rules.setdefault(rule.rule, set()).update(rule.methods or ())
    assert "GET" in rules["/api/mihomo/clash/status"]
    assert "GET" in rules["/api/mihomo/clash/egress-info"]
    assert "PUT" in rules["/api/mihomo/clash/runtime-mode"]
    assert "GET" in rules["/api/mihomo/clash/proxy-groups"]
    assert "GET" in rules["/api/mihomo/clash/rules"]
    assert "GET" in rules["/api/mihomo/clash/providers"]
    assert "POST" in rules[
        "/api/mihomo/clash/providers/<kind>/<path:provider_name>/update"
    ]
    assert "POST" in rules[
        "/api/mihomo/clash/providers/proxy/<path:provider_name>/healthcheck"
    ]
    assert "PUT" in rules["/api/mihomo/clash/proxy-groups/<path:group_name>"]
    assert "POST" in rules["/api/mihomo/clash/delay"]
    assert "GET" in rules["/api/mihomo/clash/connections"]
    assert "DELETE" in rules["/api/mihomo/clash/connections"]
    assert "DELETE" in rules["/api/mihomo/clash/connections/<path:connection_id>"]
