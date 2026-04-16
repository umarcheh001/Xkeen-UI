from __future__ import annotations

import base64
import json
from pathlib import Path


def _vless(name: str = "Node") -> str:
    return (
        "vless://user@example.com:443"
        "?type=tcp&security=reality&sni=edge.example.com&pbk=pubkey&encryption=none"
        f"#{name}"
    )


def test_parse_subscription_links_accepts_plain_and_base64_payloads():
    from services.xray_subscriptions import parse_subscription_links

    plain = _vless("Plain") + "\nunknown://skip\n" + _vless("Second")
    assert parse_subscription_links(plain) == [_vless("Plain"), _vless("Second")]

    encoded = base64.b64encode(plain.encode("utf-8")).decode("ascii")
    assert parse_subscription_links(encoded) == [_vless("Plain"), _vless("Second")]


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

    observatory = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))
    assert observatory["observatory"]["subjectSelector"] == ["demo--Fast_Node"]

    state = subs.load_subscription_state(str(ui_state_dir))
    saved = state["subscriptions"][0]
    assert saved["last_ok"] is True
    assert saved["last_count"] == 1
    assert saved["profile_update_interval_hours"] == 2
    assert saved["interval_hours"] == 2

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
    assert second["restarted"] is False
    assert restarts == []


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
    assert result["tags"] == ["json--JSON_Node"]

    generated = json.loads((xray_dir / "04_outbounds.json-demo.json").read_text(encoding="utf-8"))
    assert len(generated["outbounds"]) == 1
    assert generated["outbounds"][0]["protocol"] == "vless"
    assert generated["outbounds"][0]["tag"] == "json--JSON_Node"
