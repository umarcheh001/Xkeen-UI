from __future__ import annotations

import importlib
import json
from pathlib import Path

from flask import Flask
from werkzeug.security import generate_password_hash


def _reload(name: str):
    module = importlib.import_module(name)
    return importlib.reload(module)


def _build_client(tmp_path: Path, monkeypatch):
    state_dir = tmp_path / "state"
    logs_dir = tmp_path / "logs"
    state_dir.mkdir()
    logs_dir.mkdir()
    error_log = logs_dir / "error.log"
    access_log = logs_dir / "access.log"
    error_log.write_text(
        "2026/07/16 18:01:02 [Warning] transport started\n"
        "2026/07/16 18:01:03 [Error] failed to resolve upstream\n",
        encoding="utf-8",
    )
    access_log.write_text("2026/07/16 18:01:04 accepted tcp:127.0.0.1:443\n", encoding="utf-8")

    monkeypatch.setenv("XKEEN_UI_STATE_DIR", str(state_dir))
    monkeypatch.setenv("XKEEN_UI_SECRET_KEY", "mobile-logs-test-secret")
    _reload("core.paths")
    auth_setup = _reload("services.auth_setup")
    _reload("services.auth_rate_limit")
    mobile_routes = _reload("routes.mobile")

    auth_setup._atomic_write(
        auth_setup.AUTH_FILE,
        json.dumps(
            {
                "version": 1,
                "created_at": 0,
                "username": "admin",
                "password_hash": generate_password_hash("secret123"),
            }
        ),
        mode=0o600,
    )

    from services.xray_logs import read_new_lines, tail_lines_fast

    monkeypatch.setattr(
        mobile_routes,
        "_mobile_xray_logs_dependencies",
        lambda: {
            "adjust_log_timezone": lambda lines: lines,
            "read_new_lines": read_new_lines,
            "resolve_path": lambda source: str(error_log if source == "error" else access_log),
            "tail_lines_fast": tail_lines_fast,
        },
    )

    app = Flask("mobile-logs-contract-test")
    app.config["TESTING"] = True
    app.config["SECRET_KEY"] = "mobile-logs-test-secret"
    auth_setup.init_auth(app)
    mobile_routes.register_mobile_routes(app)
    return app.test_client(), error_log, access_log


def _login(client) -> None:
    response = client.post(
        "/api/mobile/v1/session",
        json={"username": "admin", "password": "secret123"},
    )
    assert response.status_code == 200


def _stream(payload: dict, source: str) -> dict:
    return next(item for item in payload["data"]["streams"] if item["source"] == source)


def test_mobile_logs_requires_authenticated_session(tmp_path, monkeypatch):
    client, _error_log, _access_log = _build_client(tmp_path, monkeypatch)

    response = client.get("/api/mobile/v1/logs")

    assert response.status_code == 401


def test_mobile_logs_returns_history_and_incremental_cursor_updates(tmp_path, monkeypatch):
    client, error_log, _access_log = _build_client(tmp_path, monkeypatch)
    _login(client)

    initial = client.get("/api/mobile/v1/logs")

    assert initial.status_code == 200
    error_stream = _stream(initial.get_json(), "error")
    assert error_stream["mode"] == "snapshot"
    assert error_stream["available"] is True
    assert [entry["level"] for entry in error_stream["entries"]] == ["warning", "error"]
    assert error_stream["entries"][1]["time"] == "18:01:03"
    assert all(entry["id"].startswith("error:") for entry in error_stream["entries"])

    with error_log.open("a", encoding="utf-8") as handle:
        handle.write("2026/07/16 18:01:05 [Info] routing reload completed\n")
    appended = client.get(
        "/api/mobile/v1/logs",
        query_string={"error-cursor": error_stream["cursor"]},
    )

    appended_stream = _stream(appended.get_json(), "error")
    assert appended_stream["mode"] == "append"
    assert [entry["message"] for entry in appended_stream["entries"]] == [
        "2026/07/16 18:01:05 [Info] routing reload completed"
    ]
    assert appended_stream["cursor"] != error_stream["cursor"]


def test_mobile_logs_resets_to_snapshot_after_rotation_or_invalid_cursor(tmp_path, monkeypatch):
    client, error_log, _access_log = _build_client(tmp_path, monkeypatch)
    _login(client)
    initial = client.get("/api/mobile/v1/logs")
    cursor = _stream(initial.get_json(), "error")["cursor"]

    error_log.write_text("2026/07/16 18:02:00 [Error] fresh file after rotation\n", encoding="utf-8")
    rotated = client.get("/api/mobile/v1/logs", query_string={"error-cursor": cursor})
    rotated_stream = _stream(rotated.get_json(), "error")
    assert rotated_stream["mode"] == "snapshot"
    assert rotated_stream["entries"][0]["message"].endswith("fresh file after rotation")

    malformed = client.get("/api/mobile/v1/logs", query_string={"error-cursor": "not-a-cursor"})
    malformed_stream = _stream(malformed.get_json(), "error")
    assert malformed_stream["mode"] == "snapshot"
