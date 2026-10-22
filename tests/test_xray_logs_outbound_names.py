"""Имена узлов подписок по тегам outbound для таблицы access.log."""

from __future__ import annotations

import json
from pathlib import Path

from flask import Flask


def _client(state_dir: Path):
    from routes.xray_logs import create_xray_logs_blueprint

    app = Flask(__name__)
    app.register_blueprint(
        create_xray_logs_blueprint(
            ws_debug=lambda *args, **kwargs: None,
            restart_xray_core=lambda: None,
            ui_state_dir=str(state_dir),
        )
    )
    return app.test_client()


def test_outbound_names_keep_flag_emoji_that_the_tag_lost(tmp_path: Path):
    (tmp_path / "xray_subscriptions.json").write_text(
        json.dumps(
            {
                "subscriptions": [
                    {
                        "id": "pecan",
                        "name": "Pecan",
                        "tag": "pecan",
                        "url": "https://example.com/sub",
                        "last_nodes": [
                            {"tag": "pecan--Frankfurt-2", "name": "🇩🇪 Frankfurt-2", "key": "a"},
                            {"tag": "pecan--Helsinki", "name": "🇫🇮 Helsinki", "key": "b"},
                        ],
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    res = _client(tmp_path).get("/api/xray-logs/outbound-names")

    assert res.status_code == 200
    names = res.get_json()["names"]
    assert names["pecan--Frankfurt-2"] == {"name": "🇩🇪 Frankfurt-2", "subscription": "Pecan"}
    assert names["pecan--Helsinki"]["name"] == "🇫🇮 Helsinki"


def test_outbound_names_are_empty_without_subscriptions(tmp_path: Path):
    res = _client(tmp_path).get("/api/xray-logs/outbound-names")

    assert res.status_code == 200
    assert res.get_json() == {"ok": True, "names": {}}
