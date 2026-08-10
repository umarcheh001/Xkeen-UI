from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
FIXTURES = ROOT / "tests" / "fixtures" / "mihomo_clash"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_contract_fixture_set_is_complete_and_redacted():
    expected = {
        "version.json",
        "configs.json",
        "proxies.json",
        "group.json",
        "providers-proxies.json",
        "connections-01.json",
        "connections-02.json",
        "connections-03.json",
        "errors.json",
    }
    assert expected.issubset({item.name for item in FIXTURES.glob("*.json")})
    serialized = "\n".join(
        (FIXTURES / name).read_text(encoding="utf-8") for name in expected
    ).lower()
    assert "secret" not in serialized
    assert "subscription" not in serialized


def test_target_discovery_prefers_ready_unix_socket_and_redacts_secret(tmp_path: Path):
    from services.mihomo_clash_target import discover_mihomo_clash_target

    root = tmp_path / "mihomo"
    root.mkdir()
    config = root / "config.yaml"
    config.write_text(
        "external-controller-unix: run/mihomo.sock\n"
        "external-controller: 0.0.0.0:9090\n"
        "secret: \"fixture-secret\"\n",
        encoding="utf-8",
    )
    result = discover_mihomo_clash_target(
        config,
        root,
        socket_probe=lambda path: path == root / "run" / "mihomo.sock",
    )

    assert result.target is not None
    assert result.target.transport == "unix"
    assert result.target.authorization_header() == "Bearer fixture-secret"
    assert "fixture-secret" not in repr(result)
    assert "fixture-secret" not in repr(result.target)
    assert result.public_dict()["secret_configured"] is True
    assert result.public_dict()["target_ready"] is True


def test_target_discovery_forces_loopback_and_rejects_unallowed_port(tmp_path: Path):
    from services.mihomo_clash_target import discover_mihomo_clash_target

    root = tmp_path / "mihomo"
    root.mkdir()
    config = root / "config.yaml"
    config.write_text(
        "external-controller: 10.0.0.2:9191\nsecret: router-secret\n",
        encoding="utf-8",
    )
    result = discover_mihomo_clash_target(
        config,
        root,
        environ={"XKEEN_CLASH_API_ALLOWED_PORTS": "9090"},
    )

    assert result.target is None
    assert any(item.code == "port_not_allowed" for item in result.diagnostics)
    assert all("10.0.0.2" not in str(item.public_dict()) for item in result.diagnostics)


def test_target_discovery_flags_lan_binding_without_secret(tmp_path: Path):
    from services.mihomo_clash_target import discover_mihomo_clash_target

    root = tmp_path / "mihomo"
    root.mkdir()
    config = root / "config.yaml"
    config.write_text("external-controller: 0.0.0.0:9090\n", encoding="utf-8")
    result = discover_mihomo_clash_target(config, root)

    assert result.target is not None
    assert result.target.loopback_host == "127.0.0.1"
    assert any(item.code == "secret_missing_on_lan_bind" for item in result.diagnostics)


def test_status_dto_is_versioned_and_drops_raw_sensitive_fields(tmp_path: Path):
    from services.mihomo_clash_dto import build_mihomo_clash_status_dto
    from services.mihomo_clash_target import discover_mihomo_clash_target

    root = tmp_path / "mihomo"
    root.mkdir()
    config = root / "config.yaml"
    config.write_text("external-controller: 127.0.0.1:9090\nsecret: fixture-secret\n", encoding="utf-8")
    discovery = discover_mihomo_clash_target(config, root)
    dto = build_mihomo_clash_status_dto(
        discovery,
        version_payload={"version": "Mihomo Meta v1", "secret": "leak"},
        config_payload={"mode": "RULE", "secret": "leak", "tun": {"enable": True}},
        capabilities={
            "status": True,
            "proxy_groups": False,
            "unknown_future_endpoint": True,
        },
    )

    assert dto["schema_version"] == 1
    assert dto["core"]["version"] == "Mihomo Meta v1"
    assert dto["runtime"]["mode"] == "rule"
    assert dto["runtime"]["tun_enabled"] is True
    assert dto["capabilities"]["status"] is True
    assert dto["capabilities"]["proxy_groups"] is False
    assert dto["capabilities"]["connections_stream"] is None
    assert "unknown_future_endpoint" not in dto["capabilities"]
    serialized = json.dumps(dto).lower()
    assert "fixture-secret" not in serialized
    assert "leak" not in serialized


