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
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
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
_SOURCE_FALLBACK_ENV = "XKEEN_UI_FRONTEND_SOURCE_FALLBACK"
_TRUE_TOKENS = {"1", "true", "yes", "on"}
_FALSE_TOKENS = {"0", "false", "no", "off"}
_APP_EXTENSIONS_KEY = "xkeen_ui_assets"


_PAGE_CONFIG_CONTRACT_VERSION = 1
_PAGE_CONFIG_SECTION_DEFAULTS = {
    "panelWhitelist": None,
    "devtoolsWhitelist": None,
}
_PAGE_CONFIG_FLAG_DEFAULTS = {
    "hasXray": False,
    "hasMihomo": False,
    "isMips": False,
    "multiCore": False,
    "mihomoConfigExists": False,
}
_PAGE_CONFIG_CORE_DEFAULTS = {
    "available": [],
    "detected": [],
    "uiFallback": False,
}
_PAGE_CONFIG_FILE_DEFAULTS = {
    "routing": "",
    "inbounds": "",
    "outbounds": "",
    "mihomo": "",
}
_PAGE_CONFIG_FILE_MANAGER_DEFAULTS = {
    "rightDefault": "",
}
_PAGE_CONFIG_GITHUB_DEFAULTS = {
    "repoUrl": "",
}
_PAGE_CONFIG_STATIC_DEFAULTS = {
    "base": "/static/",
    "version": "",
}
_PAGE_CONFIG_RUNTIME_DEFAULTS = {
    "debug": False,
}
_PAGE_CONFIG_TERMINAL_DEFAULTS = {
    "supportsPty": False,
    "enableOptionalAddons": False,
    "enableLigatures": False,
    "enableWebgl": False,
}


_IMMUTABLE_MAX_AGE_SECONDS = 31536000
_HASHED_BUILD_ASSET_RE = re.compile(
    rf"^(?:{re.escape(_BUILD_DIRNAME)}/)?assets/.+\-[A-Za-z0-9_\-]{{8,}}\.[A-Za-z0-9]+$"
)
_HTML_MIME_TYPES = {"text/html", "application/xhtml+xml"}
_JSON_MIME_TYPES = {"application/json", "application/ld+json"}
_API_PATH_PREFIXES = ("/api/", "/routing/", "/remotefs/", "/fs/")
_BASELINE_SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "X-Content-Type-Options": "nosniff",
}


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


def apply_response_security_headers(resp: Response) -> Response:
    """Attach a conservative app-wide browser security-header baseline.

    More specific routes may set stricter values before this hook; we preserve
    them via ``setdefault`` so Mihomo proxy hardening and future endpoint-
    specific policies continue to win.
    """
    if resp is None:
        return resp

    try:
        for key, value in _BASELINE_SECURITY_HEADERS.items():
            resp.headers.setdefault(key, value)
    except Exception:
        pass
    return resp


def _normalize_page_config_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return {str(key): item for key, item in value.items() if isinstance(key, str)}
    return {}


