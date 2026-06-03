from __future__ import annotations

import base64
import json
import threading
from pathlib import Path

import pytest


def _vless(name: str = "Node") -> str:
    return (
        "vless://user@example.com:443"
        "?type=tcp&security=reality&sni=edge.example.com&pbk=pubkey&encryption=none"
        f"#{name}"
    )


def _vless_reality(name: str = "Node", *, sid: str = "") -> str:
    safe_name = str(name or "").replace(" ", "%20")
    return (
        "vless://user@example.com:443"
        f"?type=tcp&security=reality&sni=edge.example.com&pbk=pubkey&sid={sid}&spx=%2F&encryption=none"
        f"#{safe_name}"
    )


def _trojan(name: str = "Node") -> str:
    safe_name = str(name or "").replace(" ", "%20")
    return f"trojan://secret@example.net:443?security=tls&sni=edge.example.com#{safe_name}"


def _vless_transport(name: str, transport: str, *, host: str = "example.com") -> str:
    safe_name = str(name or "").replace(" ", "%20")
    query = [f"type={transport}", "security=tls", "sni=edge.example.com", "encryption=none"]
    if transport == "ws":
        query.extend(["host=cdn.example.com", "path=%2Fws"])
    elif transport == "grpc":
        query.append("serviceName=grpc")
    elif transport == "xhttp":
        query.extend(["host=cdn.example.com", "path=%2Fx"])
    return f"vless://user@{host}:443?{'&'.join(query)}#{safe_name}"


def test_parse_subscription_links_accepts_plain_and_base64_payloads():
    from services.xray_subscriptions import parse_subscription_links

    plain = _vless("Plain") + "\nunknown://skip\n" + _vless("Second")
    assert parse_subscription_links(plain) == [_vless("Plain"), _vless("Second")]

    encoded = base64.b64encode(plain.encode("utf-8")).decode("ascii")
    assert parse_subscription_links(encoded) == [_vless("Plain"), _vless("Second")]


def test_upsert_subscription_validates_regex_filters(tmp_path: Path):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    ui_state_dir.mkdir()

    with pytest.raises(ValueError, match="regex"):
        subs.upsert_subscription(
            str(ui_state_dir),
            {
                "id": "demo",
                "url": "https://example.com/sub",
                "name_filter": "(",
            },
        )


def test_upsert_subscription_allows_same_url_with_distinct_filtered_profiles(tmp_path: Path):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    ui_state_dir.mkdir()

    first = subs.upsert_subscription(
        str(ui_state_dir),
        {
            "name": "VNI regular",
            "tag": "vni_hosting",
            "url": "https://example.com/subscription",
            "name_filter": "Russia|VNI",
        },
    )
    second = subs.upsert_subscription(
        str(ui_state_dir),
        {
            "name": "VNI anti whitelist",
            "tag": "white_list",
            "url": "https://example.com/subscription",
            "name_filter": "Анти|Anti|White|Бел",
        },
    )

    assert first["id"] == "vni_hosting"
    assert second["id"] == "white_list"
    assert first["url"] == second["url"]
    assert first["output_file"] == "04_outbounds.vni_hosting.json"
    assert second["output_file"] == "04_outbounds.white_list.json"

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"]
    assert [item["id"] for item in saved] == ["vni_hosting", "white_list"]
    assert [item["name_filter"] for item in saved] == ["Russia|VNI", "Анти|Anti|White|Бел"]


def test_refresh_subscription_writes_generated_fragment_and_observatory(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless("Fast Node"), {"profile-update-interval": "2"}),
    )

    sub = subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "demo",
            "name": "Demo",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "interval_hours": 6,
        },
    )
    assert sub["id"] == "demo"

    restarts = []
    result = subs.refresh_subscription(
        str(ui_state_dir),
        "demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **kwargs: restarts.append(kwargs) or True,
        restart=True,
    )

    assert result["ok"] is True
    assert result["count"] == 1
    assert result["changed"] is True
    assert result["observatory_changed"] is True
    assert result["restarted"] is True
    assert restarts and restarts[0]["source"] == "xray-subscription-refresh"

    out_path = xray_dir / "04_outbounds.demo.json"
    generated = json.loads(out_path.read_text(encoding="utf-8"))
    assert list(generated) == ["outbounds"]
    assert len(generated["outbounds"]) == 1
    assert generated["outbounds"][0]["tag"] == "demo--Fast_Node"
    assert generated["outbounds"][0]["protocol"] == "vless"
    assert generated["outbounds"][0]["settings"]["address"] == "example.com"
    assert generated["outbounds"][0]["settings"]["id"] == "user"
    assert "vnext" not in generated["outbounds"][0]["settings"]

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["demo"]

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["last_ok"] is True
    assert saved["last_count"] == 1
    assert saved["profile_update_interval_hours"] == 2
    assert saved["interval_hours"] == 6
    assert saved["next_update_ts"] - saved["last_update_ts"] == 6 * 3600

    restarts.clear()
    second = subs.refresh_subscription(
        str(ui_state_dir),
        "demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **kwargs: restarts.append(kwargs) or True,
        restart=True,
    )
    assert second["ok"] is True
    assert second["changed"] is False
    assert second["observatory_changed"] is False
    assert second["routing_changed"] is False
    assert second["restarted"] is False
    assert restarts == []


