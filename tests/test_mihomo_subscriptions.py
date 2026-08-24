"""Tests for managed Mihomo Xray-JSON subscription refreshes."""

from __future__ import annotations

import base64
import json

from mihomo_config_generator import build_full_config
from services import mihomo_subscriptions as svc


def _outbound(address: str, uuid: str):
    return {
        "tag": "proxy",
        "protocol": "vless",
        "settings": {
            "vnext": [
                {
                    "address": address,
                    "port": 443,
                    "users": [{"id": uuid, "encryption": "none"}],
                }
            ]
        },
        "streamSettings": {
            "network": "tcp",
            "security": "tls",
            "tlsSettings": {"serverName": "edge.example.com", "fingerprint": "chrome"},
        },
    }


def _subscription_body(remarks: str, address: str, uuid: str) -> str:
    return json.dumps(
        [
            {
                "remarks": remarks,
                "outbounds": [
                    _outbound(address, uuid),
                    {"protocol": "freedom", "tag": "direct"},
                ],
            }
        ]
    )


def _state_with_managed_yaml(yaml_text: str):
    return {
        "profile": "router_custom",
        "subscriptions": [],
        "defaultGroups": ["Заблок. сервисы"],
        "enabledRuleGroups": ["Blocked"],
        "proxies": [
            {
                "kind": "yaml",
                "yaml": yaml_text,
                "tags": ["xray-sub:example.test"],
                "xray_json_subscription": {
                    "id": "xray-example",
                    "url": "https://example.test/xray.json",
                    "tag": "xray-sub:example.test",
                    "enabled": True,
                    "interval_hours": 24,
                },
            }
        ],
    }


def test_sync_from_generator_state_stores_managed_subscription(tmp_path):
    state = _state_with_managed_yaml("- name: Old\n  type: vless\n")
    saved = svc.sync_from_generator_state(str(tmp_path), state, config_text="config")

    subs = saved["subscriptions"]
    assert len(subs) == 1
    assert subs[0]["id"] == "xray-example"
    assert subs[0]["url"] == "https://example.test/xray.json"
    assert subs[0]["next_update_ts"]
    proxy = saved["generator_state"]["proxies"][0]
    assert proxy["xray_json_subscription"]["id"] == "xray-example"
    assert "xray-sub:example.test" in proxy["tags"]


def test_refresh_subscription_replaces_managed_yaml_and_restarts(tmp_path, monkeypatch):
    old_body = _subscription_body("Old Node", "1.1.1.1", "11111111-1111-1111-1111-111111111111")
    old_proxies, _ = svc.convert_subscription_text(old_body)
    old_yaml = "\n\n".join(p.yaml.strip() for p in old_proxies)
    state = _state_with_managed_yaml(old_yaml)
    current_config = build_full_config(state)

    config_path = tmp_path / "config.yaml"
    config_path.write_text(current_config, encoding="utf-8")
    svc.sync_from_generator_state(str(tmp_path), state, config_text=current_config)

    new_body = _subscription_body("New Node", "2.2.2.2", "22222222-2222-2222-2222-222222222222")
    monkeypatch.setattr(
        svc,
        "fetch_subscription_body",
        lambda url: (new_body, {}, {"fetch_mode": "happ_ua"}),
    )

    restarts: list[str] = []

    def _restart(*, source="api"):
        restarts.append(source)

    def _save(text: str):
        config_path.write_text(text, encoding="utf-8")

    result = svc.refresh_subscription(
        str(tmp_path),
        "xray-example",
        mihomo_config_file=str(config_path),
        restart_xkeen=_restart,
        save_callback=_save,
    )

    assert result["ok"] is True
    assert result["changed"] is True
    assert result["count"] == 1
    assert restarts == ["mihomo-subscription-refresh"]
    written = config_path.read_text(encoding="utf-8")
    assert "New Node" in written
    assert "2.2.2.2" in written
    saved = svc.load_subscription_state(str(tmp_path))
    assert saved["subscriptions"][0]["last_ok"] is True
    assert saved["subscriptions"][0]["last_count"] == 1
    assert "New Node" in saved["generator_state"]["proxies"][0]["yaml"]


