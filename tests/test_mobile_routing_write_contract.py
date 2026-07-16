from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path

from flask import Flask, Response
from werkzeug.security import generate_password_hash


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _reload(name: str):
    module = sys.modules.get(name)
    if module is not None:
        return importlib.reload(module)
    return importlib.import_module(name)


def _build_client(tmp_path: Path, monkeypatch, *, restart_ok: bool = True):
    state_dir = tmp_path / "state"
    configs_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    state_dir.mkdir()
    configs_dir.mkdir()
    jsonc_dir.mkdir()
    initial = '{\n  "routing": {"rules": []}\n}\n'
    main_path = configs_dir / "05_routing.json"
    main_path.write_text(initial, encoding="utf-8")

    monkeypatch.setenv("XKEEN_UI_STATE_DIR", str(state_dir))
    monkeypatch.setenv("XKEEN_UI_SECRET_KEY", "test-secret-key")
    _reload("core.paths")
    auth_setup = _reload("services.auth_setup")
    _reload("services.auth_rate_limit")
    mobile_routes = _reload("routes.mobile")
    mobile_routing = _reload("services.mobile_routing")

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

    calls: dict[str, list] = {"preflight": [], "restart": [], "snapshot": []}

    def paths_for_routing(_routing, _raw, _configs, _configs_real, document):
        name = str(document)
        if name.endswith(".jsonc"):
            name = name[:-1]
        if name != "05_routing.json":
            raise ValueError("unsupported document")
        return (
            str(configs_dir / name),
            str(jsonc_dir / f"{name}c"),
            str(configs_dir / f"{name}c"),
        )

    def run_preflight(**kwargs):
        calls["preflight"].append(kwargs)
        return {"ok": True, "phase": "xray_test"}

    def restart_xkeen(**kwargs):
        calls["restart"].append(kwargs)
        return restart_ok

    service = mobile_routing.MobileRoutingService(
        ui_state_dir=str(state_dir),
        routing_file=str(main_path),
        routing_file_raw=str(jsonc_dir / "05_routing.jsonc"),
        xray_configs_dir=str(configs_dir),
        xray_configs_dir_real=str(configs_dir.resolve()),
        paths_for_routing=paths_for_routing,
        run_preflight=run_preflight,
        snapshot_before_overwrite=lambda path: calls["snapshot"].append(path),
        restart_xkeen=restart_xkeen,
    )

    app = Flask("mobile-routing-write-test")
    app.config["TESTING"] = True

    @app.get("/ui/terminal-theme.css")
    def terminal_theme_css():
        return Response("", mimetype="text/css")

    auth_setup.init_auth(app)
    mobile_routes.register_mobile_routes(app)
    mobile_routes.configure_mobile_routing_service(app, service)
    return app.test_client(), calls, main_path, jsonc_dir / "05_routing.jsonc", initial


def _login(client) -> str:
    response = client.post(
        "/api/mobile/v1/session",
        json={"username": "admin", "password": "secret123"},
    )
    assert response.status_code == 200
    return response.get_json()["data"]["session"]["csrf_token"]


def _document(client) -> dict:
    response = client.get(
        "/api/mobile/v1/xray/routing/document",
        query_string={"document": "05_routing.json"},
    )
    assert response.status_code == 200
    return response.get_json()["data"]["document"]


def _save(client, csrf: str, current: dict, content: str):
    return client.post(
        "/api/mobile/v1/xray/routing/save",
        headers={"X-CSRF-Token": csrf},
        json={
            "document": "05_routing.json",
            "content": content,
            "published_revision": current["published"]["revision"],
            "saved_revision": current["saved"]["revision"],
        },
    )


def _apply(client, csrf: str, current: dict):
    return client.post(
        "/api/mobile/v1/xray/routing/apply",
        headers={"X-CSRF-Token": csrf},
        json={
            "document": "05_routing.json",
            "published_revision": current["published"]["revision"],
            "saved_revision": current["saved"]["revision"],
        },
    )


def test_mobile_save_persists_private_draft_without_touching_live_fragment(tmp_path, monkeypatch):
    client, calls, main_path, raw_path, initial = _build_client(tmp_path, monkeypatch)
    csrf = _login(client)
    current = _document(client)
    draft = '// saved only\n{"routing":{"rules":[{"type":"field"}]}}\n'

    response = _save(client, csrf, current, draft)

    assert response.status_code == 200
    saved = response.get_json()["data"]["document"]
    assert saved["saved"]["present"] is True
    assert saved["saved"]["content"] == draft
    assert saved["published"]["content"] == initial
    assert saved["saved"]["revision"] != saved["published"]["revision"]
    assert main_path.read_text(encoding="utf-8") == initial
    assert not raw_path.exists()
    assert calls["restart"] == []
    assert len(calls["preflight"]) == 1