def test_refresh_subscription_does_not_restart_when_provider_reorders_nodes(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    links = [
        _vless_transport("Alpha", "tcp", host="alpha.example.com"),
        _vless_transport("Beta", "tcp", host="beta.example.com"),
    ]
    bodies = ["\n".join(links), "\n".join(reversed(links))]

    def fetch_subscription_body(_url):
        return bodies.pop(0), {}

    monkeypatch.setattr(subs, "fetch_subscription_body", fetch_subscription_body)

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "demo",
            "name": "Demo",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    restarts = []
    first = subs.refresh_subscription(
        str(ui_state_dir),
        "demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **kwargs: restarts.append(kwargs) or True,
        restart=True,
    )

    assert first["ok"] is True
    assert first["changed"] is True
    assert first["restarted"] is True

    out_path = xray_dir / "04_outbounds.demo.json"
    raw_path = jsonc_dir / "04_outbounds.demo.jsonc"
    first_output = out_path.read_text(encoding="utf-8")
    first_raw = raw_path.read_text(encoding="utf-8")
    first_hash = subs.load_subscription_state(str(ui_state_dir))["subscriptions"][0]["last_hash"]

    restarts.clear()
    second = subs.refresh_subscription(
        str(ui_state_dir),
        "demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **kwargs: restarts.append(kwargs) or True,
        restart=True,
    )

    assert second["ok"] is True
    assert second["changed"] is False
    assert second["restarted"] is False
    assert restarts == []
    assert out_path.read_text(encoding="utf-8") == first_output
    assert raw_path.read_text(encoding="utf-8") == first_raw
    assert subs.load_subscription_state(str(ui_state_dir))["subscriptions"][0]["last_hash"] == first_hash


def test_refresh_subscription_preserves_manual_outbound_edits_on_update(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    bodies = [_vless_reality("Alpha", sid="old"), _vless_reality("Alpha", sid="new")]
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda _url: (bodies.pop(0), {}))

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "manual-edit",
            "name": "Manual Edit",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    first = subs.refresh_subscription(
        str(ui_state_dir),
        "manual-edit",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )
    assert first["ok"] is True

    out_path = xray_dir / "04_outbounds.manual-edit.json"
    current = json.loads(out_path.read_text(encoding="utf-8"))
    current["outbounds"][0]["sendThrough"] = "127.0.0.1"
    current["outbounds"][0]["streamSettings"]["realitySettings"]["fingerprint"] = "firefox"
    out_path.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    second = subs.refresh_subscription(
        str(ui_state_dir),
        "manual-edit",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert second["ok"] is True
    assert second["manual_edits_preserved"] == 1

    refreshed = json.loads(out_path.read_text(encoding="utf-8"))["outbounds"][0]
    assert refreshed["sendThrough"] == "127.0.0.1"
    assert refreshed["streamSettings"]["realitySettings"]["fingerprint"] == "firefox"
    assert refreshed["streamSettings"]["realitySettings"]["shortId"] == "new"


def test_subscription_refresh_and_delete_preserve_outbounds_sockopt_marks(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    base_outbounds = {
        "outbounds": [
            {
                "tag": "vless-reality",
                "protocol": "vless",
                "streamSettings": {
                    "network": "tcp",
                    "security": "reality",
                    "sockopt": {"mark": 255},
                },
            },
            {
                "tag": "direct",
                "protocol": "freedom",
                "streamSettings": {"sockopt": {"mark": 255}},
            },
            {
                "tag": "block",
                "protocol": "blackhole",
                "settings": {"response": {"type": "http"}},
            },
        ]
    }
    base_path = xray_dir / "04_outbounds.json"
    base_path.write_text(json.dumps(base_outbounds, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda _url: (_vless_reality("Alpha"), {}))

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "marked-sub",
            "name": "Marked Sub",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    refreshed = subs.refresh_subscription(
        str(ui_state_dir),
        "marked-sub",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert refreshed["ok"] is True
    sub_path = xray_dir / "04_outbounds.marked-sub.json"
    sub_config = json.loads(sub_path.read_text(encoding="utf-8"))
    assert sub_config["outbounds"][0]["streamSettings"]["sockopt"]["mark"] == 255

    deleted = subs.delete_subscription(
        str(ui_state_dir),
        "marked-sub",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        remove_file=True,
        restart_xkeen=lambda **_kwargs: True,
    )

    assert deleted["deleted"]["id"] == "marked-sub"
    assert deleted["output_removed"] is True
    assert not sub_path.exists()
    restored_base = json.loads(base_path.read_text(encoding="utf-8"))
    assert restored_base["outbounds"][0]["streamSettings"]["sockopt"]["mark"] == 255
    assert restored_base["outbounds"][1]["streamSettings"]["sockopt"]["mark"] == 255


def test_subscription_refresh_can_apply_entware_sockopt_mark(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda _url: (_vless_reality("Alpha"), {}))

    saved = subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "entware-sub",
            "name": "Entware Sub",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
            "sockopt_mark_255": True,
        },
    )

    assert saved["sockopt_mark_255"] is True

    refreshed = subs.refresh_subscription(
        str(ui_state_dir),
        "entware-sub",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert refreshed["ok"] is True
    sub_path = xray_dir / "04_outbounds.entware-sub.json"
    sub_config = json.loads(sub_path.read_text(encoding="utf-8"))
    assert sub_config["outbounds"][0]["streamSettings"]["sockopt"]["mark"] == 255


def test_refresh_subscription_turns_manual_node_deletion_into_saved_exclusion(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: ("\n".join([_vless_reality("Alpha"), _vless_reality("Beta")]), {}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "manual-delete",
            "name": "Manual Delete",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    first = subs.refresh_subscription(
        str(ui_state_dir),
        "manual-delete",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )
    assert first["ok"] is True

    state = subs.load_subscription_state(str(ui_state_dir))
    beta_key = next(item["key"] for item in state["subscriptions"][0]["last_nodes"] if item["name"] == "Beta")

    out_path = xray_dir / "04_outbounds.manual-delete.json"
    current = json.loads(out_path.read_text(encoding="utf-8"))
    current["outbounds"] = [item for item in current["outbounds"] if item["tag"] != "demo--Beta"]
    out_path.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    second = subs.refresh_subscription(
        str(ui_state_dir),
        "manual-delete",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert second["ok"] is True
    assert second["changed"] is True
    assert second["manual_exclusions_added"] == 1
    assert [item["tag"] for item in json.loads(out_path.read_text(encoding="utf-8"))["outbounds"]] == ["demo--Alpha"]

    saved = subs.load_subscription_state(str(ui_state_dir))["subscriptions"][0]
    assert saved["excluded_node_keys"] == [beta_key]
    assert next(item for item in saved["last_nodes"] if item["name"] == "Beta").get("tag") in ("", None)


def test_new_subscription_defaults_to_daily_interval(tmp_path: Path):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    ui_state_dir.mkdir()

    sub = subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "daily",
            "name": "Daily",
            "tag": "daily",
            "url": "https://example.com/sub",
        },
    )

    assert sub["interval_hours"] == 24


def test_new_enabled_subscription_schedules_first_refresh_one_interval_out(tmp_path: Path):
    """Regression: a freshly saved subscription must NOT be marked due
    immediately, otherwise the background scheduler picks it up within ~60s
    and triggers a refresh+restart even when the user explicitly unchecked
    "Обновить сразу".
    """
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    ui_state_dir.mkdir()

    before = subs._now()
    sub = subs.upsert_subscription(
        str(ui_state_dir),
        {
            "name": "Pending",
            "tag": "pending",
            "url": "https://example.com/sub",
            "enabled": True,
            "interval_hours": 6,
        },
    )
    after = subs._now()

    assert sub["enabled"] is True
    delta = sub["next_update_ts"] - before
    assert delta >= 6 * 3600
    assert sub["next_update_ts"] - after <= 6 * 3600


def test_new_disabled_subscription_keeps_next_update_null(tmp_path: Path):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    ui_state_dir.mkdir()

    sub = subs.upsert_subscription(
        str(ui_state_dir),
        {
            "name": "Off",
            "tag": "off",
            "url": "https://example.com/sub",
            "enabled": False,
        },
    )

    assert sub["enabled"] is False
    assert sub["next_update_ts"] is None


def test_refresh_subscription_failure_schedules_short_retry_and_preserves_fragment(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setenv("XKEEN_SUBSCRIPTION_ERROR_RETRY_SECONDS", str(subs.DEFAULT_ERROR_RETRY_SECONDS))
    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda _url: (_vless("Stable Node"), {}))

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "demo",
            "name": "Demo",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "interval_hours": 24,
        },
    )

    first = subs.refresh_subscription(
        str(ui_state_dir),
        "demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=True,
    )
    assert first["ok"] is True
    out_path = xray_dir / "04_outbounds.demo.json"
    generated_before = out_path.read_text(encoding="utf-8")

    def _fail_fetch(_url: str):
        raise RuntimeError("network down")

    restarts = []
    monkeypatch.setattr(subs, "fetch_subscription_body", _fail_fetch)
    failed = subs.refresh_subscription(
        str(ui_state_dir),
        "demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **kwargs: restarts.append(kwargs) or True,
        restart=True,
    )

    assert failed["ok"] is False
    assert failed["error"] == "network down"
    assert failed["retry_after_seconds"] == subs.DEFAULT_ERROR_RETRY_SECONDS
    assert restarts == []
    assert out_path.read_text(encoding="utf-8") == generated_before

    saved = subs.load_subscription_state(str(ui_state_dir))["subscriptions"][0]
    assert saved["last_ok"] is False
    assert saved["last_error"] == "network down"
    assert saved["last_error_retry_seconds"] == subs.DEFAULT_ERROR_RETRY_SECONDS
    assert saved["next_update_ts"] - saved["last_update_ts"] == pytest.approx(subs.DEFAULT_ERROR_RETRY_SECONDS)
    assert saved["last_count"] == 1


def test_preview_subscription_returns_nodes_without_state_changes(tmp_path: Path, monkeypatch):
    """Preview must fetch+parse only — no state file, no disk writes,
    no observatory/routing sync, no restart side-effects.
    """
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    ui_state_dir.mkdir()

    body = "\n".join([_vless("Germany"), _vless("Netherlands"), _trojan("USA")])
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (body, {}),
    )

    result = subs.preview_subscription(
        {
            "url": "https://example.com/sub",
            "tag": "demo",
        }
    )

    assert result["ok"] is True
    assert result["count"] == 3
    assert result["source_count"] == 3
    assert result["filtered_out_count"] == 0
    assert result["source_format"] == "links"
    assert {n["name"] for n in result["nodes"]} == {"Germany", "Netherlands", "USA"}

    # No state file should have been created.
    assert not any(ui_state_dir.iterdir())


def test_preview_subscription_applies_filters_and_exclusions(tmp_path, monkeypatch):
    from services import xray_subscriptions as subs

    body = "\n".join([_vless("Germany"), _vless("Russia"), _trojan("USA")])
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (body, {}),
    )

    result = subs.preview_subscription(
        {
            "url": "https://example.com/sub",
            "tag": "demo",
            "type_filter": "vless",
        }
    )

    # Trojan should be filtered out by type filter.
    assert result["count"] == 2
    assert result["source_count"] == 3
    assert result["filtered_out_count"] == 1


def test_refresh_subscription_keeps_preview_exclusions_when_reality_sid_and_spx_rotate(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    reality_1 = (
        "vless://user@cp.landing-nl.rfid-technologies.org:443"
        "?encryption=none&flow=xtls-rprx-vision&fp=firefox&pbk=pub"
        "&security=reality&sid=1111111111111111&sni=landing-nl.rfid-technologies.org"
        "&spx=%2Fpreview111&type=tcp#VLESS-REALITY-NL-Keenetic-Digus"
    )
    reality_2 = (
        "vless://user@cp.landing-nl.rfid-technologies.org:443"
        "?encryption=none&flow=xtls-rprx-vision&fp=firefox&pbk=pub"
        "&security=reality&sid=2222222222222222&sni=landing-nl.rfid-technologies.org"
        "&spx=%2Frefresh222&type=tcp#VLESS-REALITY-NL-Keenetic-Digus"
    )
    xhttp = (
        "vless://user@cp.landing-nl.rfid-technologies.org:443"
        "?encryption=none&mode=packet-up&path=%2FznyHydKmI6&security=tls&type=xhttp"
        "#VLESS-XHTTP-NL-Keenetic-Digu-X"
    )

    preview_body = base64.b64encode(f"{reality_1}\n{xhttp}\n".encode("utf-8")).decode("ascii")
    refresh_body = base64.b64encode(f"{reality_2}\n{xhttp}\n".encode("utf-8")).decode("ascii")
    responses = iter([(preview_body, {}), (refresh_body, {})])
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda _url: next(responses))

    preview = subs.preview_subscription(
        {
            "url": "https://example.com/sub",
            "tag": "cp.landing-nl-rfid-technologies",
        }
    )
    reality_key = next(item["key"] for item in preview["nodes"] if "REALITY" in item["name"])

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "cp.landing-nl-rfid-technologies",
            "name": "cp.landing-nl-rfid-technologies",
            "tag": "cp.landing-nl-rfid-technologies",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "excluded_node_keys": [reality_key],
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "cp.landing-nl-rfid-technologies",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    assert result["filtered_out_count"] == 1
    generated = json.loads((xray_dir / "04_outbounds.cp.landing-nl-rfid-technologies.json").read_text(encoding="utf-8"))
    assert [item["tag"] for item in generated["outbounds"]] == [
        "cp.landing-nl-rfid-technologies--VLESS-XHTTP-NL-Keenetic-Digu-X"
    ]

    saved = subs.load_subscription_state(str(ui_state_dir))["subscriptions"][0]
    assert saved["excluded_node_keys"] == [reality_key]
    assert {item["name"] for item in saved["last_nodes"] if item.get("tag")} == {
        "VLESS-XHTTP-NL-Keenetic-Digu-X"
    }


def test_preview_subscription_requires_url():
    from services import xray_subscriptions as subs

    with pytest.raises(ValueError):
        subs.preview_subscription({})


def test_refresh_subscription_omits_auto_xhttp_mode_for_link_payload(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("XHTTP Node", "xhttp", host="edge.example.com"), {}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "xhttp-link",
            "tag": "xhttp-link",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "xhttp-link",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    generated = json.loads((xray_dir / result["output_file"]).read_text(encoding="utf-8"))
    xhttp_settings = generated["outbounds"][0]["streamSettings"]["xhttpSettings"]
    assert xhttp_settings["path"] == "/x"
    assert xhttp_settings["host"] == "cdn.example.com"
    assert "mode" not in xhttp_settings


def test_refresh_subscription_json_outbounds_strips_xhttp_auto_mode(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    subscription_body = json.dumps(
        [
            {
                "remarks": "XHTTP Auto",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "edge.example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                        "streamSettings": {
                            "network": "xhttp",
                            "security": "tls",
                            "tlsSettings": {"serverName": "edge.example.com"},
                            "xhttpSettings": {
                                "host": "cdn.example.com",
                                "path": "/api/v2/",
                                "mode": "auto",
                            },
                        },
                    }
                ],
            }
        ]
    )
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (subscription_body, {"content-type": "application/json"}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "json-xhttp",
            "tag": "json-xhttp",
            "url": "https://example.com/json",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "json-xhttp",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    assert result["source_format"] == "xray-json"
    generated = json.loads((xray_dir / result["output_file"]).read_text(encoding="utf-8"))
    xhttp_settings = generated["outbounds"][0]["streamSettings"]["xhttpSettings"]
    assert xhttp_settings["path"] == "/api/v2/"
    assert xhttp_settings["host"] == "cdn.example.com"
    assert "mode" not in xhttp_settings


def test_refresh_subscription_canonicalizes_legacy_root_routing_shape(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless("Canonical Node"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps({"domainStrategy": "AsIs", "rules": []}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "canon-route",
            "tag": "canon-route",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "canon-route",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    assert "domainStrategy" not in routing
    assert "rules" not in routing
    assert routing["routing"]["domainStrategy"] == "AsIs"
    assert routing["routing"]["rules"][0]["ruleTag"] == "xk_auto_leastPing"


def test_sync_subscription_routing_rewrites_legacy_hybrid_shape_when_selector_is_already_current(tmp_path: Path):
    from services import xray_subscriptions as subs

    xray_dir = tmp_path / "xray" / "configs"
    xray_dir.mkdir(parents=True)

    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "domainStrategy": "AsIs",
                "rules": [],
                "routing": {
                    "balancers": [
                        {
                            "tag": "proxy",
                            "selector": ["demo--Node"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        }
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "balancerTag": "proxy",
                            "inboundTag": ["redirect", "tproxy"],
                            "ruleTag": "xk_auto_leastPing",
                        }
                    ],
                },
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    result = subs.sync_subscription_routing(
        xray_configs_dir=str(xray_dir),
        add_tags=["demo--Node"],
        remove_tags=[],
        routing_mode=subs.ROUTING_MODE_SAFE,
        snapshot=None,
    )

    assert result["changed"] is True
    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    assert "domainStrategy" not in routing
    assert "rules" not in routing
    assert routing["routing"]["balancers"][0]["selector"] == ["demo--Node"]


def test_refresh_subscription_auto_syncs_routing_and_keeps_vless_reality(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {
                        "tag": "vless-reality",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "edge.example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                    },
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "rules": [
                        {
                            "type": "field",
                            "inboundTag": ["redirect", "tproxy"],
                            "outboundTag": "vless-reality",
                            "domain": ["ext:geosite_v2fly.dat:openai"],
                        },
                        {
                            "type": "field",
                            "inboundTag": ["redirect", "tproxy"],
                            "outboundTag": "direct",
                        },
                    ]
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "auto-route",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "auto-route",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_changed"] is True
    assert result["routing_balancer_tag"] == "proxy"
    assert result["routing_selector_count"] == 2

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["cdn.pecan.run", "vless-reality"]

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = routing["routing"]["balancers"]
    assert len(balancers) == 1
    assert balancers[0]["tag"] == "proxy"
    assert balancers[0]["strategy"]["type"] == "leastPing"
    assert balancers[0]["selector"] == ["cdn.pecan.run", "vless-reality"]

    rules = routing["routing"]["rules"]
    assert rules[0]["outboundTag"] == "vless-reality"
    assert rules[1]["ruleTag"] == "xk_auto_leastPing"
    assert rules[1]["balancerTag"] == "proxy"
    assert rules[2]["outboundTag"] == "direct"


def test_refresh_subscription_does_not_replace_mobile_whitelist_scenario_with_auto_pool(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "domainStrategy": "IPIfNonMatch",
                    "balancers": [
                        {
                            "tag": "balancer_main",
                            "selector": ["my_proxy"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "loopback_to_reserv",
                        },
                        {
                            "tag": "balancer_reserv",
                            "selector": ["reserve_proxy"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "loopback_to_white",
                        },
                        {
                            "tag": "balancer_white_list",
                            "selector": ["white_list"],
                            "strategy": {"type": "leastPing"},
                        },
                        {
                            "tag": "proxy",
                            "selector": ["white_list", "reserve_proxy"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        },
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "ruleTag": "xk_scenario_mobile_whitelist_direct_private",
                            "inboundTag": ["redirect", "tproxy", "socks-in"],
                            "outboundTag": "direct",
                            "ip": ["127.0.0.0/8"],
                        },
                        {
                            "type": "field",
                            "balancerTag": "proxy",
                            "inboundTag": ["redirect", "tproxy"],
                            "ruleTag": "xk_auto_leastPing",
                        },
                    ],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "white-list",
            "tag": "white_list",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "white-list",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_changed"] is True
    assert result["routing_balancer_tag"] == ""
    assert result["routing_selector_count"] == 0

    generated = json.loads((xray_dir / "04_outbounds.white-list.json").read_text(encoding="utf-8"))
    assert [item["tag"] for item in generated["outbounds"]] == ["white_list--WS_Germany"]

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["white_list"]

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = {item["tag"]: item for item in routing["routing"]["balancers"]}
    assert "proxy" not in balancers
    assert balancers["balancer_main"]["selector"] == ["my_proxy"]
    assert balancers["balancer_reserv"]["selector"] == ["reserve_proxy"]
    assert balancers["balancer_white_list"]["selector"] == ["white_list"]
    assert all(rule.get("ruleTag") != "xk_auto_leastPing" for rule in routing["routing"]["rules"])
    assert any(
        str(rule.get("ruleTag") or "").startswith("xk_scenario_mobile_whitelist_")
        for rule in routing["routing"]["rules"]
    )


def test_refresh_subscription_only_mode_excludes_vless_reality_from_runtime_pool(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "vless-reality", "protocol": "vless"},
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps(
            {"observatory": {"subjectSelector": ["vless-reality"]}},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "balancers": [
                        {
                            "tag": "proxy",
                            "selector": ["vless-reality"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        }
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "inboundTag": ["redirect", "tproxy"],
                            "outboundTag": "vless-reality",
                            "domain": ["ext:geosite_v2fly.dat:openai"],
                        },
                        {
                            "type": "field",
                            "balancerTag": "proxy",
                            "inboundTag": ["redirect", "tproxy"],
                            "ruleTag": "xk_auto_leastPing",
                        },
                        {
                            "type": "field",
                            "inboundTag": ["redirect", "tproxy"],
                            "outboundTag": "direct",
                        },
                    ],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "only-subscription",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_mode": "subscription-only",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "only-subscription",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_mode"] == "subscription-only"
    assert result["routing_selector_count"] == 1
    assert result["routing_migrated_rules"] == 1

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["cdn.pecan.run"]

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = {item["tag"]: item for item in routing["routing"]["balancers"]}
    assert balancers["proxy"]["selector"] == ["cdn.pecan.run"]

    rules = routing["routing"]["rules"]
    assert rules[0]["ruleTag"].startswith("xk_auto_vless_pool_")
    assert rules[0]["balancerTag"] == "proxy"
    assert "outboundTag" not in rules[0]
    assert rules[1]["ruleTag"] == "xk_auto_leastPing"
    assert rules[2]["outboundTag"] == "direct"


def test_refresh_subscription_only_mode_removes_existing_manual_proxy_from_runtime_pool(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "proxy", "protocol": "vless"},
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps(
            {"observatory": {"subjectSelector": ["proxy"]}},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "balancers": [
                        {
                            "tag": "proxy",
                            "selector": ["proxy"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        }
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "balancerTag": "proxy",
                            "inboundTag": ["redirect", "tproxy"],
                            "ruleTag": "xk_auto_leastPing",
                        }
                    ],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "only-subscription",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_mode": "subscription-only",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "only-subscription",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_mode"] == "subscription-only"

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["cdn.pecan.run"]

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = {item["tag"]: item for item in routing["routing"]["balancers"]}
    assert balancers["proxy"]["selector"] == ["cdn.pecan.run"]


def test_refresh_subscription_only_mode_does_not_require_single_outbound(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps({"routing": {"rules": []}}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "generated-only",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
            "routing_mode": "subscription-only",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "generated-only",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_mode"] == "subscription-only"
    assert result["routing_selector_count"] == 1
    assert result["routing_migrated_rules"] == 0

    base_outbounds = json.loads((xray_dir / "04_outbounds.json").read_text(encoding="utf-8"))
    assert [item["tag"] for item in base_outbounds["outbounds"]] == ["direct", "block"]
    assert not (xray_dir / "04_outbounds.json.disable").exists()

    generated = json.loads((xray_dir / "04_outbounds.generated-only.json").read_text(encoding="utf-8"))
    assert [item["tag"] for item in generated["outbounds"]] == ["cdn.pecan.run--WS_Germany"]

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["cdn.pecan.run"]

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = {item["tag"]: item for item in routing["routing"]["balancers"]}
    assert balancers["proxy"]["selector"] == ["cdn.pecan.run"]
    assert all("vless-reality" not in json.dumps(rule) for rule in routing["routing"]["rules"])
    assert routing["routing"]["rules"][0]["ruleTag"] == "xk_auto_leastPing"
    assert routing["routing"]["rules"][0]["balancerTag"] == "proxy"


def test_refresh_subscription_service_pool_does_not_depend_on_ping_toggle(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps({"routing": {"rules": []}}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "pool-without-ping",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
            "routing_auto_rule": True,
            "routing_mode": "subscription-only",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "pool-without-ping",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["observatory_changed"] is False
    assert result["routing_changed"] is True
    assert result["routing_mode"] == "subscription-only"
    assert result["routing_selector_count"] == 1
    assert not (xray_dir / "07_observatory.json").exists()

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = {item["tag"]: item for item in routing["routing"]["balancers"]}
    assert balancers["proxy"]["selector"] == ["cdn.pecan.run"]
    assert routing["routing"]["rules"][0]["balancerTag"] == "proxy"

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["last_selector_terms"] == ["cdn.pecan.run"]
    assert saved["last_runtime_active"] is True


def test_refresh_subscription_creates_dedicated_auto_pool_and_keeps_user_balancers_manual(
    tmp_path: Path,
    monkeypatch,
):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "balancers": [
                        {
                            "tag": "fast_web_balancer",
                            "selector": ["VPS_"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        },
                        {
                            "tag": "heavy_load_balancer",
                            "selector": ["VPS_"],
                            "strategy": {"type": "leastLoad"},
                            "fallbackTag": "direct",
                        },
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "ruleTag": "manual_direct",
                            "outboundTag": "direct",
                        }
                    ],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps(
            {
                "observatory": {
                    "subjectSelector": ["VPS_"],
                    "probeUrl": "https://probe.example.com",
                    "probeInterval": "120s",
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "manual-friendly",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
            "routing_balancer_tags": ["heavy_load_balancer"],
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "manual-friendly",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_changed"] is True
    assert result["routing_balancer_tag"] == "proxy"
    assert result["routing_manual_balancer_tags"] == ["heavy_load_balancer"]
    assert result["routing_selector_count"] == 1

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["VPS_", "demo"]

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = {item["tag"]: item for item in routing["routing"]["balancers"]}
    assert balancers["fast_web_balancer"]["selector"] == ["VPS_"]
    assert balancers["heavy_load_balancer"]["selector"] == ["VPS_", "demo"]
    assert balancers["proxy"]["selector"] == ["demo"]
    assert balancers["proxy"]["strategy"]["type"] == "leastPing"
    assert balancers["proxy"]["fallbackTag"] == "direct"

    rules = routing["routing"]["rules"]
    assert any(rule.get("ruleTag") == "manual_direct" for rule in rules)
    auto_rules = [rule for rule in rules if rule.get("ruleTag") == "xk_auto_leastPing"]
    assert len(auto_rules) == 1
    assert auto_rules[0]["balancerTag"] == "proxy"


def test_refresh_subscription_syncs_selected_manual_balancers_without_auto_pool(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "balancers": [
                        {
                            "tag": "fast_web_balancer",
                            "selector": ["VPS_"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        },
                        {
                            "tag": "backup_pool",
                            "selector": ["RESERVE_"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        },
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "ruleTag": "manual_direct",
                            "outboundTag": "direct",
                        }
                    ],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "manual-only",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": False,
            "routing_balancer_tags": ["fast_web_balancer", "backup_pool"],
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "manual-only",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_changed"] is True
    assert result["routing_balancer_tag"] == ""
    assert result["routing_manual_balancer_tags"] == ["backup_pool", "fast_web_balancer"]
    assert result["routing_selector_count"] == 0

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["demo"]

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = {item["tag"]: item for item in routing["routing"]["balancers"]}
    assert balancers["fast_web_balancer"]["selector"] == ["VPS_", "demo"]
    assert balancers["backup_pool"]["selector"] == ["RESERVE_", "demo"]
    assert all(rule.get("ruleTag") != "xk_auto_leastPing" for rule in routing["routing"]["rules"])


def test_subscription_only_uses_selected_manual_balancers_instead_of_auto_pool(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("CH", "tcp", host="ch.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "VPS_legacy_pool", "protocol": "vless"},
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "balancers": [
                        {
                            "tag": "fast_web_balancer",
                            "selector": ["VPS_"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        },
                        {
                            "tag": "heavy_load_balancer",
                            "selector": ["VPS_"],
                            "strategy": {"type": "leastLoad"},
                            "fallbackTag": "direct",
                        },
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "ruleTag": "log_01_messengers_quic_domain",
                            "domain": ["ext:geosite_v2fly.dat:telegram"],
                            "balancerTag": "fast_web_balancer",
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_04_heavy_content_load",
                            "domain": ["domain:googlevideo.com"],
                            "balancerTag": "heavy_load_balancer",
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_05_direct_ru_by_domains",
                            "domain": ["ext:geosite_v2fly.dat:category-ru"],
                            "outboundTag": "direct",
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_07_catch_all_fast_web_balancer",
                            "network": "tcp,udp",
                            "balancerTag": "fast_web_balancer",
                        },
                    ],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps(
            {"observatory": {"subjectSelector": ["VPS_"], "probeUrl": "https://probe.example.com"}},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "test-sub-ch",
            "tag": "TEST_SUB_CH",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
            "routing_mode": "subscription-only",
            "routing_balancer_tags": ["fast_web_balancer", "heavy_load_balancer"],
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "test-sub-ch",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_mode"] == "subscription-only"
    assert result["routing_balancer_tag"] == ""
    assert result["routing_manual_balancer_tags"] == ["fast_web_balancer", "heavy_load_balancer"]
    assert result["routing_selector_count"] == 0
    assert result["disabled_manual_outbounds"] == 1

    base_outbounds = json.loads((xray_dir / "04_outbounds.json").read_text(encoding="utf-8"))
    assert [item["tag"] for item in base_outbounds["outbounds"]] == ["direct", "block"]

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["TEST_SUB_CH"]
    assert observatory["observatory"]["probeUrl"] == "https://probe.example.com"

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = {item["tag"]: item for item in routing["routing"]["balancers"]}
    assert "proxy" not in balancers
    assert balancers["fast_web_balancer"]["selector"] == ["TEST_SUB_CH"]
    assert balancers["heavy_load_balancer"]["selector"] == ["TEST_SUB_CH"]

    rules = routing["routing"]["rules"]
    assert all(rule.get("ruleTag") != "xk_auto_leastPing" for rule in rules)
    assert rules[0]["balancerTag"] == "fast_web_balancer"
    assert rules[1]["balancerTag"] == "heavy_load_balancer"
    assert rules[2]["outboundTag"] == "direct"
    assert rules[3]["balancerTag"] == "fast_web_balancer"


def test_get_subscription_routing_meta_reports_shadowing_catch_all_rule(tmp_path: Path):
    from services import xray_subscriptions as subs

    xray_dir = tmp_path / "xray" / "configs"
    xray_dir.mkdir(parents=True)

    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "balancers": [
                        {
                            "tag": "fast_web_balancer",
                            "selector": ["VPS_"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        }
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "ruleTag": "manual_ru_domains",
                            "outboundTag": "direct",
                            "domain": ["geosite:ru"],
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_07_catch_all_fast_web_balancer",
                            "balancerTag": "fast_web_balancer",
                            "inboundTag": ["redirect", "tproxy"],
                        },
                    ],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    meta = subs.get_subscription_routing_meta(str(xray_dir))

    assert meta["existing_auto_balancer_tag"] == ""
    assert meta["auto_balancer_candidate_tag"] == "proxy"
    assert meta["auto_rule_shadowing_rule_tag"] == "log_07_catch_all_fast_web_balancer"
    assert meta["auto_rule_shadowing_target_kind"] == "balancer"
    assert meta["auto_rule_shadowing_target_tag"] == "fast_web_balancer"
    assert meta["auto_rule_shadowing_target_label"] == 'balancer "fast_web_balancer"'
    assert meta["direct_rule_count"] == 1
    assert meta["ru_direct_rule_count"] == 1


def test_template_routing_meta_detects_shadowed_auto_pool_and_ru_direct_rules(tmp_path: Path):
    from services import xray_subscriptions as subs

    repo_root = Path(__file__).resolve().parents[1]
    template_path = repo_root / "xkeen-ui" / "opt" / "etc" / "xray" / "templates" / "routing" / "05_routing_all_proxy_except_ru.jsonc"
    raw = template_path.read_text(encoding="utf-8")

    xray_dir = tmp_path / "xray" / "configs"
    xray_dir.mkdir(parents=True)
    parsed = json.loads(subs._strip_jsonc_comments(raw))
    (xray_dir / "05_routing.json").write_text(
        json.dumps(parsed, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    meta = subs.get_subscription_routing_meta(str(xray_dir))

    assert meta["auto_rule_shadowing_rule_tag"] == ""
    assert meta["auto_rule_shadowing_target_kind"] == "outbound"
    assert meta["auto_rule_shadowing_target_tag"] == "vless-reality"
    assert meta["auto_rule_shadowing_target_label"] == 'outbound "vless-reality"'
    assert meta["direct_rule_count"] == 3
    assert meta["ru_direct_rule_count"] == 1


def test_template_zkeen_only_meta_detects_direct_catch_all_shadowing(tmp_path: Path):
    from services import xray_subscriptions as subs

    repo_root = Path(__file__).resolve().parents[1]
    template_path = repo_root / "xkeen-ui" / "opt" / "etc" / "xray" / "templates" / "routing" / "05_routing_zkeen_only.jsonc"
    raw = template_path.read_text(encoding="utf-8")

    xray_dir = tmp_path / "xray" / "configs"
    xray_dir.mkdir(parents=True)
    parsed = json.loads(subs._strip_jsonc_comments(raw))
    (xray_dir / "05_routing.json").write_text(
        json.dumps(parsed, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    meta = subs.get_subscription_routing_meta(str(xray_dir))

    assert meta["auto_rule_shadowing_rule_tag"] == ""
    assert meta["auto_rule_shadowing_target_kind"] == "outbound"
    assert meta["auto_rule_shadowing_target_tag"] == "direct"
    assert meta["auto_rule_shadowing_target_label"] == 'outbound "direct"'
    assert meta["direct_rule_count"] == 1
    assert meta["ru_direct_rule_count"] == 0


def test_refresh_subscription_preserves_ru_direct_rules_with_shadowed_auto_pool(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "balancers": [
                        {
                            "tag": "fast_web_balancer",
                            "selector": ["VPS_"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        }
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "ruleTag": "log_01_messengers_quic_domain",
                            "domain": ["ext:geosite_v2fly.dat:telegram"],
                            "protocol": ["quic"],
                            "balancerTag": "fast_web_balancer",
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_05_direct_ru_by_domains",
                            "outboundTag": "direct",
                            "domain": ["ext:geosite_v2fly.dat:category-ru", "domain:xn--p1ai"],
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_06_direct_ru_ip",
                            "outboundTag": "direct",
                            "ip": ["ext:geoip_zkeenip.dat:ru"],
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_07_catch_all_fast_web_balancer",
                            "balancerTag": "fast_web_balancer",
                            "network": "tcp,udp",
                        },
                    ],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "ru-direct-safe",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
            "routing_mode": "safe-fallback",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "ru-direct-safe",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_balancer_tag"] == "proxy"

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    rules = routing["routing"]["rules"]
    assert [rule.get("ruleTag") for rule in rules] == [
        "log_01_messengers_quic_domain",
        "log_05_direct_ru_by_domains",
        "log_06_direct_ru_ip",
        "log_07_catch_all_fast_web_balancer",
        "xk_auto_leastPing",
    ]
    assert rules[1]["outboundTag"] == "direct"
    assert rules[1]["domain"] == ["ext:geosite_v2fly.dat:category-ru", "domain:xn--p1ai"]
    assert rules[2]["outboundTag"] == "direct"
    assert rules[2]["ip"] == ["ext:geoip_zkeenip.dat:ru"]


def test_refresh_subscription_only_mode_replaces_manual_runtime_and_bypasses_shadowed_pool(
    tmp_path: Path,
    monkeypatch,
):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (
            _vless_transport(
                "VLESS-REALITY-NL-Keenetic-Dnepr-16k3",
                "tcp",
                host="cp.landing-nl.rfid-technologies.org",
            ),
            {},
        ),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "manual-vless", "protocol": "vless"},
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "04_outbounds_All.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "VPS_legacy_pool", "protocol": "vless"},
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "balancers": [
                        {
                            "tag": "fast_web_balancer",
                            "selector": ["VPS_"],
                            "strategy": {"type": "leastPing"},
                            "fallbackTag": "direct",
                        },
                        {
                            "tag": "heavy_load_balancer",
                            "selector": ["VPS_"],
                            "strategy": {"type": "leastLoad"},
                            "fallbackTag": "direct",
                        }
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "ruleTag": "log_01_messengers_quic_domain",
                            "domain": [
                                "ext:geosite_v2fly.dat:telegram",
                                "ext:geosite_v2fly.dat:whatsapp",
                            ],
                            "protocol": ["quic"],
                            "balancerTag": "fast_web_balancer",
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_03_block_quic_non_ru",
                            "outboundTag": "block",
                            "network": "udp",
                            "port": "443",
                            "ip": ["ext:geoip_zkeenip.dat:!ru"],
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_05_direct_ru_by_domains",
                            "outboundTag": "direct",
                            "domain": ["ext:geosite_v2fly.dat:category-ru"],
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_04_heavy_content_load",
                            "domain": ["domain:googlevideo.com", "ext:geosite_v2fly.dat:steam"],
                            "balancerTag": "heavy_load_balancer",
                        },
                        {
                            "type": "field",
                            "ruleTag": "log_07_catch_all_fast_web_balancer",
                            "balancerTag": "fast_web_balancer",
                            "network": "tcp,udp",
                        },
                    ],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps(
            {
                "observatory": {
                    "subjectSelector": ["VPS_"],
                    "probeUrl": "https://probe.example.com",
                    "probeInterval": "120s",
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "subscription-only",
            "tag": "cp.landing-nl.rfid-technologies.org",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
            "routing_mode": "subscription-only",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "subscription-only",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_mode"] == "subscription-only"
    assert result["routing_selector_count"] == 1
    assert result["routing_removed_manual_balancers"] == 2
    assert result["disabled_manual_outbounds"] == 1

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["cp.landing-nl.rfid-technologies.org"]
    assert observatory["observatory"]["probeUrl"] == "https://probe.example.com"

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = {item["tag"]: item for item in routing["routing"]["balancers"]}
    assert "fast_web_balancer" not in balancers
    assert "heavy_load_balancer" not in balancers
    assert balancers["proxy"]["selector"] == ["cp.landing-nl.rfid-technologies.org"]

    base_outbounds = json.loads((xray_dir / "04_outbounds.json").read_text(encoding="utf-8"))
    assert [item["tag"] for item in base_outbounds["outbounds"]] == ["direct", "block"]
    disabled_outbounds = json.loads((xray_dir / "04_outbounds.json.disable").read_text(encoding="utf-8"))
    assert [item["tag"] for item in disabled_outbounds["outbounds"]] == ["manual-vless", "direct", "block"]

    rules = routing["routing"]["rules"]
    assert [rule.get("ruleTag") for rule in rules] == [
        "log_01_messengers_quic_domain",
        "log_03_block_quic_non_ru",
        "log_05_direct_ru_by_domains",
        "log_04_heavy_content_load",
        "xk_auto_leastPing",
        "log_07_catch_all_fast_web_balancer",
    ]
    assert rules[0]["balancerTag"] == "proxy"
    assert rules[1]["outboundTag"] == "block"
    assert rules[2]["outboundTag"] == "direct"
    assert rules[3]["balancerTag"] == "proxy"
    assert rules[4]["balancerTag"] == "proxy"
    assert rules[5]["balancerTag"] == "proxy"

    deleted = subs.delete_subscription(
        str(ui_state_dir),
        "subscription-only",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        remove_file=True,
        restart_xkeen=None,
    )
    assert deleted["baseline_restored"] is True
    assert deleted["outbounds_changed"] is True
    restored_outbounds = json.loads((xray_dir / "04_outbounds.json").read_text(encoding="utf-8"))
    assert [item["tag"] for item in restored_outbounds["outbounds"]] == ["manual-vless", "direct", "block"]
    assert not (xray_dir / "04_outbounds.json.disable").exists()
    restored_routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    restored_balancers = {item["tag"]: item for item in restored_routing["routing"]["balancers"]}
    assert restored_balancers["fast_web_balancer"]["selector"] == ["VPS_"]
    assert restored_balancers["heavy_load_balancer"]["selector"] == ["VPS_"]


def test_refresh_subscription_only_preserves_manual_edits_after_activation(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    responses = iter(
        [
            (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
            (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
        ]
    )
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda _url: next(responses))

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "vless-reality", "protocol": "vless"},
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "rules": [
                        {
                            "type": "field",
                            "ruleTag": "pre_existing_proxy_rule",
                            "outboundTag": "vless-reality",
                            "domain": ["ext:geosite_v2fly.dat:openai"],
                        },
                        {
                            "type": "field",
                            "ruleTag": "pre_existing_direct",
                            "outboundTag": "direct",
                            "domain": ["domain:example.ru"],
                        },
                    ]
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"observatory": {"subjectSelector": ["vless-reality"]}}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "only-subscription",
            "tag": "subscription.example",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
            "routing_mode": "subscription-only",
        },
    )

    first = subs.refresh_subscription(
        str(ui_state_dir),
        "only-subscription",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )
    assert first["ok"] is True

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    routing["routing"]["rules"].insert(
        0,
        {
            "type": "field",
            "ruleTag": "manual_added_direct_after_subscription",
            "outboundTag": "direct",
            "domain": ["domain:manual-after.example"],
        },
    )
    routing["routing"]["rules"].insert(
        1,
        {
            "type": "field",
            "ruleTag": "manual_added_proxy_after_subscription",
            "outboundTag": "vless-reality",
            "ip": ["203.0.113.0/24"],
        },
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(routing, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    observatory["observatory"]["subjectSelector"].append("manual-added-after-subscription")
    (xray_dir / "07_observatory.json").write_text(
        json.dumps(observatory, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    second = subs.refresh_subscription(
        str(ui_state_dir),
        "only-subscription",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert second["ok"] is True

    final_routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    rules = final_routing["routing"]["rules"]
    manual_direct = next(rule for rule in rules if rule.get("ruleTag") == "manual_added_direct_after_subscription")
    manual_proxy = next(rule for rule in rules if rule.get("ruleTag") == "manual_added_proxy_after_subscription")
    assert manual_direct["outboundTag"] == "direct"
    assert manual_proxy["balancerTag"] == "proxy"
    assert "outboundTag" not in manual_proxy
    assert any(rule.get("ruleTag") == "pre_existing_direct" for rule in rules)
    assert any(rule.get("ruleTag") == "pre_existing_proxy_rule" for rule in rules)

    final_observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert final_observatory["observatory"]["subjectSelector"] == [
        "subscription.example",
        "manual-added-after-subscription",
    ]


@pytest.mark.parametrize(
    ("routing_mode", "tag_prefix"),
    [
        ("safe-fallback", "white_list"),
        ("migrate-vless-rules", "white_list"),
        ("subscription-only", "white_list"),
    ],
)
def test_subscription_refresh_preserves_mobile_scenario_after_switch(
    tmp_path: Path,
    monkeypatch,
    routing_mode: str,
    tag_prefix: str,
):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    responses = iter(
        [
            (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
            (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
        ]
    )
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda _url: next(responses))

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps({"routing": {"rules": []}}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"observatory": {"subjectSelector": []}}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "mobile-sub",
            "tag": tag_prefix,
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
            "routing_mode": routing_mode,
        },
    )
    first = subs.refresh_subscription(
        str(ui_state_dir),
        "mobile-sub",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )
    assert first["ok"] is True

    mobile_routing = {
        "routing": {
            "domainStrategy": "IPIfNonMatch",
            "balancers": [
                {
                    "tag": "balancer_main",
                    "selector": ["my_proxy"],
                    "strategy": {"type": "leastPing"},
                    "fallbackTag": "loopback_to_reserv",
                },
                {
                    "tag": "balancer_reserv",
                    "selector": ["reserve_proxy"],
                    "strategy": {"type": "leastPing"},
                    "fallbackTag": "loopback_to_white",
                },
                {
                    "tag": "balancer_white_list",
                    "selector": ["white_list"],
                    "strategy": {"type": "leastPing"},
                },
            ],
            "rules": [
                {
                    "type": "field",
                    "ruleTag": "xk_scenario_mobile_whitelist_direct_private",
                    "inboundTag": ["redirect", "tproxy", "socks-in"],
                    "outboundTag": "direct",
                    "ip": ["127.0.0.0/8"],
                },
                {
                    "type": "field",
                    "ruleTag": "manual_after_mobile_switch",
                    "outboundTag": "direct",
                    "domain": ["domain:manual-mobile.example"],
                },
                {
                    "type": "field",
                    "ruleTag": "xk_scenario_mobile_whitelist_blocked_domains_main",
                    "inboundTag": ["redirect", "tproxy"],
                    "balancerTag": "balancer_main",
                    "domain": ["ext:geosite_v2fly.dat:telegram"],
                },
                {
                    "type": "field",
                    "ruleTag": "xk_scenario_mobile_whitelist_default_direct",
                    "inboundTag": ["redirect", "tproxy"],
                    "outboundTag": "direct",
                    "network": "tcp,udp",
                },
                {
                    "type": "field",
                    "ruleTag": "xk_scenario_mobile_whitelist_fallback_from_main",
                    "inboundTag": ["from_balancer_main"],
                    "balancerTag": "balancer_reserv",
                    "network": "tcp,udp",
                },
                {
                    "type": "field",
                    "ruleTag": "xk_scenario_mobile_whitelist_fallback_from_reserve",
                    "inboundTag": ["from_balancer_reserv"],
                    "balancerTag": "balancer_white_list",
                    "network": "tcp,udp",
                },
            ],
        }
    }
    (xray_dir / "05_routing.json").write_text(
        json.dumps(mobile_routing, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps(
            {"observatory": {"subjectSelector": ["white_list", "manual-mobile-observer"]}},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    second = subs.refresh_subscription(
        str(ui_state_dir),
        "mobile-sub",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert second["ok"] is True
    assert second["routing_balancer_tag"] == ""
    assert second["routing_selector_count"] == 0

    final_routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = {item["tag"]: item for item in final_routing["routing"].get("balancers", [])}
    assert balancers["balancer_main"]["selector"] == ["my_proxy"]
    assert balancers["balancer_reserv"]["selector"] == ["reserve_proxy"]
    assert balancers["balancer_white_list"]["selector"] == ["white_list"]
    assert "proxy" not in balancers

    rules = final_routing["routing"]["rules"]
    assert any(rule.get("ruleTag") == "manual_after_mobile_switch" for rule in rules)
    assert all(rule.get("ruleTag") != "xk_auto_leastPing" for rule in rules)
    assert any(
        str(rule.get("ruleTag") or "").startswith("xk_scenario_mobile_whitelist_")
        for rule in rules
    )

    final_observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert final_observatory["observatory"]["subjectSelector"] == ["white_list", "manual-mobile-observer"]


def test_refresh_subscription_strict_mode_keeps_ru_direct_rules_before_migrated_pool_rule(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "vless-reality", "protocol": "vless"},
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "rules": [
                        {
                            "type": "field",
                            "ruleTag": "manual_direct_ru",
                            "domain": ["geosite:ru"],
                            "outboundTag": "direct",
                        },
                        {
                            "type": "field",
                            "domain": ["ext:geosite_v2fly.dat:openai"],
                            "outboundTag": "vless-reality",
                        },
                        {
                            "type": "field",
                            "outboundTag": "direct",
                        },
                    ]
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "ru-direct-strict",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_mode": "migrate-vless-rules",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "ru-direct-strict",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_mode"] == "migrate-vless-rules"
    assert result["routing_migrated_rules"] == 1

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    rules = routing["routing"]["rules"]
    assert rules[0]["ruleTag"] == "manual_direct_ru"
    assert rules[0]["outboundTag"] == "direct"
    assert rules[1]["ruleTag"].startswith("xk_auto_vless_pool_")
    assert rules[1]["balancerTag"] == "proxy"
    assert rules[2]["ruleTag"] == "xk_auto_leastPing"
    assert rules[3]["outboundTag"] == "direct"


def test_refresh_subscription_preserves_user_routing_jsonc_comments(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "vless-reality", "protocol": "vless"},
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    routing_obj = {
        "routing": {
            "rules": [
                {
                    "type": "field",
                    "inboundTag": ["redirect", "tproxy"],
                    "outboundTag": "vless-reality",
                    "domain": ["ext:geosite_v2fly.dat:openai"],
                },
                {
                    "type": "field",
                    "inboundTag": ["redirect", "tproxy"],
                    "outboundTag": "direct",
                },
            ]
        }
    }
    (xray_dir / "05_routing.json").write_text(
        json.dumps(routing_obj, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    raw_path = jsonc_dir / "05_routing.jsonc"
    raw_path.write_text(
        "\n".join(
            [
                "// User file header must survive subscription sync",
                "{",
                '  "routing": {',
                "    // User rules section comment",
                '    "rules": [',
                "      // User vless-reality rule comment",
                "      {",
                '        "type": "field",',
                '        "inboundTag": ["redirect", "tproxy"],',
                '        "outboundTag": "vless-reality",',
                '        "domain": ["ext:geosite_v2fly.dat:openai"]',
                "      },",
                "      // User direct fallback rule comment",
                "      {",
                '        "type": "field",',
                '        "inboundTag": ["redirect", "tproxy"],',
                '        "outboundTag": "direct"',
                "      }",
                "    ]",
                "  }",
                "}",
                "",
            ]
        ),
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "comment-route",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "comment-route",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    assert result["routing_changed"] is True
    raw_after = raw_path.read_text(encoding="utf-8")
    assert raw_after.count("Generated by XKeen UI subscriptions") == 1
    assert "User file header must survive subscription sync" in raw_after
    assert "User rules section comment" in raw_after
    assert "User vless-reality rule comment" in raw_after
    assert "User direct fallback rule comment" in raw_after
    assert "xk_auto_leastPing" in raw_after
    json.loads(subs._strip_jsonc_comments(raw_after))


def test_due_refresh_preserves_commented_main_routing_jsonc(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    routing_jsonc = "\n".join(
        [
            "{",
            '  "routing": {',
            '    "domainStrategy": "IPIfNonMatch",',
            '    "rules": [',
            "      // 1. LOCAL NETWORKS AND RESERVES",
            "      {",
            '        "type": "field",',
            '        "inboundTag": ["redirect", "tproxy", "socks-in", "from_balancer_main"],',
            '        "outboundTag": "direct",',
            '        "ip": ["127.0.0.0/8", "10.0.0.0/8"]',
            "      },",
            "      // 8. BLOCKED DOMAINS -> balancer_main",
            "      {",
            '        "type": "field",',
            '        "inboundTag": ["redirect", "tproxy", "socks-in"],',
            '        "balancerTag": "balancer_main",',
            '        "domain": ["ext:geosite_v2fly.dat:telegram"]',
            "      },",
            "      // 10. DEFAULT DIRECT",
            "      {",
            '        "type": "field",',
            '        "inboundTag": ["redirect", "tproxy", "socks-in"],',
            '        "outboundTag": "direct",',
            '        "network": "tcp,udp"',
            "      },",
            "      // 11. FALLBACK FROM MAIN",
            "      {",
            '        "type": "field",',
            '        "inboundTag": ["from_balancer_main"],',
            '        "balancerTag": "balancer_reserv",',
            '        "network": "tcp,udp"',
            "      }",
            "    ],",
            '    "balancers": [',
            "      // Level 1: main balancer",
            "      {",
            '        "tag": "balancer_main",',
            '        "selector": ["my_proxy"],',
            '        "strategy": {"type": "leastPing"},',
            '        "fallbackTag": "loopback_to_reserv"',
            "      },",
            "      // Level 2: reserve balancer",
            "      {",
            '        "tag": "balancer_reserv",',
            '        "selector": ["reserve_proxy"],',
            '        "strategy": {"type": "leastPing"},',
            '        "fallbackTag": "loopback_to_white"',
            "      },",
            "      // Level 3: white-list balancer",
            "      {",
            '        "tag": "balancer_white_list",',
            '        "selector": ["white_list"],',
            '        "strategy": {"type": "leastPing"}',
            "      }",
            "    ]",
            "  }",
            "}",
            "",
        ]
    )
    expected_before = json.loads(subs._strip_jsonc_comments(routing_jsonc))
    (xray_dir / "05_routing.json").write_text(routing_jsonc, encoding="utf-8")

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "commented-main-routing",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
            "routing_mode": "safe-fallback",
        },
    )
    state = subs.load_subscription_state(str(ui_state_dir))
    state["subscriptions"][0]["next_update_ts"] = 0
    subs._write_state(str(ui_state_dir), state)

    results = subs.refresh_due_subscriptions(
        str(ui_state_dir),
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert len(results) == 1
    assert results[0]["ok"] is True
    assert results[0]["routing_changed"] is True

    final = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    final_rules = final["routing"]["rules"]
    final_balancers = {item["tag"]: item for item in final["routing"]["balancers"]}

    for rule in expected_before["routing"]["rules"]:
        assert any(candidate == rule for candidate in final_rules)
    assert len(final_rules) == len(expected_before["routing"]["rules"]) + 1
    assert any(rule.get("ruleTag") == "xk_auto_leastPing" for rule in final_rules)

    assert final["routing"]["domainStrategy"] == "IPIfNonMatch"
    assert final_balancers["balancer_main"]["selector"] == ["my_proxy"]
    assert final_balancers["balancer_reserv"]["selector"] == ["reserve_proxy"]
    assert final_balancers["balancer_white_list"]["selector"] == ["white_list"]
    assert final_balancers["proxy"]["selector"] == ["cdn.pecan.run"]

    raw_after = (jsonc_dir / "05_routing.jsonc").read_text(encoding="utf-8")
    assert "Generated by XKeen UI subscriptions" in raw_after
    assert "LOCAL NETWORKS AND RESERVES" in raw_after
    assert "Level 2: reserve balancer" in raw_after
    json.loads(subs._strip_jsonc_comments(raw_after))


def test_due_refresh_does_not_overwrite_invalid_routing_file(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps({"outbounds": [{"tag": "direct", "protocol": "freedom"}]}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    broken_routing = '{\n  "routing": {\n    "rules": [\n'
    (xray_dir / "05_routing.json").write_text(broken_routing, encoding="utf-8")

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "invalid-routing",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
        },
    )
    state = subs.load_subscription_state(str(ui_state_dir))
    state["subscriptions"][0]["next_update_ts"] = 0
    subs._write_state(str(ui_state_dir), state)

    results = subs.refresh_due_subscriptions(
        str(ui_state_dir),
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert len(results) == 1
    assert results[0]["ok"] is False
    assert "05_routing.json is not valid JSON/JSONC" in results[0]["error"]
    assert (xray_dir / "05_routing.json").read_text(encoding="utf-8") == broken_routing
    assert not (jsonc_dir / "05_routing.jsonc").exists()


def test_refresh_subscription_strict_mode_migrates_and_reverts_vless_rules(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {
                        "tag": "vless-reality",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "edge.example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                    },
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "rules": [
                        {
                            "type": "field",
                            "inboundTag": ["redirect", "tproxy"],
                            "outboundTag": "vless-reality",
                            "domain": ["ext:geosite_v2fly.dat:openai"],
                        },
                        {
                            "type": "field",
                            "inboundTag": ["redirect", "tproxy"],
                            "outboundTag": "direct",
                        },
                    ]
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "strict-route",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_mode": "migrate-vless-rules",
        },
    )

    strict = subs.refresh_subscription(
        str(ui_state_dir),
        "strict-route",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert strict["ok"] is True
    assert strict["routing_mode"] == "migrate-vless-rules"
    assert strict["routing_migrated_rules"] == 1

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    rules = routing["routing"]["rules"]
    assert rules[0]["balancerTag"] == "proxy"
    assert rules[0]["ruleTag"].startswith("xk_auto_vless_pool_")
    assert "outboundTag" not in rules[0]
    assert rules[1]["ruleTag"] == "xk_auto_leastPing"
    assert rules[2]["outboundTag"] == "direct"

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "strict-route",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_mode": "safe-fallback",
        },
    )

    safe = subs.refresh_subscription(
        str(ui_state_dir),
        "strict-route",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert safe["ok"] is True
    assert safe["routing_mode"] == "safe-fallback"
    assert safe["routing_reverted_rules"] == 1

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    rules = routing["routing"]["rules"]
    assert rules[0]["outboundTag"] == "vless-reality"
    assert "balancerTag" not in rules[0]
    assert "ruleTag" not in rules[0]
    assert rules[1]["ruleTag"] == "xk_auto_leastPing"
    assert rules[2]["outboundTag"] == "direct"


def test_delete_last_subscription_restores_pre_subscription_runtime_state(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {
                        "tag": "vless-reality",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "edge.example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                    },
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    routing_before = (
        json.dumps(
            {
                "routing": {
                    "domainStrategy": "AsIs",
                    "rules": [{"type": "field", "inboundTag": ["redirect", "tproxy"], "outboundTag": "direct"}],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    observatory_before = (
        json.dumps(
            {
                "observatory": {
                    "subjectSelector": ["vless-reality"],
                    "probeUrl": "https://probe.example.com",
                    "probeInterval": "120s",
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    routing_jsonc_before = "\n".join(
        [
            "// user routing header",
            "{",
            '  "routing": {',
            '    "domainStrategy": "AsIs",',
            "    // keep this rule comment",
            '    "rules": [',
            "      {",
            '        "type": "field",',
            '        "inboundTag": ["redirect", "tproxy"],',
            '        "outboundTag": "direct"',
            "      }",
            "    ]",
            "  }",
            "}",
            "",
        ]
    )
    observatory_jsonc_before = "\n".join(
        [
            "// user observatory header",
            "{",
            '  "observatory": {',
            '    "subjectSelector": ["vless-reality"],',
            '    "probeUrl": "https://probe.example.com",',
            '    "probeInterval": "120s"',
            "  }",
            "}",
            "",
        ]
    )
    (xray_dir / "05_routing.json").write_text(routing_before, encoding="utf-8")
    (xray_dir / "07_observatory.json").write_text(observatory_before, encoding="utf-8")
    (jsonc_dir / "05_routing.jsonc").write_text(routing_jsonc_before, encoding="utf-8")
    (jsonc_dir / "07_observatory.jsonc").write_text(observatory_jsonc_before, encoding="utf-8")

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "auto-route",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
        },
    )
    subs.refresh_subscription(
        str(ui_state_dir),
        "auto-route",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    result = subs.delete_subscription(
        str(ui_state_dir),
        "auto-route",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        remove_file=True,
        restart_xkeen=None,
    )

    assert result["routing_changed"] is True
    assert result["baseline_restored"] is False
    assert not (xray_dir / "04_outbounds.auto-route.json").exists()
    assert not (jsonc_dir / "04_outbounds.auto-route.jsonc").exists()
    assert (xray_dir / "05_routing.json").read_text(encoding="utf-8") == routing_before
    assert (xray_dir / "07_observatory.json").read_text(encoding="utf-8") == observatory_before
    routing_jsonc_after = (jsonc_dir / "05_routing.jsonc").read_text(encoding="utf-8")
    observatory_jsonc_after = (jsonc_dir / "07_observatory.jsonc").read_text(encoding="utf-8")
    assert "Generated by XKeen UI subscriptions" not in routing_jsonc_after
    assert "Generated by XKeen UI subscriptions" not in observatory_jsonc_after
    assert "// user routing header" in routing_jsonc_after
    assert "// keep this rule comment" in routing_jsonc_after
    assert "// user observatory header" in observatory_jsonc_after
    assert json.loads(subs._strip_jsonc_comments(routing_jsonc_after)) == json.loads(routing_before)
    assert json.loads(subs._strip_jsonc_comments(observatory_jsonc_after)) == json.loads(observatory_before)

    state = subs.load_subscription_state(str(ui_state_dir))
    assert subs.MANAGED_BASELINES_KEY not in state


def test_delete_subscription_only_restores_manual_observatory_selector(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    routing_before = (
        json.dumps(
            {
                "routing": {
                    "balancers": [
                        {
                            "tag": "proxy",
                            "selector": ["vless-reality"],
                            "fallbackTag": "direct",
                            "strategy": {"type": "leastPing"},
                        }
                    ],
                    "rules": [
                        {
                            "type": "field",
                            "inboundTag": ["redirect", "tproxy"],
                            "balancerTag": "proxy",
                        }
                    ],
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    observatory_before = (
        json.dumps(
            {
                "observatory": {
                    "subjectSelector": ["vless-reality"],
                    "probeUrl": "https://probe.example.com",
                    "probeInterval": "120s",
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    (xray_dir / "05_routing.json").write_text(routing_before, encoding="utf-8")
    (xray_dir / "07_observatory.json").write_text(observatory_before, encoding="utf-8")

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "subscription-only",
            "tag": "subscription.example",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_mode": "subscription-only",
        },
    )
    refreshed = subs.refresh_subscription(
        str(ui_state_dir),
        "subscription-only",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert refreshed["ok"] is True
    observatory_active = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory_active["observatory"]["subjectSelector"] == ["subscription.example"]
    routing_active = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    active_balancers = routing_active["routing"]["balancers"]
    assert any(item.get("selector") == ["subscription.example"] for item in active_balancers)

    deleted = subs.delete_subscription(
        str(ui_state_dir),
        "subscription-only",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        remove_file=True,
        restart_xkeen=None,
    )

    assert deleted["baseline_restored"] is True
    assert (xray_dir / "05_routing.json").read_text(encoding="utf-8") == routing_before
    assert (xray_dir / "07_observatory.json").read_text(encoding="utf-8") == observatory_before
    state = subs.load_subscription_state(str(ui_state_dir))
    assert subs.MANAGED_BASELINES_KEY not in state


def test_refresh_subscription_preserves_cp1251_custom_routing_variant_and_restores_on_delete(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs
    from utils.fs import load_text

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(subs, "ROUTING_FILE", "05_routing-2.json")
    monkeypatch.setattr(
        subs,
        "MANAGED_BASELINE_TARGETS",
        {**subs.MANAGED_BASELINE_TARGETS, subs.MANAGED_BASELINE_ROUTING_KEY: "05_routing-2.json"},
    )
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("WS Germany", "ws", host="ws.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    routing_before = {
        "routing": {
            "domainStrategy": "IPIfNonMatch",
            "balancers": [
                {
                    "tag": "fast_web_balancer",
                    "selector": ["VPS_"],
                    "fallbackTag": "direct",
                    "strategy": {"type": "leastPing"},
                }
            ],
            "rules": [
                {
                    "type": "field",
                    "ruleTag": "manual_direct_ru",
                    "domain": ["domain:пример.рф"],
                    "outboundTag": "direct",
                }
            ],
        }
    }
    (xray_dir / "05_routing-2.json").write_text(
        json.dumps(routing_before, ensure_ascii=False, indent=2) + "\n",
        encoding="cp1251",
    )
    observatory_before = json.dumps({"observatory": {"subjectSelector": ["VPS_"]}}, ensure_ascii=False, indent=2) + "\n"
    (xray_dir / "07_observatory.json").write_text(observatory_before, encoding="utf-8")

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "legacy-routing",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
        },
    )

    refreshed = subs.refresh_subscription(
        str(ui_state_dir),
        "legacy-routing",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert refreshed["ok"] is True
    assert refreshed["routing_changed"] is True
    assert refreshed["routing_file"] == "05_routing-2.json"
    assert not (xray_dir / "05_routing.json").exists()

    routing_after = json.loads((xray_dir / "05_routing-2.json").read_text(encoding="utf-8"))
    assert routing_after["routing"]["domainStrategy"] == "IPIfNonMatch"
    assert routing_after["routing"]["balancers"][0]["tag"] == "fast_web_balancer"
    rules = routing_after["routing"]["rules"]
    assert rules[0]["ruleTag"] == "manual_direct_ru"
    assert any(rule.get("ruleTag") == "xk_auto_leastPing" for rule in rules)

    state = subs.load_subscription_state(str(ui_state_dir))
    baseline = state[subs.MANAGED_BASELINES_KEY]["routing"]
    assert baseline["path"] == "05_routing-2.json"
    assert baseline["exists"] is True
    assert "пример.рф" in baseline["text"]

    deleted = subs.delete_subscription(
        str(ui_state_dir),
        "legacy-routing",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        remove_file=True,
        restart_xkeen=None,
    )

    assert deleted["baseline_restored"] is False
    restored = json.loads(load_text(str(xray_dir / "05_routing-2.json"), default=""))
    assert restored == routing_before


def test_delete_subscription_removes_empty_generated_balancer(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("gRPC Russia", "grpc", host="ru.example.com"), {}),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps({"routing": {"rules": []}}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "auto-route",
            "tag": "cdn.pecan.run",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
        },
    )
    refreshed = subs.refresh_subscription(
        str(ui_state_dir),
        "auto-route",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )
    assert refreshed["routing_changed"] is True
    assert refreshed["routing_selector_count"] == 1

    result = subs.delete_subscription(
        str(ui_state_dir),
        "auto-route",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        remove_file=True,
        restart_xkeen=None,
    )

    assert result["routing_changed"] is True
    assert result["baseline_restored"] is False
    routing_text = (xray_dir / "05_routing.json").read_text(encoding="utf-8")
    assert "cdn.pecan.run" not in routing_text
    routing = json.loads(routing_text)
    assert routing["routing"]["rules"] == []
    assert "balancers" not in routing["routing"]
    assert not (xray_dir / "04_outbounds.auto-route.json").exists()
    assert not (jsonc_dir / "04_outbounds.auto-route.jsonc").exists()


def test_delete_subscription_rebuilds_runtime_from_baseline_for_remaining_subscriptions(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    def _fetch(url: str):
        if url.endswith("/a"):
            return (_vless_transport("WS Germany", "ws", host="ws.example.com"), {})
        return (_vless_transport("TCP Sweden", "tcp", host="tcp.example.com"), {})

    monkeypatch.setattr(subs, "fetch_subscription_body", _fetch)

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    routing_before = json.dumps({"routing": {"rules": []}}, ensure_ascii=False, indent=2) + "\n"
    observatory_before = json.dumps({"observatory": {"subjectSelector": []}}, ensure_ascii=False, indent=2) + "\n"
    (xray_dir / "05_routing.json").write_text(routing_before, encoding="utf-8")
    (xray_dir / "07_observatory.json").write_text(observatory_before, encoding="utf-8")

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "alpha",
            "tag": "alpha",
            "url": "https://example.com/a",
            "enabled": True,
            "ping_enabled": True,
        },
    )
    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "beta",
            "tag": "beta",
            "url": "https://example.com/b",
            "enabled": True,
            "ping_enabled": True,
        },
    )

    first = subs.refresh_subscription(
        str(ui_state_dir),
        "alpha",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )
    second = subs.refresh_subscription(
        str(ui_state_dir),
        "beta",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert first["ok"] is True
    assert second["ok"] is True

    backup_dir = xray_dir / "backups"
    backup_dir.mkdir()
    for name in (
        "04_outbounds.alpha.json",
        "04_outbounds.alpha.jsonc",
        "05_routing.json",
        "05_routing.jsonc",
        "07_observatory.json",
        "07_observatory.jsonc",
    ):
        (backup_dir / name).write_text("stale subscription snapshot\n", encoding="utf-8")
    history_backup = backup_dir / "05_routing-20260525-120000.json"
    history_backup.write_text("history backup must stay\n", encoding="utf-8")

    result = subs.delete_subscription(
        str(ui_state_dir),
        "alpha",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        remove_file=True,
        restart_xkeen=None,
    )

    assert result["baseline_restored"] is False
    assert result["routing_changed"] is True
    assert result["observatory_changed"] is True
    assert not (xray_dir / "04_outbounds.alpha.json").exists()
    assert not (jsonc_dir / "04_outbounds.alpha.jsonc").exists()
    assert set(result["snapshots_removed"]) == {
        "04_outbounds.alpha.json",
        "04_outbounds.alpha.jsonc",
        "05_routing.json",
        "05_routing.jsonc",
        "07_observatory.json",
        "07_observatory.jsonc",
    }
    assert not any((backup_dir / name).exists() for name in result["snapshots_removed"])
    assert history_backup.exists()

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["beta"]

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    balancers = routing["routing"]["balancers"]
    assert len(balancers) == 1
    assert balancers[0]["selector"] == ["beta"]
    rules = routing["routing"]["rules"]
    assert rules[0]["ruleTag"] == "xk_auto_leastPing"
    assert rules[0]["balancerTag"] == "proxy"

    state = subs.load_subscription_state(str(ui_state_dir))
    assert "managed_baselines" in state


def test_delete_subscription_keeps_unrelated_outbound_fragments(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda _url: (_vless("Alpha"), {}))

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps({"outbounds": [{"tag": "direct", "protocol": "freedom"}]}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps({"routing": {"rules": []}}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"observatory": {"subjectSelector": []}}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    manual_fragments = {
        "04_outbounds.single.json": {"outbounds": [{"tag": "single-user", "protocol": "vless"}]},
        "04_outbounds_All.json": {"outbounds": [{"tag": "pool-user", "protocol": "vless"}]},
        "04_outbounds.other-sub.json": {"outbounds": [{"tag": "other-sub", "protocol": "vless"}]},
    }
    for name, payload in manual_fragments.items():
        (xray_dir / name).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "alpha",
            "tag": "alpha",
            "url": "https://example.com/a",
            "enabled": True,
            "ping_enabled": False,
        },
    )
    refreshed = subs.refresh_subscription(
        str(ui_state_dir),
        "alpha",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )
    assert refreshed["ok"] is True
    assert (xray_dir / "04_outbounds.alpha.json").exists()

    deleted = subs.delete_subscription(
        str(ui_state_dir),
        "alpha",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        remove_file=True,
        restart_xkeen=None,
    )

    assert deleted["output_removed"] is True
    assert not (xray_dir / "04_outbounds.alpha.json").exists()
    for name, payload in manual_fragments.items():
        assert json.loads((xray_dir / name).read_text(encoding="utf-8")) == payload


def test_refresh_subscription_preserves_manual_routing_and_observatory_edits_after_activation(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (
            "\n".join(
                [
                    _vless_transport("WS Germany", "ws", host="ws.example.com"),
                    _trojan("Trojan Sweden"),
                ]
            ),
            {},
        ),
    )

    (xray_dir / "04_outbounds.json").write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "manual-base-proxy", "protocol": "socks"},
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(
            {
                "routing": {
                    "rules": [
                        {
                            "type": "field",
                            "ruleTag": "pre_existing_direct",
                            "outboundTag": "direct",
                            "domain": ["domain:example.ru"],
                        }
                    ]
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"observatory": {"subjectSelector": ["manual-base-proxy"]}}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "demo-sub",
            "tag": "demo",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": True,
            "routing_auto_rule": True,
            "routing_mode": "safe-fallback",
        },
    )

    first = subs.refresh_subscription(
        str(ui_state_dir),
        "demo-sub",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert first["ok"] is True

    generated_path = xray_dir / "04_outbounds.demo-sub.json"
    generated = json.loads(generated_path.read_text(encoding="utf-8"))
    generated["outbounds"].append({"tag": "manual-added-inside-generated", "protocol": "http"})
    generated_path.write_text(json.dumps(generated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    routing["routing"]["rules"].insert(
        0,
        {
            "type": "field",
            "ruleTag": "manual_added_after_subscription",
            "outboundTag": "direct",
            "domain": ["domain:added-after-subscription.ru"],
        },
    )
    routing["routing"].setdefault("balancers", []).append(
        {
            "tag": "user_added_after_subscription",
            "selector": ["MANUAL_"],
            "strategy": {"type": "leastPing"},
            "fallbackTag": "direct",
        }
    )
    (xray_dir / "05_routing.json").write_text(
        json.dumps(routing, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    observatory["observatory"]["subjectSelector"].append("manual-added-after-subscription")
    (xray_dir / "07_observatory.json").write_text(
        json.dumps(observatory, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    second = subs.refresh_subscription(
        str(ui_state_dir),
        "demo-sub",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert second["ok"] is True

    final_generated = json.loads(generated_path.read_text(encoding="utf-8"))
    assert all(item.get("tag") != "manual-added-inside-generated" for item in final_generated["outbounds"])

    final_routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    rules = final_routing["routing"]["rules"]
    assert any(rule.get("ruleTag") == "manual_added_after_subscription" for rule in rules)
    assert any(rule.get("ruleTag") == "pre_existing_direct" for rule in rules)
    assert any(rule.get("ruleTag") == "xk_auto_leastPing" for rule in rules)
    assert any(
        balancer.get("tag") == "user_added_after_subscription"
        for balancer in final_routing["routing"].get("balancers", [])
    )

    final_observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert "manual-base-proxy" in final_observatory["observatory"]["subjectSelector"]
    assert "demo" in final_observatory["observatory"]["subjectSelector"]
    assert "manual-added-after-subscription" in final_observatory["observatory"]["subjectSelector"]


def test_refresh_subscription_applies_name_and_type_filters_to_links(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (
            "\n".join(
                [
                    _vless("Germany-01"),
                    _trojan("Sweden-02"),
                    _vless("Netherlands-03"),
                ]
            ),
            {},
        ),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "filtered",
            "tag": "flt",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
            "name_filter": "Germany|Netherlands",
            "type_filter": "vless",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "filtered",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    assert result["count"] == 2
    assert result["source_count"] == 3
    assert result["filtered_out_count"] == 1
    assert result["tags"] == ["flt--Germany-01", "flt--Netherlands-03"]

    generated = json.loads((xray_dir / "04_outbounds.filtered.json").read_text(encoding="utf-8"))
    assert [item["tag"] for item in generated["outbounds"]] == ["flt--Germany-01", "flt--Netherlands-03"]

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["name_filter"] == "Germany|Netherlands"
    assert saved["type_filter"] == "vless"
    assert saved["last_source_count"] == 3
    assert saved["last_filtered_out_count"] == 1


def test_build_subscription_outbounds_applies_transport_filter_and_manual_exclusions():
    from services import xray_subscriptions as subs

    links = [
        _vless_transport("Germany WS", "ws"),
        _vless_transport("Sweden GRPC", "grpc"),
        _vless_transport("Netherlands TCP", "tcp"),
    ]

    outbounds, errors, stats = subs.build_subscription_outbounds(
        links,
        tag_prefix="flt",
        transport_filter="ws|grpc",
    )

    assert errors == []
    assert [item["tag"] for item in outbounds] == ["flt--Germany_WS", "flt--Sweden_GRPC"]
    assert stats["source_count"] == 3
    assert stats["filtered_out_count"] == 1
    assert [item["transport"] for item in stats["nodes"]] == ["ws", "grpc", "tcp"]

    grpc_key = next(item["key"] for item in stats["nodes"] if item["transport"] == "grpc")
    outbounds, errors, stats = subs.build_subscription_outbounds(
        links,
        tag_prefix="flt",
        transport_filter="ws|grpc",
        excluded_node_keys=[grpc_key],
    )

    assert errors == []
    assert [item["tag"] for item in outbounds] == ["flt--Germany_WS"]
    assert stats["source_count"] == 3
    assert stats["filtered_out_count"] == 2


def test_refresh_subscription_keeps_curated_manual_selection_closed_to_new_nodes(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    def _node(name: str, host: str) -> dict:
        return {
            "remarks": name,
            "outbounds": [
                {
                    "tag": "proxy",
                    "protocol": "vless",
                    "settings": {
                        "vnext": [
                            {
                                "address": host,
                                "port": 443,
                                "users": [{"id": "user", "encryption": "none"}],
                            }
                        ]
                    },
                    "streamSettings": {
                        "network": "xhttp",
                        "security": "tls",
                        "xhttpSettings": {"path": "/api/v2/"},
                    },
                }
            ],
        }

    initial_body = json.dumps(
        [
            _node("Anti White A", "10.0.0.1"),
            _node("Anti White B", "10.0.0.2"),
            _node("FREE Chat 1", "10.0.1.1"),
            _node("FREE Chat 2", "10.0.1.2"),
            _node("FREE Chat 3", "10.0.1.3"),
        ]
    )
    refreshed_body = json.dumps(
        [
            _node("Anti White A", "10.0.0.1"),
            _node("Anti White B", "10.0.0.2"),
            _node("FREE Chat 1", "10.0.1.1"),
            _node("FREE Chat 2", "10.0.1.2"),
            _node("FREE Chat 3", "10.0.1.3"),
            _node("FREE WhatsApp & Telegram", "10.0.1.4"),
        ]
    )

    responses = iter([(initial_body, {}), (initial_body, {}), (refreshed_body, {})])
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda _url: next(responses))
    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    preview = subs.preview_subscription(
        {
            "url": "https://example.com/json",
            "tag": "pecan",
            "transport_filter": "xhttp",
        }
    )
    excluded_keys = [
        item["key"]
        for item in preview["nodes"]
        if not str(item["name"]).startswith("Anti White")
    ]

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "pecan",
            "name": "Pecan curated",
            "tag": "pecan",
            "url": "https://example.com/json",
            "enabled": True,
            "ping_enabled": False,
            "transport_filter": "xhttp",
            "excluded_node_keys": excluded_keys,
        },
    )

    first = subs.refresh_subscription(
        str(ui_state_dir),
        "pecan",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert first["ok"] is True
    assert first["manual_exclusions_added"] == 0
    assert [item["tag"] for item in json.loads((xray_dir / "04_outbounds.pecan.json").read_text(encoding="utf-8"))["outbounds"]] == [
        "pecan--Anti_White_A",
        "pecan--Anti_White_B",
    ]

    second = subs.refresh_subscription(
        str(ui_state_dir),
        "pecan",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert second["ok"] is True
    assert second["manual_exclusions_added"] == 1
    assert second["source_count"] == 6
    assert second["filtered_out_count"] == 4
    assert [item["tag"] for item in json.loads((xray_dir / "04_outbounds.pecan.json").read_text(encoding="utf-8"))["outbounds"]] == [
        "pecan--Anti_White_A",
        "pecan--Anti_White_B",
    ]

    saved = subs.load_subscription_state(str(ui_state_dir))["subscriptions"][0]
    assert len(saved["excluded_node_keys"]) == 4
    free_node = next(item for item in saved["last_nodes"] if item["name"] == "FREE WhatsApp & Telegram")
    assert free_node.get("tag") in ("", None)


def test_build_subscription_json_outbounds_keeps_distinct_keys_for_same_config_with_different_names():
    from services import xray_subscriptions as subs

    shared_outbound = {
        "tag": "proxy",
        "protocol": "vless",
        "settings": {
            "vnext": [
                {
                    "address": "103.88.240.173",
                    "port": 443,
                    "users": [{"id": "user", "encryption": "none"}],
                }
            ]
        },
        "streamSettings": {
            "network": "xhttp",
            "security": "tls",
            "xhttpSettings": {"path": "/api/v2/"},
        },
    }
    body = json.dumps(
        [
            {"remarks": "SE-YYY-Sweden.e026", "outbounds": [shared_outbound]},
            {"remarks": "RU-Anti-06.e026", "outbounds": [shared_outbound]},
        ]
    )

    outbounds, errors, stats = subs.build_subscription_json_outbounds(
        body,
        tag_prefix="flt",
    )

    assert errors == []
    assert [item["tag"] for item in outbounds] == ["flt--SE-YYY-Sweden.e026", "flt--RU-Anti-06.e026"]
    assert stats["source_count"] == 2
    assert stats["filtered_out_count"] == 0

    keys = [item["key"] for item in stats["nodes"]]
    assert len(keys) == 2
    assert len(set(keys)) == 2

    sweden_key = next(item["key"] for item in stats["nodes"] if item["name"] == "SE-YYY-Sweden.e026")
    outbounds, errors, stats = subs.build_subscription_json_outbounds(
        body,
        tag_prefix="flt",
        excluded_node_keys=[sweden_key],
    )

    assert errors == []
    assert [item["tag"] for item in outbounds] == ["flt--RU-Anti-06.e026"]
    assert stats["source_count"] == 2
    assert stats["filtered_out_count"] == 1


def test_refresh_subscription_keeps_long_provider_prefix_in_runtime_selectors(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (
            "\n".join(
                [
                    _vless_transport("VLESS-REALITY-US-Keenetic-Digus", "tcp"),
                    _vless_transport("VLESS-XHTTP-US-Keenetic-Digus-X", "xhttp"),
                ]
            ),
            {},
        ),
    )

    url = "https://cp.landing-us.rfid-technologies.org/LVCtszWBwo/w1n2j520ym5xq0ca"
    sub = subs.upsert_subscription(
        str(ui_state_dir),
        {
            "url": url,
            "enabled": True,
            "ping_enabled": True,
        },
    )

    assert sub["id"] == "cp.landing-us.rfid-technologies.org"
    assert sub["tag"] == "cp.landing-us.rfid-technologies.org"

    result = subs.refresh_subscription(
        str(ui_state_dir),
        sub["id"],
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is True
    generated = json.loads((xray_dir / result["output_file"]).read_text(encoding="utf-8"))
    tags = [item["tag"] for item in generated["outbounds"]]
    assert tags == [
        "cp.landing-us.rfid-technologies.org--VLESS-REALITY-US-Keenetic-Digus",
        "cp.landing-us.rfid-technologies.org--VLESS-XHTTP-US-Keenetic-Digus-X",
    ]

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["cp.landing-us.rfid-technologies.org"]

    routing = json.loads((xray_dir / "05_routing.json").read_text(encoding="utf-8"))
    assert routing["routing"]["balancers"][0]["selector"] == ["cp.landing-us.rfid-technologies.org"]

    state = subs.load_subscription_state(str(ui_state_dir))
    assert state["subscriptions"][0]["last_selector_terms"] == ["cp.landing-us.rfid-technologies.org"]


def test_build_subscription_outbounds_shrinks_extreme_prefix_to_preserve_node_name():
    from services import xray_subscriptions as subs

    long_prefix = "provider-" + ("very-long-" * 14)
    node_name = "VLESS-XHTTP-US-Keenetic-Dnepr-16k3"
    outbounds, errors, stats = subs.build_subscription_outbounds(
        [_vless_transport(node_name, "xhttp")],
        tag_prefix=long_prefix,
    )

    assert errors == []
    assert len(outbounds) == 1
    tag = outbounds[0]["tag"]
    assert len(tag) <= subs._TAG_MAX_LEN
    assert tag.endswith("--" + node_name)
    assert long_prefix.startswith(tag.split("--", 1)[0])
    assert stats["nodes"][0]["tag"] == tag


def test_refresh_subscription_persists_preview_exclusions_and_applies_saved_exclusion_edits(
    tmp_path: Path,
    monkeypatch,
):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    shared_outbound = {
        "tag": "proxy",
        "protocol": "vless",
        "settings": {
            "vnext": [
                {
                    "address": "103.88.240.173",
                    "port": 443,
                    "users": [{"id": "user", "encryption": "none"}],
                }
            ]
        },
        "streamSettings": {
            "network": "xhttp",
            "security": "tls",
            "xhttpSettings": {"path": "/api/v2/"},
        },
    }
    germany_outbound = {
        "tag": "proxy",
        "protocol": "trojan",
        "settings": {
            "servers": [{"address": "198.51.100.10", "port": 443, "password": "secret"}]
        },
        "streamSettings": {"network": "tcp", "security": "tls"},
    }
    subscription_body = json.dumps(
        [
            {"remarks": "SE-YYY-Sweden.e026", "outbounds": [shared_outbound]},
            {"remarks": "RU-Anti-06.e026", "outbounds": [shared_outbound]},
            {"remarks": "DE-Germany.0005", "outbounds": [germany_outbound]},
        ]
    )
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (subscription_body, {"content-type": "application/json"}),
    )

    preview = subs.preview_subscription({"url": "https://example.com/json", "tag": "flt"})
    sweden_key = next(item["key"] for item in preview["nodes"] if item["name"] == "SE-YYY-Sweden.e026")
    russia_key = next(item["key"] for item in preview["nodes"] if item["name"] == "RU-Anti-06.e026")

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "json-edit",
            "name": "JSON Edit",
            "tag": "flt",
            "url": "https://example.com/json",
            "enabled": True,
            "ping_enabled": True,
            "excluded_node_keys": [russia_key],
        },
    )

    first = subs.refresh_subscription(
        str(ui_state_dir),
        "json-edit",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert first["ok"] is True
    assert first["filtered_out_count"] == 1
    assert [item["tag"] for item in json.loads((xray_dir / "04_outbounds.json-edit.json").read_text(encoding="utf-8"))["outbounds"]] == [
        "flt--SE-YYY-Sweden.e026",
        "flt--DE-Germany.0005",
    ]

    saved = subs.load_subscription_state(str(ui_state_dir))["subscriptions"][0]
    assert saved["excluded_node_keys"] == [russia_key]
    assert {item["name"] for item in saved["last_nodes"] if item.get("tag")} == {
        "SE-YYY-Sweden.e026",
        "DE-Germany.0005",
    }

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "json-edit",
            "name": "JSON Edit",
            "tag": "flt",
            "url": "https://example.com/json",
            "enabled": True,
            "ping_enabled": True,
            "excluded_node_keys": [sweden_key],
        },
    )

    second = subs.refresh_subscription(
        str(ui_state_dir),
        "json-edit",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert second["ok"] is True
    assert second["filtered_out_count"] == 1
    assert [item["tag"] for item in json.loads((xray_dir / "04_outbounds.json-edit.json").read_text(encoding="utf-8"))["outbounds"]] == [
        "flt--RU-Anti-06.e026",
        "flt--DE-Germany.0005",
    ]

    saved = subs.load_subscription_state(str(ui_state_dir))["subscriptions"][0]
    assert saved["excluded_node_keys"] == [sweden_key]
    assert {item["name"] for item in saved["last_nodes"] if item.get("tag")} == {
        "RU-Anti-06.e026",
        "DE-Germany.0005",
    }


def test_refresh_subscription_accepts_xray_json_config_arrays(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    subscription_body = json.dumps(
        [
            {
                "remarks": "JSON Node",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                        "streamSettings": {"network": "tcp", "security": "reality"},
                    },
                    {"tag": "direct", "protocol": "freedom", "settings": {}},
                    {"tag": "block", "protocol": "blackhole", "settings": {}},
                ],
            }
        ]
    )
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (subscription_body, {"content-type": "application/json"}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "json-demo",
            "tag": "json",
            "url": "https://example.com/json",
            "enabled": True,
            "ping_enabled": True,
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "json-demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=True,
    )

    assert result["ok"] is True
    assert result["source_format"] == "xray-json"
    assert result["count"] == 1
    assert result["source_count"] == 1
    assert result["filtered_out_count"] == 0
    assert result["tags"] == ["json--JSON_Node"]

    generated = json.loads((xray_dir / "04_outbounds.json-demo.json").read_text(encoding="utf-8"))
    assert len(generated["outbounds"]) == 1
    assert generated["outbounds"][0]["protocol"] == "vless"
    assert generated["outbounds"][0]["tag"] == "json--JSON_Node"


def test_refresh_subscription_applies_filters_to_xray_json_payloads(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    subscription_body = json.dumps(
        [
            {
                "remarks": "Primary Germany",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                    }
                ],
            },
            {
                "remarks": "Backup Sweden",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "trojan",
                        "settings": {
                            "servers": [{"address": "backup.example.com", "port": 443, "password": "secret"}]
                        },
                    }
                ],
            },
        ]
    )
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (subscription_body, {"content-type": "application/json"}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "json-filter",
            "tag": "jsonf",
            "url": "https://example.com/json",
            "enabled": True,
            "ping_enabled": False,
            "name_filter": "Primary",
            "type_filter": "vless",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "json-filter",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    assert result["source_format"] == "xray-json"
    assert result["count"] == 1
    assert result["source_count"] == 2
    assert result["filtered_out_count"] == 1
    assert result["tags"] == ["jsonf--Primary_Germany"]


def test_refresh_subscription_persists_last_nodes_with_transport_metadata(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)

    subscription_body = json.dumps(
        [
            {
                "remarks": "WS Germany",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "ws.example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                        "streamSettings": {
                            "network": "ws",
                            "security": "tls",
                            "wsSettings": {
                                "path": "/ws",
                                "headers": {"Host": "cdn.example.com"},
                            },
                        },
                    }
                ],
            },
            {
                "remarks": "GRPC Sweden",
                "outbounds": [
                    {
                        "tag": "proxy",
                        "protocol": "vless",
                        "settings": {
                            "vnext": [
                                {
                                    "address": "grpc.example.com",
                                    "port": 443,
                                    "users": [{"id": "user", "encryption": "none"}],
                                }
                            ]
                        },
                        "streamSettings": {
                            "network": "grpc",
                            "security": "reality",
                            "grpcSettings": {"serviceName": "grpc-svc"},
                        },
                    }
                ],
            },
        ]
    )
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (subscription_body, {"content-type": "application/json"}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "json-transport",
            "tag": "jsont",
            "url": "https://example.com/json",
            "enabled": True,
            "ping_enabled": False,
            "transport_filter": "grpc",
        },
    )

    result = subs.refresh_subscription(
        str(ui_state_dir),
        "json-transport",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    assert result["ok"] is True
    assert result["source_format"] == "xray-json"
    assert result["count"] == 1
    assert result["source_count"] == 2
    assert result["filtered_out_count"] == 1
    assert result["tags"] == ["jsont--GRPC_Sweden"]
    assert result["warnings"]
    assert "gRPC" in result["warnings"][0]
    assert "XHTTP" in result["warnings"][0]
    assert [item["transport"] for item in result["last_nodes"]] == ["ws", "grpc"]
    assert result["last_nodes"][0].get("tag") in ("", None)
    assert result["last_nodes"][1]["tag"] == "jsont--GRPC_Sweden"
    assert result["last_nodes"][0]["detail"] == "path=/ws · host=cdn.example.com"
    assert result["last_nodes"][1]["detail"] == "service=grpc-svc"

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["transport_filter"] == "grpc"
    assert saved["last_filtered_out_count"] == 1
    assert saved["last_warnings"]
    assert "gRPC" in saved["last_warnings"][0]
    assert [item["transport"] for item in saved["last_nodes"]] == ["ws", "grpc"]
    assert saved["last_nodes"][1]["tag"] == "jsont--GRPC_Sweden"


def test_probe_subscription_node_latency_updates_state(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("Ping Node", "ws", host="ping.example.com"), {}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "probe-demo",
            "tag": "probed",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    refresh = subs.refresh_subscription(
        str(ui_state_dir),
        "probe-demo",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    node = refresh["last_nodes"][0]
    assert node["tag"] == refresh["tags"][0]

    def _fake_probe_outbounds_batch(*, xray_bin, targets, probe_url, timeout_value, concurrency=3):
        assert xray_bin == "/opt/sbin/xray"
        assert probe_url == "https://probe.example.com/generate_204"
        assert float(timeout_value or 0) == pytest.approx(8.0)
        assert int(concurrency or 0) == subs.PROBE_BATCH_CONCURRENCY
        assert len(targets) == 1
        assert targets[0]["key"] == node["key"]
        assert targets[0]["tag"] == node["tag"]
        return {node["key"]: {"delay_ms": 123, "error": ""}}

    monkeypatch.setattr(subs, "_find_xray_binary", lambda: "/opt/sbin/xray")
    monkeypatch.setattr(subs, "_probe_url_for_subscription", lambda _dir: "https://probe.example.com/generate_204")
    monkeypatch.setattr(subs, "_probe_outbounds_batch", _fake_probe_outbounds_batch)

    result = subs.probe_subscription_node_latency(
        str(ui_state_dir),
        "probe-demo",
        node["key"],
        xray_configs_dir=str(xray_dir),
        timeout_s=8,
    )

    assert result["ok"] is True
    assert result["tag"] == node["tag"]
    assert result["delay_ms"] == 123
    assert result["entry"]["delay_ms"] == 123
    assert result["entry"]["status"] == "ok"
    assert result["entry"]["history"][0]["delay_ms"] == 123

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["node_latency"][node["key"]]["delay_ms"] == 123
    assert saved["node_latency"][node["key"]]["history"][0]["status"] == "ok"


def test_probe_subscription_nodes_latency_updates_state_once(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (
            "\n".join(
                [
                    _vless_transport("Ping One", "ws", host="one.example.com"),
                    _vless_transport("Ping Two", "grpc", host="two.example.com"),
                ]
            ),
            {},
        ),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "probe-bulk",
            "tag": "probebulk",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    refresh = subs.refresh_subscription(
        str(ui_state_dir),
        "probe-bulk",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    nodes = list(refresh["last_nodes"])
    assert len(nodes) == 2

    class _FakeProc:
        def poll(self):
            return None

    popen_calls = {"count": 0}
    write_calls = {"count": 0}
    original_write_state = subs._write_state

    def _counting_write_state(*args, **kwargs):
        write_calls["count"] += 1
        return original_write_state(*args, **kwargs)

    def _counting_popen(*args, **kwargs):
        popen_calls["count"] += 1
        return _FakeProc()

    probe_delays = [(123, ""), (456, "")]
    probe_lock = threading.Lock()

    def _fake_probe_via_local_proxy(_port, _probe_url, timeout_value):
        assert _probe_url == "https://probe.example.com/generate_204"
        assert float(timeout_value or 0) == pytest.approx(8.0)
        with probe_lock:
            return probe_delays.pop(0)

    monkeypatch.setattr(subs, "_find_xray_binary", lambda: "/opt/sbin/xray")
    monkeypatch.setattr(subs, "_wait_for_local_ports", lambda _ports, _proc, _timeout: True)
    monkeypatch.setattr(subs, "_terminate_process", lambda _proc, timeout_s=1.5: ("", ""))
    monkeypatch.setattr(subs, "_probe_url_for_subscription", lambda _dir: "https://probe.example.com/generate_204")
    monkeypatch.setattr(subs.subprocess, "Popen", _counting_popen)
    monkeypatch.setattr(subs, "_probe_via_local_proxy", _fake_probe_via_local_proxy)
    monkeypatch.setattr(subs, "_write_state", _counting_write_state)

    result = subs.probe_subscription_nodes_latency(
        str(ui_state_dir),
        "probe-bulk",
        [nodes[0]["key"], nodes[1]["key"]],
        xray_configs_dir=str(xray_dir),
        timeout_s=8,
    )

    assert result["ok"] is True
    assert result["ok_count"] == 2
    assert result["failed_count"] == 0
    assert result["updated"] == 2
    assert len(result["results"]) == 2
    assert result["results"][0]["entry"]["status"] == "ok"
    assert result["results"][1]["entry"]["status"] == "ok"
    assert write_calls["count"] == 1
    assert popen_calls["count"] == 1

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["node_latency"][nodes[0]["key"]]["delay_ms"] == 123
    assert saved["node_latency"][nodes[1]["key"]]["delay_ms"] == 456


def test_probe_subscription_nodes_latency_retries_process_start(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    ui_state_dir = tmp_path / "state"
    xray_dir = tmp_path / "xray" / "configs"
    jsonc_dir = tmp_path / "jsonc"
    ui_state_dir.mkdir()
    xray_dir.mkdir(parents=True)
    jsonc_dir.mkdir()

    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(
        subs,
        "fetch_subscription_body",
        lambda _url: (_vless_transport("Retry Node", "ws", host="retry.example.com"), {}),
    )

    subs.upsert_subscription(
        str(ui_state_dir),
        {
            "id": "probe-retry",
            "tag": "proberetry",
            "url": "https://example.com/sub",
            "enabled": True,
            "ping_enabled": False,
        },
    )

    refresh = subs.refresh_subscription(
        str(ui_state_dir),
        "probe-retry",
        xray_configs_dir=str(xray_dir),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **_kwargs: True,
        restart=False,
    )

    node = refresh["last_nodes"][0]

    class _FakeProc:
        def poll(self):
            return None

    popen_calls = {"count": 0}
    wait_calls = {"count": 0}

    def _counting_popen(*args, **kwargs):
        popen_calls["count"] += 1
        return _FakeProc()

    def _fake_wait_for_local_ports(_ports, _proc, _timeout):
        wait_calls["count"] += 1
        return wait_calls["count"] >= 2

    monkeypatch.setattr(subs, "_find_xray_binary", lambda: "/opt/sbin/xray")
    monkeypatch.setattr(subs, "_wait_for_local_ports", _fake_wait_for_local_ports)
    monkeypatch.setattr(subs, "_terminate_process", lambda _proc, timeout_s=1.5: ("", "bind failed"))
    monkeypatch.setattr(subs, "_probe_url_for_subscription", lambda _dir: "https://probe.example.com/generate_204")
    monkeypatch.setattr(subs.subprocess, "Popen", _counting_popen)
    monkeypatch.setattr(subs, "_probe_via_local_proxy", lambda _port, _probe_url, timeout_value: (321, ""))

    result = subs.probe_subscription_nodes_latency(
        str(ui_state_dir),
        "probe-retry",
        [node["key"]],
        xray_configs_dir=str(xray_dir),
        timeout_s=8,
    )

    assert result["ok"] is True
    assert result["ok_count"] == 1
    assert result["failed_count"] == 0
    assert popen_calls["count"] >= 2
    assert wait_calls["count"] >= 2


def _probeable_outbound(tag: str, *, host: str = "example.com", port: int = 443, transport: str = "tcp") -> dict:
    stream = {"network": transport, "security": "none"}
    if transport == "ws":
        stream["wsSettings"] = {"path": "/ws", "headers": {"Host": host}}
    return {
        "tag": tag,
        "protocol": "vless",
        "settings": {
            "vnext": [
                {
                    "address": host,
                    "port": port,
                    "users": [{"id": "11111111-1111-4111-8111-111111111111", "encryption": "none"}],
                }
            ]
        },
        "streamSettings": stream,
    }


def test_build_xray_outbounds_nodes_hides_legacy_single_link_alias():
    from services import xray_subscriptions as subs

    proxy = _probeable_outbound("proxy", host="single.example.com")
    alias = json.loads(json.dumps(proxy))
    alias["tag"] = "vless-reality"
    cfg = {
        "outbounds": [
            proxy,
            alias,
            {"tag": "direct", "protocol": "freedom"},
            {"tag": "block", "protocol": "blackhole"},
        ]
    }

    nodes = subs.build_xray_outbounds_nodes(cfg)

    assert [node["tag"] for node in nodes] == ["proxy"]
    assert nodes[0]["host"] == "single.example.com"
    assert nodes[0]["transport"] == "tcp"


def test_build_xray_outbounds_nodes_exposes_sni_metadata():
    from services import xray_subscriptions as subs

    outbound = _probeable_outbound("vless-reality", host="64.188.68.172")
    outbound["streamSettings"]["security"] = "reality"
    outbound["streamSettings"]["realitySettings"] = {"serverName": "bahn.de"}
    cfg = {"outbounds": [outbound]}

    nodes = subs.build_xray_outbounds_nodes(cfg)

    assert nodes[0]["tag"] == "vless-reality"
    assert nodes[0]["host"] == "64.188.68.172"
    assert nodes[0]["sni"] == "bahn.de"
    assert "sni=bahn.de" in nodes[0]["detail"]


def test_probe_xray_outbounds_nodes_latency_uses_pool_outbounds(monkeypatch, tmp_path: Path):
    from services import xray_subscriptions as subs

    cfg = {
        "outbounds": [
            _probeable_outbound("pool-one", host="one.example.com"),
            _probeable_outbound("pool-two", host="two.example.com", transport="ws"),
            {"tag": "direct", "protocol": "freedom"},
            {"tag": "block", "protocol": "blackhole"},
        ]
    }
    nodes = subs.build_xray_outbounds_nodes(cfg)
    captured = {}

    monkeypatch.setattr(subs, "_find_xray_binary", lambda: "/bin/xray")
    monkeypatch.setattr(subs, "_probe_url_for_subscription", lambda _dir: "https://probe.example.com/generate_204")

    def _fake_probe_outbounds_batch(*, xray_bin, targets, probe_url, timeout_value, concurrency=3):
        captured["xray_bin"] = xray_bin
        captured["probe_url"] = probe_url
        captured["tags"] = [item["tag"] for item in targets]
        return {
            targets[0]["key"]: {"delay_ms": 111, "error": ""},
            targets[1]["key"]: {"delay_ms": 222, "error": ""},
        }

    monkeypatch.setattr(subs, "_probe_outbounds_batch", _fake_probe_outbounds_batch)

    result = subs.probe_xray_outbounds_nodes_latency(
        cfg,
        [nodes[0]["key"], nodes[1]["key"]],
        xray_configs_dir=str(tmp_path),
        existing_latency={},
        timeout_s=3,
    )

    assert result["ok"] is True
    assert result["ok_count"] == 2
    assert result["failed_count"] == 0
    assert captured["tags"] == ["pool-one", "pool-two"]
    assert result["node_latency"][nodes[0]["key"]]["delay_ms"] == 111
    assert result["node_latency"][nodes[1]["key"]]["delay_ms"] == 222