def test_refresh_subscription_refuses_to_clobber_manual_active_config(tmp_path, monkeypatch):
    old_body = _subscription_body("Old Node", "1.1.1.1", "11111111-1111-1111-1111-111111111111")
    old_proxies, _ = svc.convert_subscription_text(old_body)
    old_yaml = "\n\n".join(p.yaml.strip() for p in old_proxies)
    state = _state_with_managed_yaml(old_yaml)
    current_config = build_full_config(state)

    config_path = tmp_path / "config.yaml"
    config_path.write_text(current_config, encoding="utf-8")
    svc.sync_from_generator_state(str(tmp_path), state, config_text=current_config)
    config_path.write_text("manual edit\n", encoding="utf-8")

    def _fail_fetch(url):
        raise AssertionError("refresh should stop before fetching")

    monkeypatch.setattr(svc, "fetch_subscription_body", _fail_fetch)

    result = svc.refresh_subscription(
        str(tmp_path),
        "xray-example",
        mihomo_config_file=str(config_path),
    )

    assert result["ok"] is False
    assert result["error"] == "active_config_changed"
    assert config_path.read_text(encoding="utf-8") == "manual edit\n"


def test_update_subscription_settings_clamps_interval_and_updates_generator_meta(tmp_path):
    state = _state_with_managed_yaml("- name: Old\n  type: vless\n")
    saved = svc.sync_from_generator_state(str(tmp_path), state, config_text="config")
    old_next = saved["subscriptions"][0]["next_update_ts"]

    updated = svc.update_subscription_settings(
        str(tmp_path),
        "xray-example",
        {"interval_hours": 999},
    )

    assert updated["interval_hours"] == 168
    assert updated["next_update_ts"] != old_next

    saved = svc.load_subscription_state(str(tmp_path))
    assert saved["subscriptions"][0]["interval_hours"] == 168
    proxy_meta = saved["generator_state"]["proxies"][0]["xray_json_subscription"]
    assert proxy_meta["interval_hours"] == 168


def test_delete_generator_subscription_clears_generator_meta(tmp_path):
    state = _state_with_managed_yaml("- name: Old\n  type: vless\n")
    svc.sync_from_generator_state(str(tmp_path), state, config_text="config")

    result = svc.delete_subscription(str(tmp_path), "xray-example")

    assert result["ok"] is True
    assert result["removed_config_blocks"] is False
    saved = svc.load_subscription_state(str(tmp_path))
    assert saved["subscriptions"] == []
    proxy = saved["generator_state"]["proxies"][0]
    assert "xray_json_subscription" not in proxy
    assert "xrayJsonSubscription" not in proxy
    assert "xraySubscription" not in proxy


def test_sync_imported_xray_subscription_stores_config_source(tmp_path):
    proxy_yaml = "- name: Old Node\n  type: vless\n  server: 1.1.1.1\n  port: 443\n"
    config = (
        "proxies:\n"
        "  - name: Old Node\n"
        "    type: vless\n"
        "    server: 1.1.1.1\n"
        "    port: 443\n"
        "proxy-groups:\n"
        "  - name: Заблок. сервисы\n"
        "    type: select\n"
        "    proxies:\n"
        "      - \"Old Node\"\n"
    )

    saved = svc.sync_imported_xray_subscription(
        str(tmp_path),
        url="https://example.test/xray.json",
        config_text=config,
        proxy_yamls=[proxy_yaml],
        groups=["Заблок. сервисы"],
        interval_hours=999,
    )

    assert saved["source"] == "config"
    assert saved["interval_hours"] == 168
    assert saved["proxy_names"] == ["Old Node"]
    assert saved["groups"] == ["Заблок. сервисы"]
    state = svc.load_subscription_state(str(tmp_path))
    assert state["subscriptions"][0]["id"] == saved["id"]
    assert state["last_config_hash"] == svc._hash_text(config)


