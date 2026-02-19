"""Auth/setup routes extracted from app.py.

We register routes directly on the Flask app (not via Blueprint) to preserve
endpoint names used by templates via url_for(...).

Auth/CSRF *hooks* are still configured by services.auth_setup.init_auth(app)
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
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from werkzeug.security import generate_password_hash, check_password_hash

from services.auth_setup import (
    AUTH_FILE,
    _atomic_write,
    _auth_load,
    auth_is_configured,
    _ensure_csrf_token,
    _is_logged_in,
    _csrf_failed,
    _check_csrf,
)


def register_auth_routes(app: Flask) -> None:
    """Register /login, /setup and /api/auth/* routes."""

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
        return render_template("login.html")

    @app.post("/login")
    def login_post():
        if not auth_is_configured():
            return redirect(url_for("setup"))
        if not _check_csrf():
            return render_template("login.html", error="Ошибка безопасности: CSRF")

        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        rec = _auth_load() or {}

        ok = False
        try:
            ok = (username == (rec.get("username") or "")) and check_password_hash(
                (rec.get("password_hash") or ""), password
            )
        except Exception:
            ok = False

        if not ok:
            return render_template("login.html", error="Неверный логин или пароль", username=username)

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

        rec = _auth_load() or {}
        try:
            ok = (username == (rec.get("username") or "")) and check_password_hash(
                (rec.get("password_hash") or ""), password
            )
        except Exception:
            ok = False
        if not ok:
            return jsonify({"ok": False, "error": "invalid_credentials"}), 401

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