def _normalize_page_config_string(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _normalize_page_config_path_string(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, Path):
        return value.as_posix()
    return str(value).replace('\\', '/')


def _normalize_page_config_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    normalized = str(value).strip().lower()
    if not normalized:
        return default
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return bool(value)


def _normalize_page_config_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return list(value)
    if isinstance(value, tuple | set):
        return list(value)
    return []


def _build_page_config_group(defaults: Mapping[str, Any], overrides: Any, *, normalizers: Mapping[str, Any] | None = None) -> dict[str, Any]:
    normalized_overrides = _normalize_page_config_mapping(overrides)
    result: dict[str, Any] = {}
    for key, default_value in defaults.items():
        value = normalized_overrides.get(key, default_value)
        normalizer = (normalizers or {}).get(key)
        result[key] = normalizer(value, default_value) if callable(normalizer) else value

    for key, value in normalized_overrides.items():
        if key in result:
            continue
        result[key] = value

    return result


def _parse_optional_bool_env(raw: str | None) -> bool | None:
    value = str(raw or "").strip().lower()
    if not value:
        return None
    if value in _TRUE_TOKENS:
        return True
    if value in _FALSE_TOKENS:
        return False
    return None


def _is_development_runtime() -> bool:
    if _parse_optional_bool_env(os.environ.get("XKEEN_DEV")) is True:
        return True
    if _parse_optional_bool_env(os.environ.get("FLASK_DEBUG")) is True:
        return True
    if str(os.environ.get("FLASK_ENV", "")).strip().lower() == "development":
        return True

    try:
        app = current_app
    except Exception:
        app = None

    if app is None:
        return False

    try:
        if bool(getattr(app, "debug", False)) or bool(getattr(app, "testing", False)):
            return True
    except Exception:
        pass

    try:
        config = getattr(app, "config", None)
        if isinstance(config, Mapping) and _parse_optional_bool_env(config.get("XKEEN_DEV")) is True:
            return True
        if isinstance(config, Mapping) and bool(config.get("TESTING")):
            return True
    except Exception:
        pass

    return False


@dataclass(frozen=True)
class FrontendBuildBridgeResolution:
    entry_name: str
    source_filename: str
    build_enabled: bool
    manifest_entry: dict[str, Any] | None
    build_filename: str | None
    build_path: str | None
    build_exists: bool
    source_fallback_enabled: bool

    @property
    def fallback_reason(self) -> str | None:
        if not self.build_enabled:
            return "build_disabled"
        if not self.build_filename or not self.build_exists:
            return "missing_build_entry"
        return None

    @property
    def should_use_build(self) -> bool:
        return self.fallback_reason is None

    @property
    def should_use_source_fallback(self) -> bool:
        return self.fallback_reason is not None and self.source_fallback_enabled

    @property
    def selected_filename(self) -> str:
        if self.should_use_build and self.build_filename:
            return self.build_filename
        if self.should_use_source_fallback:
            return self.source_filename
        reason = self.fallback_reason or "build_required"
        raise RuntimeError(
            f"Frontend build-only mode requires a valid build entry for {self.entry_name!r} ({reason}). "
            "Enable XKEEN_UI_FRONTEND_SOURCE_FALLBACK=1 only for dev/test/debug."
        )


@dataclass
class FrontendAssetHelper:
    static_folder: str
    source_fallback_env: str = _SOURCE_FALLBACK_ENV
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

    def is_source_fallback_enabled(self) -> bool:
        explicit = _parse_optional_bool_env(os.environ.get(self.source_fallback_env))
        if explicit is not None:
            return explicit
        return _is_development_runtime()

    def is_build_enabled_for_page(self, entry_name: str) -> bool:
        self.normalize_entry_name(entry_name)
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

    def _normalize_build_entry_filename(self, build_file: Any) -> str | None:
        normalized = str(build_file or "").strip().lstrip("/")
        if not normalized:
            return None
        if normalized.startswith(f"{self.build_dirname}/"):
            return normalized
        return f"{self.build_dirname}/{normalized}"

    def get_build_entry_filename(self, entry_name: str) -> str | None:
        entry = self.get_manifest_entry(entry_name)
        return self._normalize_build_entry_filename((entry or {}).get("file"))

    def _build_entry_path_from_filename(self, build_filename: str | None) -> str | None:
        if not build_filename or not self.static_folder:
            return None
        return str(Path(self.static_folder) / build_filename)

    def get_build_entry_path(self, entry_name: str) -> str | None:
        return self._build_entry_path_from_filename(self.get_build_entry_filename(entry_name))

    def _build_entry_path_exists(self, build_path: str | None) -> bool:
        return bool(build_path and os.path.isfile(build_path))

    def build_entry_exists(self, entry_name: str) -> bool:
        return self._build_entry_path_exists(self.get_build_entry_path(entry_name))


    def get_build_bridge_resolution(self, entry_name: str) -> FrontendBuildBridgeResolution:
        name = self.normalize_entry_name(entry_name)
        source_filename = self.get_source_entry_filename(name)
        manifest_entry = self.get_manifest_entry(name)
        build_filename = self._normalize_build_entry_filename((manifest_entry or {}).get("file"))
        build_path = self._build_entry_path_from_filename(build_filename)
        build_exists = self._build_entry_path_exists(build_path)
        return FrontendBuildBridgeResolution(
            entry_name=name,
            source_filename=source_filename,
            build_enabled=self.is_build_enabled_for_page(name),
            manifest_entry=manifest_entry,
            build_filename=build_filename,
            build_path=build_path,
            build_exists=build_exists,
            source_fallback_enabled=self.is_source_fallback_enabled(),
        )

    def should_use_build_entry(self, entry_name: str) -> bool:
        return self.get_build_bridge_resolution(entry_name).should_use_build

    def resolve_frontend_page_entry_filename(self, entry_name: str) -> str:
        return self.get_build_bridge_resolution(entry_name).selected_filename

    def frontend_page_entry_url(self, entry_name: str) -> str:
        return url_for("static", filename=self.resolve_frontend_page_entry_filename(entry_name))

    def frontend_page_config(
        self,
        page_name: str,
        *,
        sections: dict[str, Any] | None = None,
        flags: dict[str, Any] | None = None,
        cores: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        file_manager: dict[str, Any] | None = None,
        github: dict[str, Any] | None = None,
        static: dict[str, Any] | None = None,
        runtime: dict[str, Any] | None = None,
        terminal: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "contractVersion": _PAGE_CONFIG_CONTRACT_VERSION,
            "page": _normalize_page_config_string(page_name).strip(),
            "sections": _build_page_config_group(
                _PAGE_CONFIG_SECTION_DEFAULTS,
                sections,
                normalizers={
                    "panelWhitelist": lambda value, default: value if value is None else _normalize_page_config_string(value, default or ""),
                    "devtoolsWhitelist": lambda value, default: value if value is None else _normalize_page_config_string(value, default or ""),
                },
            ),
            "flags": _build_page_config_group(
                _PAGE_CONFIG_FLAG_DEFAULTS,
                flags,
                normalizers={key: _normalize_page_config_bool for key in _PAGE_CONFIG_FLAG_DEFAULTS},
            ),
            "cores": _build_page_config_group(
                _PAGE_CONFIG_CORE_DEFAULTS,
                cores,
                normalizers={
                    "available": lambda value, default: _normalize_page_config_list(value),
                    "detected": lambda value, default: _normalize_page_config_list(value),
                    "uiFallback": _normalize_page_config_bool,
                },
            ),
            "files": _build_page_config_group(
                _PAGE_CONFIG_FILE_DEFAULTS,
                files,
                normalizers={key: _normalize_page_config_path_string for key in _PAGE_CONFIG_FILE_DEFAULTS},
            ),
            "fileManager": _build_page_config_group(
                _PAGE_CONFIG_FILE_MANAGER_DEFAULTS,
                file_manager,
                normalizers={key: _normalize_page_config_string for key in _PAGE_CONFIG_FILE_MANAGER_DEFAULTS},
            ),
            "github": _build_page_config_group(
                _PAGE_CONFIG_GITHUB_DEFAULTS,
                github,
                normalizers={key: _normalize_page_config_string for key in _PAGE_CONFIG_GITHUB_DEFAULTS},
            ),
            "static": _build_page_config_group(
                _PAGE_CONFIG_STATIC_DEFAULTS,
                static,
                normalizers={key: _normalize_page_config_string for key in _PAGE_CONFIG_STATIC_DEFAULTS},
            ),
            "runtime": _build_page_config_group(
                _PAGE_CONFIG_RUNTIME_DEFAULTS,
                runtime,
                normalizers={key: _normalize_page_config_bool for key in _PAGE_CONFIG_RUNTIME_DEFAULTS},
            ),
            "terminal": _build_page_config_group(
                _PAGE_CONFIG_TERMINAL_DEFAULTS,
                terminal,
                normalizers={key: _normalize_page_config_bool for key in _PAGE_CONFIG_TERMINAL_DEFAULTS},
            ),
        }


def _get_frontend_asset_helper() -> FrontendAssetHelper:
    helper = current_app.extensions.get(_APP_EXTENSIONS_KEY)
    if not isinstance(helper, FrontendAssetHelper):
        raise RuntimeError("FrontendAssetHelper is not initialized")
    return helper


def init_ui_assets_helpers(app: Flask) -> FrontendAssetHelper:
    helper = FrontendAssetHelper(static_folder=str(getattr(app, "static_folder", "") or ""))
    app.extensions[_APP_EXTENSIONS_KEY] = helper
    app.add_template_global(helper.frontend_page_entry_url, name="frontend_page_entry_url")
    app.add_template_global(helper.frontend_page_config, name="frontend_page_config")
    return helper


def frontend_page_entry_url(entry_name: str) -> str:
    return _get_frontend_asset_helper().frontend_page_entry_url(entry_name)


def frontend_page_config(
    page_name: str,
    *,
    sections: dict[str, Any] | None = None,
    flags: dict[str, Any] | None = None,
    cores: dict[str, Any] | None = None,
    files: dict[str, Any] | None = None,
    file_manager: dict[str, Any] | None = None,
    github: dict[str, Any] | None = None,
    static: dict[str, Any] | None = None,
    runtime: dict[str, Any] | None = None,
    terminal: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _get_frontend_asset_helper().frontend_page_config(
        page_name,
        sections=sections,
        flags=flags,
        cores=cores,
        files=files,
        file_manager=file_manager,
        github=github,
        static=static,
        runtime=runtime,
        terminal=terminal,
    )


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
