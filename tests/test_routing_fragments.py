from __future__ import annotations

from pathlib import Path

from flask import Flask


def _client_for_fragments(configs_dir: Path, routing_file: Path):
    from routes.routing.fragments import register_fragments_routes

    app = Flask(__name__)
    app.config["TESTING"] = True
    register_fragments_routes(app, xray_configs_dir=str(configs_dir), routing_file=str(routing_file))
    return app.test_client()


def test_routing_fragments_include_all_json_fragments_except_log(tmp_path: Path):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    for name in (
        "05_routing(in_keenetic)_new.json",
        "05_routing.json",
        "05_custom_rules.json",
        "04_outbounds.json",
        "01_log.json",
    ):
        (configs_dir / name).write_text("{}\n", encoding="utf-8")

    client = _client_for_fragments(
        configs_dir,
        configs_dir / "05_routing(in_keenetic)_new.json",
    )

    payload = client.get("/api/routing/fragments").get_json()

    assert payload["ok"] is True
    assert payload["current"] == "05_routing(in_keenetic)_new.json"
    assert [item["name"] for item in payload["items"]] == [
        "04_outbounds.json",
        "05_custom_rules.json",
        "05_routing(in_keenetic)_new.json",
        "05_routing.json",
    ]


def test_routing_fragments_all_matches_default_list(tmp_path: Path):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    for name in (
        "05_routing(in_keenetic)_new.json",
        "05_custom_rules.json",
        "04_outbounds.json",
        "03_inbounds.json",
        "01_log.json",
    ):
        (configs_dir / name).write_text("{}\n", encoding="utf-8")

    client = _client_for_fragments(
        configs_dir,
        configs_dir / "05_routing(in_keenetic)_new.json",
    )

    default_payload = client.get("/api/routing/fragments").get_json()
    all_payload = client.get("/api/routing/fragments?all=1").get_json()

    assert default_payload["ok"] is True
    assert all_payload["ok"] is True
    expected = [
        "03_inbounds.json",
        "04_outbounds.json",
        "05_custom_rules.json",
        "05_routing(in_keenetic)_new.json",
    ]
    assert [item["name"] for item in default_payload["items"]] == expected
    assert [item["name"] for item in all_payload["items"]] == expected