def test_proxy_groups_dto_retains_order_and_provider_enrichment():
    from services.mihomo_clash_dto import build_mihomo_clash_proxy_groups_dto

    dto = build_mihomo_clash_proxy_groups_dto(
        fixture("proxies.json"), fixture("providers-proxies.json")
    )

    assert [group["name"] for group in dto["groups"]] == ["AUTO"]
    auto = next(group for group in dto["groups"] if group["name"] == "AUTO")
    assert auto["now"] == "node-a"
    assert auto["nodes"][1]["provider"] == "demo-provider"
    assert auto["nodes"][1]["provider_candidates"] == ["demo-provider"]
    assert auto["nodes"][1]["provider_ambiguous"] is False
    assert auto["nodes"][0]["delay_ms"] == 87


def test_proxy_groups_dto_does_not_guess_provider_when_names_collide():
    from services.mihomo_clash_dto import build_mihomo_clash_proxy_groups_dto

    providers = fixture("providers-proxies.json")
    providers["providers"]["second-provider"] = {
        "name": "second-provider",
        "proxies": [{"name": "node-b", "type": "VLESS", "alive": True}],
    }
    dto = build_mihomo_clash_proxy_groups_dto(fixture("proxies.json"), providers)

    auto = dto["groups"][0]
    node = next(item for item in auto["nodes"] if item["name"] == "node-b")
    assert node["provider"] == ""
    assert node["provider_candidates"] == ["demo-provider", "second-provider"]
    assert node["provider_ambiguous"] is True


def test_delay_dto_normalizes_proxy_and_group_results():
    from services.mihomo_clash_dto import build_mihomo_clash_delay_dto

    proxy = build_mihomo_clash_delay_dto(
        {"delay": 87, "secret": "drop"},
        scope="proxy",
        name="node-a",
        preset="google",
    )
    group = build_mihomo_clash_delay_dto(
        {"node-a": 87, "node-b": 0, "invalid": "timeout"},
        scope="group",
        name="AUTO",
        preset="cloudflare",
    )

    assert proxy["results"] == [{"name": "node-a", "delay_ms": 87}]
    assert group["results"] == [
        {"name": "node-a", "delay_ms": 87},
        {"name": "node-b", "delay_ms": 0},
    ]
    assert "secret" not in json.dumps(proxy).lower()


def test_delay_dto_normalizes_wrapped_mihomo_group_results():
    from services.mihomo_clash_dto import build_mihomo_clash_delay_dto

    group = build_mihomo_clash_delay_dto(
        {"proxies": [{"name": "node-a", "delay": 62}, {"name": "node-b", "delay": 95}]},
        scope="group",
        name="AUTO",
        preset="google",
    )

    assert group["results"] == [
        {"name": "node-a", "delay_ms": 62},
        {"name": "node-b", "delay_ms": 95},
    ]


def test_connections_dto_is_bounded_and_resolves_source_device():
    from services.mihomo_clash_dto import build_mihomo_clash_connections_dto

    payload = fixture("connections-02.json")
    payload["connections"].append({"id": "conn-003", "metadata": {}})
    dto = build_mihomo_clash_connections_dto(
        payload, device_map={"192.0.2.10": {"name": "operator-laptop"}}, max_rows=2
    )

    assert dto["schema_version"] == 1
    assert dto["total_connections"] == 3
    assert dto["truncated"] is True
    assert len(dto["connections"]) == 2
    assert dto["connections"][0]["metadata"]["source_name"] == "operator-laptop"
    assert dto["connections"][0]["chains"] == ["AUTO", "node-a"]
    assert "secret" not in json.dumps(dto).lower()
