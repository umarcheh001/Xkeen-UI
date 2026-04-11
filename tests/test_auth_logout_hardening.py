from __future__ import annotations

import importlib
import json
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


def _build_auth_client(tmp_path: Path, monkeypatch):
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("XKEEN_UI_STATE_DIR", str(state_dir))
    monkeypatch.setenv("XKEEN_UI_SECRET_KEY", "test-secret-key")

    _reload("core.paths")
    auth_setup = _reload("services.auth_setup")
    auth_routes = _reload("routes.auth")

    payload = {
        "version": 1,
        "created_at": 0,
        "username": "admin",
        "password_hash": generate_password_hash("secret123"),
    }
    auth_setup._atomic_write(
        auth_setup.AUTH_FILE,
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        mode=0o600,
    )

    app = Flask(
        "auth-logout-hardening-test",
        template_folder=str(APP_DIR / "templates"),
        static_folder=str(APP_DIR / "static"),
    )
    app.config["TESTING"] = True

    @app.get("/")
    def index():
        return "ok", 200

    @app.get("/ui/terminal-theme.css")
    def terminal_theme_css():
        return Response("", mimetype="text/css")

    auth_setup.init_auth(app)
    auth_routes.register_auth_routes(app)

    client = app.test_client()
    client.environ_base["REMOTE_ADDR"] = "198.51.100.11"
    return client


def _seed_authenticated_session(client, token: str = "csrf-token") -> str:
    with client.session_transaction() as sess:
        sess["auth"] = True
        sess["user"] = "admin"
        sess["csrf"] = token
    return token


def test_get_logout_no_longer_clears_authenticated_session(tmp_path: Path, monkeypatch):
    client = _build_auth_client(tmp_path, monkeypatch)
    csrf = _seed_authenticated_session(client)

    response = client.get("/logout", follow_redirects=False)

    assert response.status_code == 302
    assert response.headers["Location"].endswith("/login")

    with client.session_transaction() as sess:
        assert sess.get("auth") is True
        assert sess.get("user") == "admin"
        assert sess.get("csrf") == csrf


def test_post_logout_requires_csrf_and_clears_session_after_success(tmp_path: Path, monkeypatch):
    client = _build_auth_client(tmp_path, monkeypatch)
    csrf = _seed_authenticated_session(client)

    failed = client.post("/logout", data={}, follow_redirects=False)

    assert failed.status_code == 403
    with client.session_transaction() as sess:
        assert sess.get("auth") is True
        assert sess.get("user") == "admin"

    success = client.post("/logout", data={"csrf_token": csrf}, follow_redirects=False)

    assert success.status_code == 302
    assert success.headers["Location"].endswith("/login")
    with client.session_transaction() as sess:
        assert "auth" not in sess
        assert "user" not in sess
