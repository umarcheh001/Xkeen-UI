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


def _make_app() -> Flask:
    app = Flask(__name__)
    app.config["TESTING"] = True
    bp = xray_configs_mod.create_xray_configs_blueprint(
        restart_xkeen=lambda **_kwargs: False,
        load_json=_load_json,
        save_json=_save_json,
        strip_json_comments_text=_strip_json_comments_text,
        snapshot_xray_config_before_overwrite=lambda _path: None,
        ui_state_dir="",
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


def test_api_set_outbounds_matches_single_link_tag_to_current_routing_vless_reality(tmp_path, monkeypatch):
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
    assert [item["tag"] for item in saved["outbounds"]] == ["vless-reality", "direct", "block"]


def test_api_set_outbounds_matches_single_link_tag_to_current_routing_proxy(tmp_path, monkeypatch):
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
    assert [item["tag"] for item in saved["outbounds"]] == ["proxy", "direct", "block"]
