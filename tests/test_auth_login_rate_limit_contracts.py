from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_devtools_env_whitelist_and_defaults_include_auth_login_limit_keys():
    env_py = (ROOT / "xkeen-ui" / "services" / "devtools" / "env.py").read_text(encoding="utf-8")

    assert '"XKEEN_AUTH_LOGIN_WINDOW_SECONDS"' in env_py
    assert '"XKEEN_AUTH_LOGIN_MAX_ATTEMPTS"' in env_py
    assert '"XKEEN_AUTH_LOGIN_LOCKOUT_SECONDS"' in env_py
    assert 'if k == "XKEEN_AUTH_LOGIN_WINDOW_SECONDS":' in env_py
    assert 'if k == "XKEEN_AUTH_LOGIN_MAX_ATTEMPTS":' in env_py
    assert 'if k == "XKEEN_AUTH_LOGIN_LOCKOUT_SECONDS":' in env_py


def test_devtools_frontend_marks_auth_login_limit_keys_as_live_env_settings():
    env_js = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "devtools" / "env.js").read_text(encoding="utf-8")

    assert "ENV_HELP.XKEEN_AUTH_LOGIN_WINDOW_SECONDS" in env_js
    assert "ENV_HELP.XKEEN_AUTH_LOGIN_MAX_ATTEMPTS" in env_js
    assert "ENV_HELP.XKEEN_AUTH_LOGIN_LOCKOUT_SECONDS" in env_js
    assert "ENV_NO_RESTART_KEYS.add('XKEEN_AUTH_LOGIN_WINDOW_SECONDS')" in env_js
    assert "ENV_NO_RESTART_KEYS.add('XKEEN_AUTH_LOGIN_MAX_ATTEMPTS')" in env_js
    assert "ENV_NO_RESTART_KEYS.add('XKEEN_AUTH_LOGIN_LOCKOUT_SECONDS')" in env_js


def test_auth_routes_return_structured_lockout_errors():
    auth_py = (ROOT / "xkeen-ui" / "routes" / "auth.py").read_text(encoding="utf-8")

    assert 'error="login_locked"' in auth_py
    assert 'response.headers["Retry-After"]' in auth_py
    assert "Осталось попыток до временной блокировки" in auth_py
