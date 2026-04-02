"""Global UI asset routes and frontend build helpers.

These endpoints are intentionally public (like /static) so they work on
/login and /setup pages.

We register routes directly on the Flask app (not via Blueprint) to preserve
endpoint names referenced from templates via url_for(...).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any

from flask import Flask, Response, current_app, request, send_file, url_for

_SOURCE_ENTRIES = {
    "panel": "js/pages/panel.entry.js",
    "xkeen": "js/pages/xkeen.entry.js",
    "backups": "js/pages/backups.entry.js",
    "devtools": "js/pages/devtools.entry.js",
    "mihomo_generator": "js/pages/mihomo_generator.entry.js",
}

_BUILD_DIRNAME = "frontend-build"
_BUILD_MANIFEST_FILENAME = f"{_BUILD_DIRNAME}/.vite/manifest.json"
_BUILD_PAGES_ENV = "XKEEN_UI_FRONTEND_BUILD_PAGES"
_ALL_TOKENS = {"1", "true", "yes", "on", "all", "*"}
_APP_EXTENSIONS_KEY = "xkeen_ui_assets"


_IMMUTABLE_MAX_AGE_SECONDS = 31536000
_HASHED_BUILD_ASSET_RE = re.compile(
    rf"^(?:{re.escape(_BUILD_DIRNAME)}/)?assets/.+\-[A-Za-z0-9_\-]{{8,}}\.[A-Za-z0-9]+$"
)
_HTML_MIME_TYPES = {"text/html", "application/xhtml+xml"}
_JSON_MIME_TYPES = {"application/json", "application/ld+json"}
_API_PATH_PREFIXES = ("/api/", "/routing/", "/remotefs/", "/fs/")


def _normalize_static_filename(filename: str | None) -> str:
    return str(filename or "").strip().lstrip("/")


def is_hashed_build_asset_filename(filename: str | None) -> bool:
    normalized = _normalize_static_filename(filename)
    if not normalized:
        return False
    return bool(_HASHED_BUILD_ASSET_RE.match(normalized))


def is_hashed_build_asset_path(path: str | None) -> bool:
    raw = str(path or "").strip()
    if not raw:
        return False
    parts = raw.split("/static/", 1)
    if len(parts) == 2:
        raw = parts[1]
    raw = raw.lstrip("/")
    return is_hashed_build_asset_filename(raw)


def get_static_asset_max_age(filename: str | None) -> int:
    if is_hashed_build_asset_filename(filename):
        return _IMMUTABLE_MAX_AGE_SECONDS
    return 0


def _is_api_like_response(resp: Response) -> bool:
    try:
        if (resp.mimetype or "") in _JSON_MIME_TYPES or bool(getattr(resp, "is_json", False)):
            return True
    except Exception:
        pass

    try:
        path = str(getattr(request, "path", "") or "")
    except Exception:
        path = ""

    return any(path.startswith(prefix) for prefix in _API_PATH_PREFIXES)


def _is_html_response(resp: Response) -> bool:
    try:
        return (resp.mimetype or "") in _HTML_MIME_TYPES
    except Exception:
        return False


def apply_response_cache_policy(resp: Response) -> Response:
    if resp is None:
        return resp

    try:
        path = str(getattr(request, "path", "") or "")
    except Exception:
        path = ""

    if is_hashed_build_asset_path(path):
        try:
            resp.headers["Cache-Control"] = f"public, max-age={_IMMUTABLE_MAX_AGE_SECONDS}, immutable"
            resp.headers.pop("Pragma", None)
        except Exception:
            pass
        return resp

    if path.startswith("/static/"):
        return resp

    if _is_html_response(resp) or _is_api_like_response(resp):
        return _no_cache(resp)

    return resp


def _no_cache(resp: Response) -> Response:
    try:
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["X-Content-Type-Options"] = "nosniff"
    except Exception:
        pass
    return resp


def _parse_build_pages(raw: str | None) -> set[str] | None:
    value = str(raw or "").strip().lower()
    if not value:
        return set()
    if value in _ALL_TOKENS:
        return None
    return {
        token
        for token in re.split(r"[\s,;]+", value)
        if token and token not in _ALL_TOKENS
    }


@dataclass
class FrontendAssetHelper:
    static_folder: str
    build_pages_env: str = _BUILD_PAGES_ENV
    build_dirname: str = _BUILD_DIRNAME
    manifest_filename: str = _BUILD_MANIFEST_FILENAME

    def __post_init__(self) -> None:
        self.static_folder = str(self.static_folder or "")
        self._manifest_cache_path: str | None = None
        self._manifest_cache_mtime_ns: int | None = None
        self._manifest_cache_data: dict[str, dict[str, Any]] | None = None

    def iter_known_frontend_entries(self) -> tuple[str, ...]:
        return tuple(_SOURCE_ENTRIES.keys())

    def normalize_entry_name(self, entry_name: str) -> str:
        name = str(entry_name or "").strip()
        if name not in _SOURCE_ENTRIES:
            raise KeyError(f"Unknown frontend entry: {entry_name}")
        return name

    def get_source_entry_filename(self, entry_name: str) -> str:
        return _SOURCE_ENTRIES[self.normalize_entry_name(entry_name)]

    def get_manifest_path(self) -> str:
        return os.path.join(self.static_folder, self.manifest_filename)

    def get_enabled_build_pages(self) -> set[str] | None:
        return _parse_build_pages(os.environ.get(self.build_pages_env))

    def is_build_enabled_for_page(self, entry_name: str) -> bool:
        name = self.normalize_entry_name(entry_name)
        enabled_pages = self.get_enabled_build_pages()
        if enabled_pages == set():
            return False
        if enabled_pages is not None and name not in enabled_pages:
            return False
        return True

    def _load_manifest(self) -> dict[str, dict[str, Any]]:
        manifest_path = self.get_manifest_path()
        if not self.static_folder or not os.path.isfile(manifest_path):
            self._manifest_cache_path = manifest_path
            self._manifest_cache_mtime_ns = None
            self._manifest_cache_data = {}
            return {}

        try:
            manifest_mtime_ns = os.stat(manifest_path).st_mtime_ns
        except OSError:
            manifest_mtime_ns = None

        if (
            self._manifest_cache_data is not None
            and self._manifest_cache_path == manifest_path
            and self._manifest_cache_mtime_ns == manifest_mtime_ns
        ):
            return self._manifest_cache_data

        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except Exception:
            payload = {}

        if not isinstance(payload, dict):
            payload = {}

        normalized: dict[str, dict[str, Any]] = {}
        for key, value in payload.items():
            if isinstance(key, str) and isinstance(value, dict):
                normalized[key] = value

        self._manifest_cache_path = manifest_path
        self._manifest_cache_mtime_ns = manifest_mtime_ns
        self._manifest_cache_data = normalized
        return normalized

    def get_manifest_entry(self, entry_name: str) -> dict[str, Any] | None:
        source_filename = self.get_source_entry_filename(entry_name)
        manifest = self._load_manifest()
        candidates = (
            source_filename,
            f"static/{source_filename}",
            f"/{source_filename}",
            f"/static/{source_filename}",
        )
        for key in candidates:
            value = manifest.get(key)
            if isinstance(value, dict):
                return value
        return None

    def get_build_entry_filename(self, entry_name: str) -> str | None:
        entry = self.get_manifest_entry(entry_name)
        build_file = str((entry or {}).get("file") or "").strip()
        if not build_file:
            return None
        build_file = build_file.lstrip("/")
        if build_file.startswith(f"{self.build_dirname}/"):
            return build_file
        return f"{self.build_dirname}/{build_file}"

    def get_build_entry_path(self, entry_name: str) -> str | None:
        build_filename = self.get_build_entry_filename(entry_name)
        if not build_filename or not self.static_folder:
            return None
        return os.path.join(self.static_folder, build_filename)

    def build_entry_exists(self, entry_name: str) -> bool:
        build_path = self.get_build_entry_path(entry_name)
        return bool(build_path and os.path.isfile(build_path))

    def build_entry_uses_legacy_loader(self, entry_name: str) -> bool:
        build_path = self.get_build_entry_path(entry_name)
        if not build_path or not os.path.isfile(build_path):
            return False

        try:
            with open(build_path, "r", encoding="utf-8") as f:
                text = f.read()
        except Exception:
            return False

        return "legacy_script_loader" in text or "bootLegacyEntry(" in text

    def should_use_build_entry(self, entry_name: str) -> bool:
        if not self.is_build_enabled_for_page(entry_name):
            return False
        if not self.build_entry_exists(entry_name):
            return False
        if self.build_entry_uses_legacy_loader(entry_name):
            return False
        return True

    def frontend_page_entry_url(self, entry_name: str) -> str:
        filename = (
            self.get_build_entry_filename(entry_name)
            if self.should_use_build_entry(entry_name)
            else self.get_source_entry_filename(entry_name)
        )
        return url_for("static", filename=filename)


def _get_frontend_asset_helper() -> FrontendAssetHelper:
    helper = current_app.extensions.get(_APP_EXTENSIONS_KEY)
    if not isinstance(helper, FrontendAssetHelper):
        raise RuntimeError("FrontendAssetHelper is not initialized")
    return helper


def init_ui_assets_helpers(app: Flask) -> FrontendAssetHelper:
    helper = FrontendAssetHelper(static_folder=str(getattr(app, "static_folder", "") or ""))
    app.extensions[_APP_EXTENSIONS_KEY] = helper
    app.add_template_global(helper.frontend_page_entry_url, name="frontend_page_entry_url")
    return helper


def frontend_page_entry_url(entry_name: str) -> str:
    return _get_frontend_asset_helper().frontend_page_entry_url(entry_name)


def register_ui_assets_routes(app: Flask, *, UI_STATE_DIR: str, devtools_service=None) -> None:
    """Register /ui/* asset endpoints and frontend build helpers."""

    if not isinstance(app.extensions.get(_APP_EXTENSIONS_KEY), FrontendAssetHelper):
        init_ui_assets_helpers(app)

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
            resp = Response('{"ok":false,"error":"branding_failed"}\n', mimetype="application/json")

        return _no_cache(resp)
