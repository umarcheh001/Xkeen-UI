"""Auth/setup routes extracted from app.py.

We register routes directly on the Flask app (not via Blueprint) to preserve
endpoint names used by templates via url_for(...).

Auth/CSRF hooks are still configured by services.auth_setup.init_auth(app)
from app.py.
"""

from __future__ import annotations

import json
import re
import time
from typing import Optional

from flask import (
    Flask,
    jsonify,
    make_response,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

from services.auth_rate_limit import (
    clear_login_rate_limit,
    format_lockout_wait,
    get_login_rate_limit_status,
    register_login_failure,
)
from services.auth_setup import (
    AUTH_FILE,
    _atomic_write,
    _auth_load,
    _check_csrf,
    _csrf_failed,
    _ensure_csrf_token,
    _is_logged_in,
    auth_is_configured,
)


def register_auth_routes(app: Flask) -> None:
    """Register /login, /setup and /api/auth/* routes."""

    def _login_rate_limit_view(remote_addr: str | None) -> dict:
        status = get_login_rate_limit_status(remote_addr)
        return {
            "enabled": bool(status.get("enabled")),
            "window_seconds": int(status.get("window_seconds") or 0),
            "max_attempts": int(status.get("max_attempts") or 0),
            "lockout_seconds": int(status.get("lockout_seconds") or 0),
            "failures": int(status.get("failures") or 0),
            "attempts_left": int(status.get("attempts_left") or 0),
            "locked": bool(status.get("locked")),
            "retry_after": int(status.get("retry_after") or 0),
        }

    def _login_lockout_message(rate: dict) -> str:
        wait = format_lockout_wait(rate.get("retry_after") or 0)
        return (
            "Слишком много неудачных попыток входа. "
            f"Вход с этого адреса временно заблокирован на {wait}. "
            "Подождите и попробуйте снова."
        )

    def _invalid_credentials_message(rate: dict) -> str:
        attempts_left = int(rate.get("attempts_left") or 0)
        if attempts_left > 0:
            return (
                "Неверный логин или пароль. "
                f"Осталось попыток до временной блокировки: {attempts_left}."
            )
        return "Неверный логин или пароль."

    def _login_rate_limit_payload(rate: dict, *, error: str, message: str) -> dict:
        payload = {
            "ok": False,
            "error": error,
            "message": message,
            "rate_limit": _login_rate_limit_view(request.remote_addr),
        }
        retry_after = int(rate.get("retry_after") or 0)
        if retry_after > 0:
            payload["retry_after"] = retry_after
        return payload

    def _locked_html_response(rate: dict, *, username: str = "", status_code: int = 429):
        response = make_response(
            render_template(
                "login.html",
                error=_login_lockout_message(rate),
                username=username,
            ),
            status_code,
        )
        retry_after = int(rate.get("retry_after") or 0)
        if retry_after > 0:
            response.headers["Retry-After"] = str(retry_after)
        return response

    def _locked_json_response(rate: dict):
        response = jsonify(
            _login_rate_limit_payload(
                rate,
                error="login_locked",
                message=_login_lockout_message(rate),
            )
        )
        response.status_code = 429
        retry_after = int(rate.get("retry_after") or 0)
        if retry_after > 0:
            response.headers["Retry-After"] = str(retry_after)
        return response

    def _auth_save(username: str, password: str) -> None:
        username_ = (username or "").strip()
        pw_hash = generate_password_hash(password)
        payload = {
            "version": 1,
            "created_at": int(time.time()),
            "username": username_,
            "password_hash": pw_hash,
        }
        _atomic_write(AUTH_FILE, json.dumps(payload, ensure_ascii=False, indent=2) + "\n", mode=0o600)

    def _validate_username(username: str) -> Optional[str]:
        u = (username or "").strip()
        if len(u) < 3 or len(u) > 32:
            return "Логин должен быть длиной 3–32 символа"
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", u):
            return "Логин может содержать только латиницу, цифры и символы _ . -"
        return None

    def _validate_password(password: str) -> Optional[str]:
        p = password or ""
        if len(p) < 8:
            return "Пароль должен быть не короче 8 символов"
        if p.strip() != p:
            return "Пароль не должен начинаться/заканчиваться пробелами"
        return None

    @app.get("/api/auth/status")
    def api_auth_status():
        return jsonify(
            {
                "ok": True,
                "configured": auth_is_configured(),
                "logged_in": _is_logged_in(),
                "user": session.get("user"),
            }
        )

    @app.get("/setup")
    def setup():
        if auth_is_configured():
            if _is_logged_in():
                return redirect(url_for("index"))
            return redirect(url_for("login"))
        return render_template("setup.html")

    @app.post("/setup")
    def setup_post():
        if auth_is_configured():
            return redirect(url_for("login"))
        if not _check_csrf():
            return render_template("setup.html", error="Ошибка безопасности: CSRF")

        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        password2 = request.form.get("password2") or ""

        err = _validate_username(username) or _validate_password(password)
        if not err and password != password2:
            err = "Пароли не совпадают"

        if err:
            return render_template("setup.html", error=err, username=username)

        try:
            _auth_save(username, password)
        except Exception as e:
            return render_template("setup.html", error=f"Не удалось сохранить учётные данные: {e}")

        session.clear()
        _ensure_csrf_token()
        session["auth"] = True
        session["user"] = username
        return redirect(url_for("index"))

    @app.get("/login")
    def login():
        if not auth_is_configured():
            return redirect(url_for("setup"))
        if _is_logged_in():
            return redirect(url_for("index"))
        rate = _login_rate_limit_view(request.remote_addr)
        error = _login_lockout_message(rate) if rate.get("locked") else None
        return render_template("login.html", error=error)

    @app.post("/login")
    def login_post():
        if not auth_is_configured():
            return redirect(url_for("setup"))
        if not _check_csrf():
            return render_template("login.html", error="Ошибка безопасности: CSRF")

        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        rate = _login_rate_limit_view(request.remote_addr)
        if rate.get("locked"):
            return _locked_html_response(rate, username=username)

        rec = _auth_load() or {}
        ok = False
        try:
            ok = (username == (rec.get("username") or "")) and check_password_hash(
                (rec.get("password_hash") or ""),
                password,
            )
        except Exception:
            ok = False

        if not ok:
            rate = register_login_failure(request.remote_addr)
            if rate.get("locked"):
                return _locked_html_response(rate, username=username)
            return render_template(
                "login.html",
                error=_invalid_credentials_message(rate),
                username=username,
            )

        clear_login_rate_limit(request.remote_addr)
        session.clear()
        _ensure_csrf_token()
        session["auth"] = True
        session["user"] = username

        next_path = (request.args.get("next") or "").strip()
        if next_path.startswith("/") and not next_path.startswith("//"):
            return redirect(next_path)
        return redirect(url_for("index"))

    @app.get("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.post("/api/auth/login")
    def api_auth_login():
        if not auth_is_configured():
            return jsonify({"ok": False, "error": "not_configured"}), 428
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if not _check_csrf():
            return _csrf_failed()

        rate = _login_rate_limit_view(request.remote_addr)
        if rate.get("locked"):
            return _locked_json_response(rate)

        rec = _auth_load() or {}
        ok = False
        try:
            ok = (username == (rec.get("username") or "")) and check_password_hash(
                (rec.get("password_hash") or ""),
                password,
            )
        except Exception:
            ok = False

        if not ok:
            rate = register_login_failure(request.remote_addr)
            if rate.get("locked"):
                return _locked_json_response(rate)
            return (
                jsonify(
                    _login_rate_limit_payload(
                        rate,
                        error="invalid_credentials",
                        message=_invalid_credentials_message(rate),
                    )
                ),
                401,
            )

        clear_login_rate_limit(request.remote_addr)
        session.clear()
        _ensure_csrf_token()
        session["auth"] = True
        session["user"] = username
        return jsonify({"ok": True})

    @app.post("/api/auth/logout")
    def api_auth_logout():
        if not _check_csrf():
            return _csrf_failed()
        session.clear()
        return jsonify({"ok": True})

    @app.post("/api/auth/setup")
    def api_auth_setup():
        if auth_is_configured():
            return jsonify({"ok": False, "error": "already_configured"}), 409
        if not _check_csrf():
            return _csrf_failed()
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        password2 = data.get("password2") or ""
        err = _validate_username(username) or _validate_password(password)
        if not err and password != password2:
            err = "password_mismatch"
        if err:
            return jsonify({"ok": False, "error": err}), 400
        _auth_save(username, password)
        session.clear()
        _ensure_csrf_token()
        session["auth"] = True
        session["user"] = username
        return jsonify({"ok": True})
