"""Global UI asset routes extracted from app.py.

These endpoints are intentionally public (like /static) so they work on
/login and /setup pages.

We register routes directly on the Flask app (not via Blueprint) to preserve
endpoint names referenced from templates via url_for(...).
"""

from __future__ import annotations

import json
import os

from flask import Flask, Response, send_file


def _no_cache(resp: Response) -> Response:
    try:
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["X-Content-Type-Options"] = "nosniff"
    except Exception:
        pass
    return resp


def register_ui_assets_routes(app: Flask, *, UI_STATE_DIR: str, devtools_service=None) -> None:
    """Register /ui/* asset endpoints."""

    # Lazy import to avoid any accidental circular deps.
    if devtools_service is None:
        try:
            from services import devtools as devtools_service  # type: ignore
        except Exception:
            devtools_service = None

    @app.get("/ui/custom-theme.css")
    def custom_theme_css():
        """Serve global UI custom theme (generated in DevTools)."""

        path = os.path.join(UI_STATE_DIR, "custom_theme.css")
        # If the user saved a theme in DevTools, keep generated CSS up to date.
        try:
            if devtools_service and os.path.isfile(os.path.join(UI_STATE_DIR, "custom_theme.json")):
                devtools_service.theme_get(UI_STATE_DIR)
        except Exception:
            pass

        try:
            if os.path.isfile(path):
                resp = send_file(path, mimetype="text/css")
            else:
                resp = Response("/* no custom theme */\n", mimetype="text/css")
        except Exception:
            resp = Response("/* custom theme failed */\n", mimetype="text/css")

        return _no_cache(resp)

    @app.get("/ui/custom.css")
    def custom_css():
        """Serve global UI custom CSS (authored in DevTools)."""

        css_path = os.path.join(UI_STATE_DIR, "custom.css")
        disabled_flag = os.path.join(UI_STATE_DIR, "custom_css.disabled")

        try:
            if os.path.isfile(disabled_flag):
                resp = Response("/* custom css disabled */\n", mimetype="text/css")
            elif os.path.isfile(css_path):
                resp = send_file(css_path, mimetype="text/css")
            else:
                resp = Response("/* no custom css */\n", mimetype="text/css")
        except Exception:
            resp = Response("/* custom css failed */\n", mimetype="text/css")

        return _no_cache(resp)

    @app.get("/ui/terminal-theme.css")
    def terminal_theme_css():
        """Serve optional Terminal (xterm.js) theme CSS."""

        path = os.path.join(UI_STATE_DIR, "terminal_theme.css")
        try:
            if devtools_service and os.path.isfile(os.path.join(UI_STATE_DIR, "terminal_theme.json")):
                devtools_service.terminal_theme_get(UI_STATE_DIR)
        except Exception:
            pass

        try:
            if os.path.isfile(path):
                resp = send_file(path, mimetype="text/css")
            else:
                resp = Response("/* no terminal theme */\n", mimetype="text/css")
        except Exception:
            resp = Response("/* terminal theme failed */\n", mimetype="text/css")

        return _no_cache(resp)

    @app.get("/ui/codemirror-theme.css")
    def codemirror_theme_css():
        """Serve optional CodeMirror theme CSS."""

        path = os.path.join(UI_STATE_DIR, "codemirror_theme.css")
        try:
            if devtools_service and os.path.isfile(os.path.join(UI_STATE_DIR, "codemirror_theme.json")):
                devtools_service.codemirror_theme_get(UI_STATE_DIR)
        except Exception:
            pass

        try:
            if os.path.isfile(path):
                resp = send_file(path, mimetype="text/css")
            else:
                resp = Response("/* no codemirror theme */\n", mimetype="text/css")
        except Exception:
            resp = Response("/* codemirror theme failed */\n", mimetype="text/css")

        return _no_cache(resp)

    @app.get("/ui/branding.json")
    def branding_json():
        """Serve global UI branding config (created in DevTools)."""

        try:
            from services import branding as _branding

            data = _branding.branding_get(UI_STATE_DIR)
            payload = {
                "ok": True,
                "version": int(data.get("version") or 0),
                "config": data.get("config") or {},
            }
            resp = Response(json.dumps(payload, ensure_ascii=False), mimetype="application/json")
        except Exception:
            resp = Response("{\"ok\":false,\"error\":\"branding_failed\"}\n", mimetype="application/json")

        return _no_cache(resp)
