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


def _build_auth_client(tmp_path: Path, monkeypatch, *, max_attempts: int = 3, lockout_seconds: int = 60):
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("XKEEN_UI_STATE_DIR", str(state_dir))
    monkeypatch.setenv("XKEEN_UI_SECRET_KEY", "test-secret-key")
    monkeypatch.setenv("XKEEN_AUTH_LOGIN_WINDOW_SECONDS", "300")
    monkeypatch.setenv("XKEEN_AUTH_LOGIN_MAX_ATTEMPTS", str(max_attempts))
    monkeypatch.setenv("XKEEN_AUTH_LOGIN_LOCKOUT_SECONDS", str(lockout_seconds))

    _reload("core.paths")
    auth_setup = _reload("services.auth_setup")
    auth_rate_limit = _reload("services.auth_rate_limit")
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
        "auth-rate-limit-test",
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
    client.environ_base["REMOTE_ADDR"] = "198.51.100.10"
    return client, auth_rate_limit


def _set_csrf(client, token: str = "csrf-token") -> str:
    with client.session_transaction() as sess:
        sess["csrf"] = token
    return token


def test_api_login_rate_limit_locks_after_threshold(tmp_path: Path, monkeypatch):
    client, _auth_rate_limit = _build_auth_client(tmp_path, monkeypatch, max_attempts=3, lockout_seconds=60)
    csrf = _set_csrf(client)

    first = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "bad-1"},
        headers={"X-CSRF-Token": csrf},
    )
    assert first.status_code == 401
    first_payload = first.get_json()
    assert first_payload["error"] == "invalid_credentials"
    assert first_payload["rate_limit"]["attempts_left"] == 2

    second = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "bad-2"},
        headers={"X-CSRF-Token": csrf},
    )
    assert second.status_code == 401
    second_payload = second.get_json()
    assert second_payload["rate_limit"]["attempts_left"] == 1

    third = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "bad-3"},
        headers={"X-CSRF-Token": csrf},
    )
    assert third.status_code == 429
    third_payload = third.get_json()
    assert third_payload["error"] == "login_locked"
    assert third_payload["rate_limit"]["locked"] is True
    assert int(third.headers["Retry-After"]) >= 1
    assert int(third_payload["retry_after"]) >= 1

    blocked_even_with_correct_password = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "secret123"},
        headers={"X-CSRF-Token": csrf},
    )
    assert blocked_even_with_correct_password.status_code == 429
    assert blocked_even_with_correct_password.get_json()["error"] == "login_locked"


def test_successful_login_clears_failed_attempt_counter(tmp_path: Path, monkeypatch):
    client, _auth_rate_limit = _build_auth_client(tmp_path, monkeypatch, max_attempts=3, lockout_seconds=60)
    csrf = _set_csrf(client)

    failed = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "wrong"},
        headers={"X-CSRF-Token": csrf},
    )
    assert failed.status_code == 401
    assert failed.get_json()["rate_limit"]["attempts_left"] == 2

    success = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "secret123"},
        headers={"X-CSRF-Token": csrf},
    )
    assert success.status_code == 200
    assert success.get_json()["ok"] is True

    with client.session_transaction() as sess:
        sess.clear()
        sess["csrf"] = csrf

    failed_again = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "wrong-again"},
        headers={"X-CSRF-Token": csrf},
    )
    assert failed_again.status_code == 401
    assert failed_again.get_json()["rate_limit"]["attempts_left"] == 2


def test_html_login_renders_lockout_message_and_get_page_keeps_it_visible(tmp_path: Path, monkeypatch):
    client, _auth_rate_limit = _build_auth_client(tmp_path, monkeypatch, max_attempts=3, lockout_seconds=60)
    csrf = _set_csrf(client)

    for password in ("bad-1", "bad-2"):
        response = client.post(
            "/login",
            data={"username": "admin", "password": password, "csrf_token": csrf},
        )
        assert response.status_code == 200

    locked = client.post(
        "/login",
        data={"username": "admin", "password": "bad-3", "csrf_token": csrf},
    )
    assert locked.status_code == 429
    assert int(locked.headers["Retry-After"]) >= 1
    assert "Слишком много неудачных попыток входа." in locked.get_data(as_text=True)

    landing = client.get("/login")
    assert landing.status_code == 200
    assert "Слишком много неудачных попыток входа." in landing.get_data(as_text=True)


def test_rate_limit_policy_can_be_disabled_with_zero_max_attempts(tmp_path: Path, monkeypatch):
    _client, auth_rate_limit = _build_auth_client(tmp_path, monkeypatch, max_attempts=0, lockout_seconds=60)

    status = auth_rate_limit.get_login_rate_limit_status("198.51.100.10")
    assert status["enabled"] is False

    failed = auth_rate_limit.register_login_failure("198.51.100.10")
    assert failed["enabled"] is False
    assert failed["locked"] is False