def test_refresh_mihomo_provider_static_subscription_uses_provider_parser(tmp_path, monkeypatch):
    old_yaml = "- name: Old Node\n  type: vless\n  server: 1.1.1.1\n  port: 443\n"
    config = (
        "proxies:\n"
        "  - name: Old Node\n"
        "    type: vless\n"
        "    server: 1.1.1.1\n"
        "    port: 443\n"
        "proxy-groups:\n"
        "  - name: Auto\n"
        "    type: select\n"
        "    proxies:\n"
        "      - \"Old Node\"\n"
    )
    config_path = tmp_path / "config.yaml"
    config_path.write_text(config, encoding="utf-8")

    saved = svc.sync_imported_xray_subscription(
        str(tmp_path),
        url="https://provider.example/sub",
        config_text=config,
        proxy_yamls=[old_yaml],
        groups=["Auto"],
        refresh_parser="mihomo-provider",
        tag="mihomo-provider:provider.example",
    )
    assert saved["refresh_parser"] == "mihomo-provider"

    def fake_provider_blocks(url):
        assert url == "https://provider.example/sub"
        return (
            ["- name: New Node\n  type: vless\n  server: 2.2.2.2\n  port: 443\n"],
            [],
        )

    monkeypatch.setattr(svc, "_fetch_mihomo_provider_proxy_blocks", fake_provider_blocks)

    restarts: list[str] = []

    def _restart(*, source="api"):
        restarts.append(source)

    def _save(text: str):
        config_path.write_text(text, encoding="utf-8")

    result = svc.refresh_subscription(
        str(tmp_path),
        saved["id"],
        mihomo_config_file=str(config_path),
        restart_xkeen=_restart,
        save_callback=_save,
    )

    assert result["ok"] is True
    assert result["changed"] is True
    assert restarts == ["mihomo-subscription-refresh"]
    written = config_path.read_text(encoding="utf-8")
    assert "Old Node" not in written
    assert "New Node" in written
    assert "2.2.2.2" in written
    assert '      - "New Node"' in written
    state = svc.load_subscription_state(str(tmp_path))
    sub = state["subscriptions"][0]
    assert sub["refresh_parser"] == "mihomo-provider"
    assert sub["proxy_names"] == ["New Node"]


def test_refresh_config_subscription_supports_share_link_source(tmp_path, monkeypatch):
    old_yaml = "- name: Old Node\n  type: vless\n  server: 1.1.1.1\n  port: 443\n"
    config = (
        "proxies:\n"
        "  - name: Old Node\n"
        "    type: vless\n"
        "    server: 1.1.1.1\n"
        "    port: 443\n"
    )
    config_path = tmp_path / "config.yaml"
    config_path.write_text(config, encoding="utf-8")
    saved = svc.sync_imported_xray_subscription(
        str(tmp_path),
        url="happ://crypt5/demo-token",
        config_text=config,
        proxy_yamls=[old_yaml],
        groups=[],
        refresh_parser="xray-json",
    )

    link = (
        "vless://22222222-2222-2222-2222-222222222222@new.example:443"
        "?encryption=none&security=tls&type=tcp#New%20Node"
    )
    encoded = base64.b64encode(link.encode("utf-8")).decode("ascii")
    monkeypatch.setattr(
        svc,
        "fetch_subscription_body",
        lambda url: (encoded, {}, {"fetch_mode": "happ_hwid"}),
    )

    result = svc.refresh_subscription(
        str(tmp_path),
        saved["id"],
        mihomo_config_file=str(config_path),
        save_callback=lambda text: config_path.write_text(text, encoding="utf-8"),
    )

    assert result["ok"] is True
    assert result["count"] == 1
    written = config_path.read_text(encoding="utf-8")
    assert "Old Node" not in written
    assert "New Node" in written
    assert "new.example" in written


def test_delete_config_subscription_can_detach_without_touching_config(tmp_path):
    proxy_yaml = "- name: Old Node\n  type: vless\n  server: 1.1.1.1\n  port: 443\n"
    config = (
        "proxies:\n"
        "  - name: Old Node\n"
        "    type: vless\n"
        "    server: 1.1.1.1\n"
        "    port: 443\n"
        "proxy-groups:\n"
        "  - name: Заблок. сервисы\n"
        "    type: select\n"
        "    proxies:\n"
        "      - \"Old Node\"\n"
    )
    config_path = tmp_path / "config.yaml"
    config_path.write_text(config, encoding="utf-8")
    saved = svc.sync_imported_xray_subscription(
        str(tmp_path),
        url="https://example.test/xray.json",
        config_text=config,
        proxy_yamls=[proxy_yaml],
        groups=["Заблок. сервисы"],
        interval_hours=24,
    )

    result = svc.delete_subscription(
        str(tmp_path),
        saved["id"],
        mihomo_config_file=str(config_path),
        remove_config_blocks=False,
    )

    assert result["ok"] is True
    assert result["removed_config_blocks"] is False
    assert config_path.read_text(encoding="utf-8") == config
    assert svc.load_subscription_state(str(tmp_path))["subscriptions"] == []


