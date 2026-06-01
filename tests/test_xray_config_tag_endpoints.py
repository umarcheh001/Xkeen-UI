from __future__ import annotations

import json
import os
from pathlib import Path

from flask import Flask

import routes.xray_configs as xray_configs_mod


def _strip_json_comments_text(text: str) -> str:
    src = str(text or "")
    out: list[str] = []
    i = 0
    in_string = False
    quote = ""
    escaped = False
    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                in_string = False
                quote = ""
            i += 1
            continue
        if ch in ('"', "'"):
            in_string = True
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "/" and nxt == "/":
            while i < len(src) and src[i] not in "\r\n":
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _load_json(path: str, default=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return default


def _save_json(path: str, data) -> None:
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _vless_url() -> str:
    return (
        "vless://11111111-1111-4111-8111-111111111111@example.com:443"
        "?type=tcp&security=reality&sni=edge.example.com&pbk=pubkey&fp=chrome&encryption=none"
    )


def _hy2_url(name: str = "") -> str:
    suffix = f"#{name}" if name else ""
    return f"hy2://secret@example.com:443?sni=edge.example.com&pinSHA256=pin-one{suffix}"


def _make_app(ui_state_dir: str = "") -> Flask:
    app = Flask(__name__)
    app.config["TESTING"] = True
    bp = xray_configs_mod.create_xray_configs_blueprint(
        restart_xkeen=lambda **_kwargs: False,
        load_json=_load_json,
        save_json=_save_json,
        strip_json_comments_text=_strip_json_comments_text,
        snapshot_xray_config_before_overwrite=lambda _path: None,
        ui_state_dir=ui_state_dir,
    )
    app.register_blueprint(bp)
    return app


def test_xray_outbound_tags_all_collects_tags_across_all_fragments_and_jsonc(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    configs_dir.mkdir()
    jsonc_dir.mkdir()

    base_name = "04_outbounds.json"
    sub_name = "04_outbounds.cdn.pecan.run.json"

    (configs_dir / base_name).write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                    {"tag": "vless-reality", "protocol": "vless"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (configs_dir / sub_name).write_text(
        json.dumps({"outbounds": []}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (jsonc_dir / f"{sub_name}c").write_text(
        "\n".join(
            [
                "// subscription raw sidecar",
                "{",
                '  "outbounds": [',
                '    { "tag": "cdn.pecan.run--Node-01", "protocol": "vless" }',
                "  ]",
                "}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    os.utime(jsonc_dir / f"{sub_name}c", None)

    monkeypatch.setattr(
        xray_configs_mod,
        "list_xray_fragments",
        lambda kind: [{"name": base_name}, {"name": sub_name}] if kind == "outbounds" else [],
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(configs_dir / (file_arg or Path(default_path).name)),
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "jsonc_path_for",
        lambda main_path: str(jsonc_dir / (Path(main_path).name + "c")),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.get("/api/xray/outbound-tags?all=1")

    assert response.status_code == 200
    assert response.get_json()["tags"] == [
        "direct",
        "block",
        "vless-reality",
        "cdn.pecan.run--Node-01",
    ]


def test_xray_outbounds_nodes_include_subscription_source_name(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    outbounds_name = "04_outbounds.cdn.pecan.run.json"
    outbounds_path = configs_dir / outbounds_name
    source_name = "\U0001F3F3\U0001F1F7\U0001F1FA\ufe0f Anti 20.70ce"
    outbounds_path.write_text(
        json.dumps(
            {
                "outbounds": [
                    {
                        "tag": "cdn.pecan.run--Anti_20.70ce",
                        "protocol": "vless",
                        "settings": {},
                        "streamSettings": {"network": "xhttp", "security": "tls"},
                    }
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(configs_dir / (file_arg or Path(default_path).name)),
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "jsonc_path_for",
        lambda main_path: str(Path(main_path).with_suffix(Path(main_path).suffix + "c")),
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "list_subscriptions",
        lambda _ui_state_dir: [
            {
                "id": "cdn",
                "last_nodes": [
                    {
                        "tag": "cdn.pecan.run--Anti_20.70ce",
                        "name": source_name,
                    }
                ],
            }
        ],
    )

    app = _make_app(ui_state_dir=str(tmp_path / "state"))
    with app.test_client() as client:
        response = client.get(f"/api/xray/outbounds/nodes?file={outbounds_name}")

    assert response.status_code == 200
    nodes = response.get_json()["nodes"]
    assert nodes[0]["tag"] == "cdn.pecan.run--Anti_20.70ce"
    assert nodes[0]["subscription_node_name"] == source_name


def test_xray_inbound_tags_all_collects_tags_across_all_fragments_and_jsonc(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    configs_dir.mkdir()
    jsonc_dir.mkdir()

    base_name = "03_inbounds.json"
    extra_name = "03_inbounds.extra.json"

    (configs_dir / base_name).write_text(
        json.dumps(
            {
                "inbounds": [
                    {"tag": "redirect", "protocol": "dokodemo-door"},
                    {"tag": "tproxy", "protocol": "dokodemo-door"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (configs_dir / extra_name).write_text(
        json.dumps({"inbounds": []}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (jsonc_dir / f"{extra_name}c").write_text(
        "\n".join(
            [
                "// extra raw sidecar",
                "{",
                '  "inbounds": [',
                '    { "tag": "socks-in", "protocol": "socks" }',
                "  ]",
                "}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    os.utime(jsonc_dir / f"{extra_name}c", None)

    monkeypatch.setattr(
        xray_configs_mod,
        "list_xray_fragments",
        lambda kind: [{"name": base_name}, {"name": extra_name}] if kind == "inbounds" else [],
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(configs_dir / (file_arg or Path(default_path).name)),
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "jsonc_path_for",
        lambda main_path: str(jsonc_dir / (Path(main_path).name + "c")),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.get("/api/xray/inbound-tags?all=1")

    assert response.status_code == 200
    assert response.get_json()["tags"] == [
        "redirect",
        "tproxy",
        "socks-in",
    ]


def test_xray_inbound_tags_all_includes_loopback_outbound_inboundtag_refs(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    configs_dir.mkdir()
    jsonc_dir.mkdir()

    inbounds_name = "03_inbounds.json"
    outbounds_name = "04_outbounds.json"
    extra_outbounds_name = "04_outbounds.extra.json"

    (configs_dir / inbounds_name).write_text(
        json.dumps(
            {
                "inbounds": [
                    {"tag": "redirect", "protocol": "dokodemo-door"},
                    {"tag": "tproxy", "protocol": "dokodemo-door"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (configs_dir / outbounds_name).write_text(
        json.dumps(
            {
                "outbounds": [
                    {"tag": "direct", "protocol": "freedom"},
                    {
                        "tag": "rezerv_VPS",
                        "protocol": "loopback",
                        "settings": {"inboundTag": "toSecondVPS"},
                    },
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (configs_dir / extra_outbounds_name).write_text(
        json.dumps({"outbounds": []}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (jsonc_dir / f"{extra_outbounds_name}c").write_text(
        "\n".join(
            [
                "// extra raw sidecar",
                "{",
                '  "outbounds": [',
                '    { "tag": "reserve-chain", "protocol": "loopback", "settings": { "inboundTag": "toThirdVPS" } }',
                "  ]",
                "}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    os.utime(jsonc_dir / f"{extra_outbounds_name}c", None)

    def _list_fragments(kind: str):
        if kind == "inbounds":
            return [{"name": inbounds_name}]
        if kind == "outbounds":
            return [{"name": outbounds_name}, {"name": extra_outbounds_name}]
        return []

    def _resolve_fragment(file_arg: str, *, kind: str, default_path: str) -> str:
        base = configs_dir if kind in {"inbounds", "outbounds"} else tmp_path
        name = file_arg or Path(default_path).name
        return str(base / name)

    monkeypatch.setattr(xray_configs_mod, "list_xray_fragments", _list_fragments)
    monkeypatch.setattr(xray_configs_mod, "resolve_xray_fragment_file", _resolve_fragment)
    monkeypatch.setattr(
        xray_configs_mod,
        "jsonc_path_for",
        lambda main_path: str(jsonc_dir / (Path(main_path).name + "c")),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.get("/api/xray/inbound-tags?all=1")

    assert response.status_code == 200
    assert response.get_json()["tags"] == [
        "redirect",
        "tproxy",
        "toSecondVPS",
        "toThirdVPS",
    ]


def test_xray_outbounds_active_endpoint_marks_last_observed_node(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    configs_dir.mkdir()
    jsonc_dir.mkdir()

    outbounds_name = "04_outbounds.demo.json"
    (configs_dir / outbounds_name).write_text(
        json.dumps(
            {
                "outbounds": [
                    {
                        "tag": "demo--A",
                        "protocol": "vless",
                        "settings": {"address": "a.example", "port": 443},
                    },
                    {
                        "tag": "demo--B",
                        "protocol": "vless",
                        "settings": {"address": "b.example", "port": 443},
                    },
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(configs_dir / (file_arg or outbounds_name)),
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "jsonc_path_for",
        lambda main_path: str(jsonc_dir / (Path(main_path).name + "c")),
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "read_xray_outbound_runtime_log_sources",
        lambda max_lines=1200: {
            "access": [
                "2026/05/22 20:10:01 tcp:10.0.0.2:50000 accepted tcp:example.com:443 [demo--A]\n",
                "2026/05/22 20:10:05 tcp:10.0.0.2:50001 accepted tcp:example.org:443 [demo--B]\n",
            ]
        },
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.get(f"/api/xray/outbounds/active?file={outbounds_name}")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["available"] is True
    assert payload["active"]["tag"] == "demo--B"
    assert payload["active"]["last_seen"] == "2026/05/22 20:10:05"


def test_xray_outbounds_active_all_searches_across_outbound_fragments(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    configs_dir.mkdir()
    jsonc_dir.mkdir()

    main_name = "04_outbounds.json"
    reserve_name = "04_outbounds.reserve.json"
    white_name = "04_outbounds.white_list.json"

    (configs_dir / main_name).write_text(
        json.dumps(
            {
                "outbounds": [
                    {
                        "tag": "my_proxy",
                        "protocol": "vless",
                        "settings": {"address": "main.example", "port": 443},
                    }
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (configs_dir / reserve_name).write_text(
        json.dumps(
            {
                "outbounds": [
                    {
                        "tag": "reserve_proxy",
                        "protocol": "vless",
                        "settings": {"address": "reserve.example", "port": 443},
                    }
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (configs_dir / white_name).write_text(
        json.dumps(
            {
                "outbounds": [
                    {
                        "tag": "white_list",
                        "protocol": "vless",
                        "settings": {"address": "white.example", "port": 443},
                    }
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        xray_configs_mod,
        "list_xray_fragments",
        lambda kind: [
            {"name": main_name},
            {"name": reserve_name},
            {"name": white_name},
        ]
        if kind == "outbounds"
        else [],
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(configs_dir / (file_arg or Path(default_path).name)),
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "jsonc_path_for",
        lambda main_path: str(jsonc_dir / (Path(main_path).name + "c")),
    )
    monkeypatch.setattr(
        xray_configs_mod,
        "read_xray_outbound_runtime_log_sources",
        lambda max_lines=1200: {
            "access": [
                "2026/05/22 20:10:01 tcp:10.0.0.2:50000 accepted tcp:example.com:443 [my_proxy]\n",
            ]
        },
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.get(f"/api/xray/outbounds/active?file={reserve_name}&all=1")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["available"] is True
    assert payload["all_fragments"] is True
    assert payload["nodes_count"] == 3
    assert payload["active"]["tag"] == "my_proxy"
    assert payload["active"]["file"] == main_name


def test_api_set_outbounds_uses_new_single_tag_instead_of_routing_vless_reality(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    outbounds_path = configs_dir / "04_outbounds.json"
    routing_path = configs_dir / "05_routing.json"
    routing_path.write_text(
        json.dumps(
            {
                "routing": {
                    "rules": [
                        {"type": "field", "outboundTag": "block", "network": "udp", "port": "443"},
                        {"type": "field", "outboundTag": "vless-reality", "network": "tcp,udp"},
                    ]
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(xray_configs_mod, "ROUTING_FILE", str(routing_path))
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(outbounds_path),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.post("/api/outbounds", json={"url": _vless_url(), "restart": False})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True

    saved = json.loads(outbounds_path.read_text(encoding="utf-8"))
    assert [item["tag"] for item in saved["outbounds"]] == ["vless", "direct", "block"]


def test_api_set_outbounds_uses_new_single_tag_instead_of_routing_proxy(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    outbounds_path = configs_dir / "04_outbounds.json"
    routing_path = configs_dir / "05_routing.json"
    routing_path.write_text(
        json.dumps(
            {
                "routing": {
                    "rules": [
                        {"type": "field", "outboundTag": "block", "network": "udp", "port": "443"},
                        {"type": "field", "outboundTag": "proxy", "network": "tcp,udp"},
                    ]
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(xray_configs_mod, "ROUTING_FILE", str(routing_path))
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(outbounds_path),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.post("/api/outbounds", json={"url": _vless_url(), "restart": False})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True

    saved = json.loads(outbounds_path.read_text(encoding="utf-8"))
    assert [item["tag"] for item in saved["outbounds"]] == ["vless", "direct", "block"]


def test_api_set_outbounds_accepts_user_single_link_tag(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    outbounds_path = configs_dir / "04_outbounds.json"
    routing_path = configs_dir / "05_routing.json"
    routing_path.write_text(json.dumps({"routing": {"rules": []}}, ensure_ascii=False) + "\n", encoding="utf-8")

    monkeypatch.setattr(xray_configs_mod, "ROUTING_FILE", str(routing_path))
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(outbounds_path),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.post(
            "/api/outbounds",
            json={"url": _vless_url(), "outbound_tag": "my_proxy", "restart": False},
        )

    assert response.status_code == 200
    assert response.get_json()["ok"] is True

    saved = json.loads(outbounds_path.read_text(encoding="utf-8"))
    assert [item["tag"] for item in saved["outbounds"]] == ["my_proxy", "direct", "block"]

    with app.test_client() as client:
        loaded = client.get("/api/outbounds")

    assert loaded.status_code == 200
    assert loaded.get_json()["outbound_tag"] == "my_proxy"


def test_api_set_outbounds_preserves_existing_sockopt_marks_for_generated_link(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    outbounds_path = configs_dir / "04_outbounds.json"
    routing_path = configs_dir / "05_routing.json"
    routing_path.write_text(
        json.dumps(
            {
                "routing": {
                    "rules": [
                        {"type": "field", "outboundTag": "vless-reality", "network": "tcp,udp"},
                    ]
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    outbounds_path.write_text(
        json.dumps(
            {
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
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(xray_configs_mod, "ROUTING_FILE", str(routing_path))
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(outbounds_path),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.post("/api/outbounds", json={"url": _vless_url(), "restart": False})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True

    saved = json.loads(outbounds_path.read_text(encoding="utf-8"))
    assert [item["tag"] for item in saved["outbounds"]] == ["vless-reality", "direct", "block"]
    assert saved["outbounds"][0]["streamSettings"]["sockopt"]["mark"] == 255
    assert saved["outbounds"][1]["streamSettings"]["sockopt"]["mark"] == 255
    assert "streamSettings" not in saved["outbounds"][2]


def test_api_set_outbounds_can_apply_entware_sockopt_mark_for_generated_link(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    outbounds_path = configs_dir / "04_outbounds.json"
    routing_path = configs_dir / "05_routing.json"
    routing_path.write_text(json.dumps({"routing": {"rules": []}}, ensure_ascii=False) + "\n", encoding="utf-8")

    monkeypatch.setattr(xray_configs_mod, "ROUTING_FILE", str(routing_path))
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(outbounds_path),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.post(
            "/api/outbounds",
            json={"url": _vless_url(), "restart": False, "sockopt_mark_255": True},
        )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True

    saved = json.loads(outbounds_path.read_text(encoding="utf-8"))
    assert saved["outbounds"][0]["streamSettings"]["sockopt"]["mark"] == 255
    assert saved["outbounds"][1]["streamSettings"]["sockopt"]["mark"] == 255
    assert "streamSettings" not in saved["outbounds"][2]


def test_api_set_outbounds_does_not_clone_single_link_for_multiple_routing_tags(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    outbounds_path = configs_dir / "04_outbounds.json"
    routing_path = configs_dir / "05_routing.json"
    routing_path.write_text(
        json.dumps(
            {
                "routing": {
                    "rules": [
                        {"type": "field", "outboundTag": "dns-out", "domain": ["geosite:category-ads-all"]},
                        {"type": "field", "outboundTag": "bydpi_myNAS", "network": "tcp,udp"},
                    ]
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(xray_configs_mod, "ROUTING_FILE", str(routing_path))
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(outbounds_path),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.post("/api/outbounds", json={"url": _hy2_url(), "restart": False})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True

    saved = json.loads(outbounds_path.read_text(encoding="utf-8"))
    assert [item["tag"] for item in saved["outbounds"]] == ["hy2", "direct", "block"]
    assert saved["outbounds"][0]["protocol"] == "hysteria"


def test_api_set_outbounds_creates_unique_single_tag_when_pool_fragment_exists(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    outbounds_path = configs_dir / "04_outbounds.json"
    pool_path = configs_dir / "04_outbounds_All.json"
    inbounds_path = configs_dir / "03_inbounds.json"
    routing_path = configs_dir / "05_routing.json"
    routing_payload = {
        "routing": {
            "balancers": [
                {"tag": "proxy", "selector": ["MyVPN_hy2_NLS"], "fallbackTag": "direct"},
                {"tag": "MyVPN_hy2_NLS-2", "selector": ["bydpi_myNAS"], "fallbackTag": "direct"},
            ],
            "rules": [{"type": "field", "balancerTag": "proxy", "inboundTag": ["redirect", "tproxy"]}],
        }
    }
    routing_path.write_text(json.dumps(routing_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    inbounds_payload = {"inbounds": [{"tag": "MyVPN_hy2_NLS-3", "protocol": "dokodemo-door"}]}
    inbounds_path.write_text(json.dumps(inbounds_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pool_payload = {
        "outbounds": [
            {"tag": "bydpi_myNAS", "protocol": "vless"},
            {"tag": "MyVPN_hy2_NLS", "protocol": "hysteria"},
            {"tag": "direct", "protocol": "freedom"},
            {"tag": "block", "protocol": "blackhole"},
        ]
    }
    pool_path.write_text(json.dumps(pool_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    monkeypatch.setattr(xray_configs_mod, "ROUTING_FILE", str(routing_path))
    monkeypatch.setattr(xray_configs_mod, "list_xray_fragments", lambda kind: [{"name": pool_path.name}] if kind == "outbounds" else [])
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(configs_dir / (file_arg or Path(default_path).name)),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.post("/api/outbounds", json={"url": _hy2_url("MyVPN_hy2_NLS"), "restart": False})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True

    saved = json.loads(outbounds_path.read_text(encoding="utf-8"))
    assert [item["tag"] for item in saved["outbounds"]] == ["MyVPN_hy2_NLS-4"]
    assert saved["outbounds"][0]["protocol"] == "hysteria"
    assert json.loads(pool_path.read_text(encoding="utf-8")) == pool_payload
    assert json.loads(inbounds_path.read_text(encoding="utf-8")) == inbounds_payload
    assert json.loads(routing_path.read_text(encoding="utf-8")) == routing_payload


def test_api_xray_outbounds_proxies_can_apply_entware_sockopt_mark(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    configs_dir.mkdir()
    jsonc_dir.mkdir()
    outbounds_path = configs_dir / "04_outbounds.json"

    monkeypatch.setattr(xray_configs_mod, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(xray_configs_mod, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(
        xray_configs_mod,
        "resolve_xray_fragment_file",
        lambda file_arg, *, kind, default_path: str(outbounds_path),
    )

    app = _make_app()
    with app.test_client() as client:
        response = client.post(
            "/api/xray/outbounds/proxies",
            json={
                "entries": [{"tag": "pool-one", "url": _vless_url()}],
                "restart": False,
                "sockopt_mark_255": True,
            },
        )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True

    saved = json.loads(outbounds_path.read_text(encoding="utf-8"))
    assert [item["tag"] for item in saved["outbounds"]] == ["pool-one", "direct", "block"]
    assert saved["outbounds"][0]["streamSettings"]["sockopt"]["mark"] == 255
    assert saved["outbounds"][1]["streamSettings"]["sockopt"]["mark"] == 255
    assert "streamSettings" not in saved["outbounds"][2]
