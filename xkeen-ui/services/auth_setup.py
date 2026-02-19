import json
import os
import uuid

from typing import Any, Dict, Optional

from flask import request, jsonify, redirect, url_for, session

from core.paths import UI_STATE_DIR


# --------------------
# Auth / first-run setup
# --------------------

# Auth state is stored in UI_STATE_DIR so it persists across restarts.
AUTH_DIR = UI_STATE_DIR
AUTH_FILE = os.path.join(AUTH_DIR, "auth.json")
SECRET_KEY_FILE = os.path.join(AUTH_DIR, "secret.key")


def _atomic_write(path: str, data: str, *, mode: int = 0o600) -> None:
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    tmp = f"{path}.tmp.{uuid.uuid4().hex}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(data)
        f.flush()
        try:
            os.fsync(f.fileno())
        except Exception:
            pass
    try:
        os.chmod(tmp, mode)
    except Exception:
        pass
    os.replace(tmp, path)


def _load_or_create_secret_key() -> str:
    """Load secret key from disk, or create a new one.

    This is critical for session security. We keep it on disk with 0600 perms.
    """
    try:
        with open(SECRET_KEY_FILE, "r", encoding="utf-8") as f:
            key = (f.read() or "").strip()
            if key:
                return key
    except FileNotFoundError:
        pass
    except Exception:
        # If the file is unreadable for some reason, fall back to a fresh key.
        pass

    # Create a new random key
    try:
        raw = os.urandom(32)
    except Exception:
        # Very old/broken environments – still better than a constant string.
        raw = (uuid.uuid4().hex + uuid.uuid4().hex).encode("utf-8")
    key = raw.hex()
    try:
        _atomic_write(SECRET_KEY_FILE, key + "\n", mode=0o600)
    except Exception:
        # As a last resort: keep the generated key in memory.
        pass
    return key


def _auth_load() -> Optional[Dict[str, Any]]:
    try:
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        return data
    except FileNotFoundError:
        return None
    except Exception:
        return None


def auth_is_configured() -> bool:
    data = _auth_load() or {}
    return bool((data.get("username") or "").strip()) and bool((data.get("password_hash") or "").strip())


def _ensure_csrf_token() -> str:
    tok = session.get("csrf")
    if not tok:
        tok = uuid.uuid4().hex
        session["csrf"] = tok
    return tok


def _is_logged_in() -> bool:
    return bool(session.get("auth"))


def _json_unauthorized():
    return jsonify({"ok": False, "error": "unauthorized"}), 401


def _csrf_failed():
    return jsonify({"ok": False, "error": "csrf_failed"}), 403


def _check_csrf() -> bool:
    expected = session.get("csrf")
    if not expected:
        return False

    # HTML forms
    form_tok = (request.form.get("csrf_token") or "").strip()
    if form_tok and form_tok == expected:
        return True

    # JS fetches
    hdr = (request.headers.get("X-CSRF-Token") or "").strip()
    if hdr and hdr == expected:
        return True

    return False


def init_auth(app) -> None:
    """Initialize auth/CSRF hooks for the Flask app.

    Keeps behaviour 1:1 with previous inline implementation in app.py.
    """

    app.secret_key = os.environ.get("XKEEN_UI_SECRET_KEY") or _load_or_create_secret_key()

    # Cookie hardening (HTTPS may be unavailable on routers; keep Secure off by default)
    app.config.setdefault("SESSION_COOKIE_HTTPONLY", True)
    app.config.setdefault("SESSION_COOKIE_SAMESITE", "Lax")

    @app.context_processor
    def _inject_auth_context():
        # Available in all templates
        v = 0
        try:
            cpath = os.path.join(UI_STATE_DIR, "custom_theme.css")
            if os.path.isfile(cpath):
                v = int(os.path.getmtime(cpath) or 0)
        except Exception:
            v = 0

        # Independent themes (optional)
        term_v = 0
        cm_v = 0
        try:
            tp = os.path.join(UI_STATE_DIR, "terminal_theme.css")
            if os.path.isfile(tp):
                term_v = int(os.path.getmtime(tp) or 0)
        except Exception:
            term_v = 0
        try:
            cp = os.path.join(UI_STATE_DIR, "codemirror_theme.css")
            if os.path.isfile(cp):
                cm_v = int(os.path.getmtime(cp) or 0)
        except Exception:
            cm_v = 0

        # Global Custom CSS (optional) — stored in UI_STATE_DIR/custom.css.
        css_v = 0
        css_enabled = False
        try:
            css_path = os.path.join(UI_STATE_DIR, "custom.css")
            css_disabled_flag = os.path.join(UI_STATE_DIR, "custom_css.disabled")
            if os.path.isfile(css_path):
                css_v = int(os.path.getmtime(css_path) or 0)
                css_enabled = not os.path.isfile(css_disabled_flag)
        except Exception:
            css_v = 0
            css_enabled = False

        # Safe mode (URL query): ?safe=1
        safe_mode = False
        try:
            sv = str(request.args.get("safe", "") or "").strip().lower()
            safe_mode = sv in ("1", "true", "yes", "on", "y")
        except Exception:
            safe_mode = False

        panel_sections = str(os.environ.get("XKEEN_UI_PANEL_SECTIONS_WHITELIST") or "").strip()
        devtools_sections = str(os.environ.get("XKEEN_UI_DEVTOOLS_SECTIONS_WHITELIST") or "").strip()

        return {
            "panel_sections_whitelist": panel_sections,
            "devtools_sections_whitelist": devtools_sections,
            "csrf_token": _ensure_csrf_token(),
            "auth_user": session.get("user"),
            "auth_configured": auth_is_configured(),
            "custom_theme_v": v,
            "terminal_theme_v": term_v,
            "codemirror_theme_v": cm_v,
            "custom_css_v": css_v,
            "custom_css_enabled": bool(css_enabled),
            "safe_mode": bool(safe_mode),
        }

    @app.before_request
    def _auth_guard():
        """Global access control.

        - If credentials are not configured: force /setup.
        - If configured but user is not logged in: force /login.
        - For mutating requests (POST/PUT/DELETE/PATCH) when logged in: require CSRF token.
        """

        path = request.path or ""

        # Always allow static assets
        if path.startswith("/static/") or path in (
            "/ui/custom-theme.css",
            "/ui/custom.css",
            "/ui/branding.json",
            "/ui/terminal-theme.css",
            "/ui/codemirror-theme.css",
        ):
            return None

        # Auth endpoints must be reachable
        auth_open_paths = {
            "/login",
            "/logout",
            "/setup",
            "/api/auth/status",
            "/api/auth/login",
            "/api/auth/logout",
            "/api/auth/setup",
        }
        if path in auth_open_paths:
            return None

        # If first-run setup is not done yet – force setup
        if not auth_is_configured():
            if path.startswith("/api/") or path.startswith("/ws/"):
                return jsonify({"ok": False, "error": "not_configured"}), 428
            return redirect(url_for("setup"))

        # If configured but not logged in – force login
        if not _is_logged_in():
            if path.startswith("/api/") or path.startswith("/ws/"):
                return _json_unauthorized()
            return redirect(url_for("login", next=path))

        # Logged in: CSRF protection for mutating calls
        if request.method in ("POST", "PUT", "DELETE", "PATCH"):
            if not _check_csrf():
                if path.startswith("/api/"):
                    return _csrf_failed()
                return "csrf_failed", 403

        return None