def test_delete_config_subscription_can_remove_proxy_blocks_from_editor_text(tmp_path):
    proxy_yaml = "- name: Old Node\n  type: vless\n  server: 1.1.1.1\n  port: 443\n"
    config = (
        "proxies:\n"
        "  - name: Old Node\n"
        "    type: vless\n"
        "    server: 1.1.1.1\n"
        "    port: 443\n"
        "\n"
        "  - name: Keep Node\n"
        "    type: vless\n"
        "    server: 2.2.2.2\n"
        "    port: 443\n"
        "proxy-groups:\n"
        "  - name: Заблок. сервисы\n"
        "    type: select\n"
        "    proxies:\n"
        "      - \"Old Node\"\n"
        "      - \"Keep Node\"\n"
    )
    saved = svc.sync_imported_xray_subscription(
        str(tmp_path),
        url="https://example.test/xray.json",
        config_text=config,
        proxy_yamls=[proxy_yaml],
        groups=["Заблок. сервисы"],
        interval_hours=24,
    )

    result = svc.delete_subscription(
        str(tmp_path),
        saved["id"],
        remove_config_blocks=True,
        config_text=config,
    )

    assert result["ok"] is True
    assert result["removed_config_blocks"] is True
    assert result["changed"] is True
    assert "Old Node" not in result["content"]
    assert "Keep Node" in result["content"]
    assert '      - "Keep Node"' in result["content"]
    state = svc.load_subscription_state(str(tmp_path))
    assert state["subscriptions"] == []
    assert state["last_config_hash"] == svc._hash_text(result["content"])


def test_refresh_config_subscription_replaces_imported_proxy_blocks(tmp_path, monkeypatch):
    old_body = _subscription_body("Old Node", "1.1.1.1", "11111111-1111-1111-1111-111111111111")
    old_proxies, _ = svc.convert_subscription_text(old_body)
    old_yaml = "\n\n".join(p.yaml.strip() for p in old_proxies)
    old_name = old_proxies[0].name
    current_config = (
        "proxies:\n"
        + "\n".join("  " + line for line in old_yaml.splitlines())
        + "\nproxy-groups:\n"
        + "  - name: Заблок. сервисы\n"
        + "    type: select\n"
        + "    proxies:\n"
        + f"      - \"{old_name}\"\n"
    )

    config_path = tmp_path / "config.yaml"
    config_path.write_text(current_config, encoding="utf-8")
    saved = svc.sync_imported_xray_subscription(
        str(tmp_path),
        url="https://example.test/xray.json",
        config_text=current_config,
        proxy_yamls=[old_yaml],
        groups=["Заблок. сервисы"],
        interval_hours=24,
    )

    new_body = _subscription_body("New Node", "2.2.2.2", "22222222-2222-2222-2222-222222222222")
    monkeypatch.setattr(
        svc,
        "fetch_subscription_body",
        lambda url: (new_body, {}, {"fetch_mode": "happ_ua"}),
    )

    restarts: list[str] = []

    def _restart(*, source="api"):
        restarts.append(source)

    def _save(text: str):
        config_path.write_text(text, encoding="utf-8")

    result = svc.refresh_subscription(
        str(tmp_path),
        saved["id"],
        mihomo_config_file=str(config_path),
        restart_xkeen=_restart,
        save_callback=_save,
    )

    assert result["ok"] is True
    assert result["changed"] is True
    assert restarts == ["mihomo-subscription-refresh"]
    written = config_path.read_text(encoding="utf-8")
    assert "Old Node" not in written
    assert "New Node" in written
    assert "2.2.2.2" in written
    assert '      - "New Node"' in written
    state = svc.load_subscription_state(str(tmp_path))
    sub = state["subscriptions"][0]
    assert sub["source"] == "config"
    assert sub["proxy_names"] == ["New Node"]
    assert "New Node" in sub["managed_yaml"]