def test_mobile_apply_writes_exact_saved_revision_and_confirms_restart(tmp_path, monkeypatch):
    client, calls, main_path, raw_path, _initial = _build_client(tmp_path, monkeypatch)
    csrf = _login(client)
    draft = '// ready\n{"routing":{"rules":[{"type":"field"}]}}\n'
    saved_response = _save(client, csrf, _document(client), draft)
    saved = saved_response.get_json()["data"]["document"]

    response = _apply(client, csrf, saved)

    assert response.status_code == 200
    applied = response.get_json()["data"]
    assert applied["applied"] is True
    assert applied["restarted"] is True
    assert applied["document"]["saved"]["present"] is False
    assert applied["document"]["published"]["content"] == draft
    assert json.loads(main_path.read_text(encoding="utf-8"))["routing"]["rules"]
    assert raw_path.read_text(encoding="utf-8") == draft
    assert calls["restart"] == [{"source": "mobile-routing-apply"}]
    assert len(calls["snapshot"]) == 1


def test_external_published_update_returns_conflict_without_overwrite(tmp_path, monkeypatch):
    client, calls, main_path, _raw_path, _initial = _build_client(tmp_path, monkeypatch)
    csrf = _login(client)
    stale = _document(client)
    external = '{"routing":{"rules":[{"external":true}]}}\n'
    main_path.write_text(external, encoding="utf-8")
    os.utime(main_path, None)

    response = _save(client, csrf, stale, '{"routing":{"rules":[{"mobile":true}]}}')

    assert response.status_code == 409
    payload = response.get_json()["error"]
    assert payload["code"] == "published_revision_conflict"
    assert payload["document"]["published"]["content"] == external
    assert main_path.read_text(encoding="utf-8") == external
    assert calls["restart"] == []


def test_stale_saved_revision_cannot_overwrite_newer_server_draft(tmp_path, monkeypatch):
    client, _calls, _main_path, _raw_path, _initial = _build_client(tmp_path, monkeypatch)
    csrf = _login(client)
    stale = _document(client)
    accepted = _save(client, csrf, stale, '{"routing":{"rules":[{"client":2}]}}')
    assert accepted.status_code == 200

    response = _save(client, csrf, stale, '{"routing":{"rules":[{"client":1}]}}')

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "saved_revision_conflict"


def test_external_update_after_save_blocks_apply_as_saved_published_conflict(tmp_path, monkeypatch):
    client, calls, main_path, _raw_path, _initial = _build_client(tmp_path, monkeypatch)
    csrf = _login(client)
    saved_response = _save(client, csrf, _document(client), '{"routing":{"rules":[1]}}')
    saved = saved_response.get_json()["data"]["document"]
    main_path.write_text('{"routing":{"rules":[2]}}\n', encoding="utf-8")

    # Refreshing the published token exposes the saved-vs-published conflict explicitly.
    current = _document(client)
    assert current["conflict"]["code"] == "saved_published_conflict"
    current["saved"] = saved["saved"]
    response = _apply(client, csrf, current)

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "saved_published_conflict"
    assert calls["restart"] == []


def test_failed_restart_rolls_live_fragment_back_and_keeps_saved_draft(tmp_path, monkeypatch):
    client, calls, main_path, raw_path, initial = _build_client(
        tmp_path,
        monkeypatch,
        restart_ok=False,
    )
    csrf = _login(client)
    saved_response = _save(client, csrf, _document(client), '{"routing":{"rules":[3]}}')
    saved = saved_response.get_json()["data"]["document"]

    response = _apply(client, csrf, saved)

    assert response.status_code == 500
    assert response.get_json()["error"]["code"] == "routing_restart_failed"
    assert main_path.read_text(encoding="utf-8") == initial
    assert not raw_path.exists()
    assert len(calls["restart"]) == 2
    assert _document(client)["saved"]["present"] is True


def test_mobile_routing_writes_require_authenticated_csrf_session(tmp_path, monkeypatch):
    client, _calls, _main_path, _raw_path, _initial = _build_client(tmp_path, monkeypatch)
    anonymous = client.post("/api/mobile/v1/xray/routing/save", json={})
    assert anonymous.status_code == 401

    _login(client)
    missing_csrf = client.post("/api/mobile/v1/xray/routing/save", json={})
    assert missing_csrf.status_code == 403
