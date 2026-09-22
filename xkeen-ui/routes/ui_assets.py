"""Global UI asset routes and frontend build helpers.

These endpoints are intentionally public (like /static) so they work on
/login and /setup pages.

We register routes directly on the Flask app (not via Blueprint) to preserve
endpoint names referenced from templates via url_for(...).
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import time
import zlib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from flask import Flask, Response, current_app, request, send_file, url_for
from werkzeug.utils import safe_join

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
    "enableWebgl": True,
}


_IMMUTABLE_MAX_AGE_SECONDS = 31536000
# Хэш в имени — обещание, что содержимое больше не изменится: новая сборка
# придёт под новым именем. Поэтому решает имя файла, а не каталог.
_HASHED_ASSET_BASENAME_RE = re.compile(r"^.+\-[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9]+$")

# ...но только внутри каталогов сборки. В остальной статике дефис с восемью
# буквами ничего не обещает: `auth-operator.css` правят на месте, и вечный кэш
# оставил бы пользователя со старой панелью.
#
# Редактор Monaco лежит своим каталогом, а не в `assets/`, и собран с хэшами —
# без него 15 МБ перепроверялись при каждой загрузке. При этом внутри того же
# каталога есть файлы без хэша (`loader.js`, `editor.main.js`,
# `monaco.contribution.js`, `nls.messages.*`), и они обязаны остаться
# перепроверяемыми, иначе после обновления браузер удержит старый загрузчик.
_MONACO_DIRNAME = "monaco-editor"
_IMMUTABLE_ASSET_ROOTS = (
    f"{_BUILD_DIRNAME}/assets/",
    "assets/",
    f"{_MONACO_DIRNAME}/",
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

# Static pages that are loaded inside modal iframes within the same UI.
# For these paths X-Frame-Options is set to SAMEORIGIN instead of DENY.
_SAMEORIGIN_FRAME_PATHS: frozenset[str] = frozenset({
    "/static/routing-comments-help.html",
})


def _normalize_static_filename(filename: str | None) -> str:
    return str(filename or "").strip().lstrip("/")


def is_hashed_build_asset_filename(filename: str | None) -> bool:
    normalized = _normalize_static_filename(filename)
    if not normalized:
        return False
    if not normalized.startswith(_IMMUTABLE_ASSET_ROOTS):
        return False
    return bool(_HASHED_ASSET_BASENAME_RE.match(normalized.rsplit("/", 1)[-1]))


def is_hashed_build_asset_path(path: str | None) -> bool:
    raw = str(path or "").strip()
    if not raw:
        return False
    parts = raw.split("/static/", 1)
    if len(parts) == 2:
        raw = parts[1]
    raw = raw.lstrip("/")
    return is_hashed_build_asset_filename(raw)


# Короткое окно без перепроверки для остальной статики.
#
# Хэша в имени у неё нет, поэтому вечный кэш ей не положен. Но и `max-age=0`
# дорого: повторный вход в панель — это под две сотни условных запросов (122
# из них — модули `static/js`), и каждый стоит процессору роутера отдельной
# обработки, хотя тело приходит пустое. Окно снимает этот поток, пока человек
# ходит по вкладкам.
_STATIC_CACHE_SECONDS_ENV = "XKEEN_UI_STATIC_CACHE_SECONDS"
_DEFAULT_STATIC_CACHE_SECONDS = 600

# ...но только для файлов, которых давно не касались. Штатный способ отладки в
# этом проекте — правка прямо на роутере по SSH, а обновление панели переписывает
# файлы целиком. И там, и там mtime становится свежим, и такой файл мы продолжаем
# отдавать с перепроверкой: изменения видны сразу, без жёсткой перезагрузки.
_STATIC_RECENTLY_CHANGED_SECONDS = 3600


def _static_cache_seconds() -> int:
    raw = str(os.environ.get(_STATIC_CACHE_SECONDS_ENV) or "").strip()
    if not raw:
        return _DEFAULT_STATIC_CACHE_SECONDS
    try:
        return max(0, int(raw))
    except ValueError:
        return _DEFAULT_STATIC_CACHE_SECONDS


def get_static_asset_max_age(
    filename: str | None,
    static_folder: str | os.PathLike[str] | None = None,
) -> int:
    if is_hashed_build_asset_filename(filename):
        return _IMMUTABLE_MAX_AGE_SECONDS

    window = _static_cache_seconds()
    root = str(static_folder or "").strip()
    # Без известного корня возраст файла не проверить, а кэшировать вслепую
    # нельзя: отвечаем как раньше.
    if window <= 0 or not root:
        return 0

    try:
        if _is_development_runtime():
            return 0
    except Exception:
        return 0

    try:
        target = safe_join(root, _normalize_static_filename(filename))
        if not target or not os.path.isfile(target):
            return 0
        changed_ago = time.time() - os.stat(target).st_mtime
    except Exception:
        return 0

    if changed_ago < _STATIC_RECENTLY_CHANGED_SECONDS:
        return 0
    return window


# Предсжатая статика.
#
# gevent pywsgi ответы не сжимает, а жать почти мегабайт CSS на лету на
# процессоре роутера дороже сэкономленного трафика. Поэтому .gz кладёт рядом
# упаковщик (scripts/build_user_archive.py), а здесь мы лишь решаем, можно ли
# его отдать.
_GZIP_SIBLING_SUFFIX = ".gz"
_VARY_ACCEPT_ENCODING = "Accept-Encoding"


def _encoding_quality(params: str) -> float:
    for param in params.split(";"):
        key, _, value = param.partition("=")
        if key.strip().lower() != "q":
            continue
        try:
            return float(value.strip())
        except ValueError:
            return 0.0
    return 1.0


def client_accepts_gzip(accept_encoding: str | None) -> bool:
    """Разобрать Accept-Encoding так, чтобы явный отказ от gzip был услышан."""

    raw = str(accept_encoding or "").strip()
    if not raw:
        return False

    gzip_quality: float | None = None
    star_quality: float | None = None
    for part in raw.split(","):
        token, _, params = part.strip().partition(";")
        name = token.strip().lower()
        if name == "gzip":
            gzip_quality = _encoding_quality(params)
        elif name == "*":
            star_quality = _encoding_quality(params)

    # `gzip;q=0` — это «именно gzip мне не присылай», и он сильнее любого `*`.
    if gzip_quality is not None:
        return gzip_quality > 0
    if star_quality is not None:
        return star_quality > 0
    return False


def resolve_precompressed_static(
    static_folder: str | os.PathLike[str] | None,
    filename: str | None,
    accept_encoding: str | None,
) -> str | None:
    """Вернуть путь к <файл>.gz, если его можно отдать вместо исходника."""

    if not client_accepts_gzip(accept_encoding):
        return None

    root = str(static_folder or "").strip()
    if not root:
        return None

    try:
        target = safe_join(root, _normalize_static_filename(filename))
    except Exception:
        return None
    if not target:
        return None

    source = Path(target)
    packed = source.with_name(source.name + _GZIP_SIBLING_SUFFIX)
    try:
        if not source.is_file() or not packed.is_file():
            return None
        # Исходник новее сжатой копии — значит файл правили, а .gz остался
        # прежним: штатный способ отладки в этом проекте — правка прямо на
        # роутере по SSH. Отдать такую копию значит показать старую панель.
        #
        # Обновление под этот признак не попадает: install.sh раскладывает
        # архив без `--delete` (через rsync, а где его нет — через `cp -r`,
        # который времена не сохраняет вовсе) и после копирования подтягивает
        # время каждой .gz к её исходнику.
        if packed.stat().st_mtime < source.stat().st_mtime:
            return None
    except OSError:
        return None

    return str(packed)


def add_vary_accept_encoding(resp: Response) -> Response:
    """Без Vary промежуточный кэш отдаст сжатое тело тому, кто его не просил."""

    if resp is None:
        return resp
    try:
        existing = str(resp.headers.get("Vary", "") or "").strip()
        tokens = {token.strip().lower() for token in existing.split(",") if token.strip()}
        if "accept-encoding" in tokens or "*" in tokens:
            return resp
        resp.headers["Vary"] = (
            f"{existing}, {_VARY_ACCEPT_ENCODING}" if existing else _VARY_ACCEPT_ENCODING
        )
    except Exception:
        pass
    return resp


def send_precompressed_static(
    static_folder: str | os.PathLike[str] | None,
    filename: str | None,
    accept_encoding: str | None,
    max_age: int | None = None,
) -> Response | None:
    packed = resolve_precompressed_static(static_folder, filename, accept_encoding)
    if packed is None:
        return None

    # Тип содержимого берём по исходному имени: по .gz Flask выдал бы
    # application/gzip, и браузер предложил бы скачать файл вместо разбора.
    mimetype = mimetypes.guess_type(_normalize_static_filename(filename))[0]
    resp = send_file(
        packed,
        mimetype=mimetype or "application/octet-stream",
        conditional=True,
        max_age=max_age,
    )
    resp.headers["Content-Encoding"] = "gzip"
    return add_vary_accept_encoding(resp)


class PrecompressedStaticMixin:
    """Отдаёт предсжатый <файл>.gz вместо исходника, когда это безопасно.

    Ставится перед Flask в списке баз, чтобы перекрыть штатный
    ``send_static_file``. Любой сбой на сжатом пути откатывает нас к обычной
    отдаче, поэтому включение предсжатия не может уронить статику.
    """

    def send_static_file(self, filename):  # type: ignore[override]
        try:
            resp = send_precompressed_static(
                self.static_folder,
                filename,
                request.headers.get("Accept-Encoding"),
                self.get_send_file_max_age(filename),
            )
            if resp is not None:
                return resp
        except Exception:
            pass
        return add_vary_accept_encoding(super().send_static_file(filename))


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
        return add_vary_accept_encoding(resp)

    if path.startswith("/static/"):
        return add_vary_accept_encoding(resp)

    if _is_html_response(resp) or _is_api_like_response(resp):
        return _no_cache(resp)

    return resp


# Сжатие ответов на лету.
#
# Предсжатие закрывает только файлы на диске, а документ панели собирается на
# каждый запрос: около 500 КБ, которые до сих пор уходили по сети как есть.
# Замер на роутере 22.09.2026 (ARMv8, /opt/bin/python3): уровень 1 стоит 11 мс и
# сжимает это тело в пять раз, уровень 6 — 32 мс и в 6,6 раза, девятка — 60 мс
# ради лишних семисот байт. Берём первый: gevent однопоточный, и эти
# миллисекунды стоят всему циклу событий, а не только текущему клиенту.
_GZIP_MIN_BYTES_ENV = "XKEEN_UI_GZIP_MIN_BYTES"
_DEFAULT_GZIP_MIN_BYTES = 32768
_GZIP_LEVEL = 1


def _gzip_min_bytes() -> int:
    """Порог сжатия; 0 выключает его целиком — аварийная ручка для слабых машин."""

    raw = str(os.environ.get(_GZIP_MIN_BYTES_ENV) or "").strip()
    if not raw:
        return _DEFAULT_GZIP_MIN_BYTES
    try:
        return max(0, int(raw))
    except ValueError:
        return _DEFAULT_GZIP_MIN_BYTES


def compress_response_if_worthwhile(resp: Response) -> Response:
    """Сжать крупный HTML-ответ, если клиент об этом просил."""

    if resp is None:
        return resp

    threshold = _gzip_min_bytes()
    if threshold <= 0:
        return resp

    try:
        if resp.status_code != 200 or "Content-Encoding" in resp.headers:
            return resp
        if not _is_html_response(resp):
            return resp
        # Потоковый ответ (журналы, выгрузка) втягивать в память нельзя: его
        # размер заранее неизвестен, а смысл потока — не держать его целиком.
        if resp.is_streamed or getattr(resp, "direct_passthrough", False):
            return resp
    except Exception:
        return resp

    try:
        path = str(getattr(request, "path", "") or "")
    except Exception:
        path = ""
    # Рядом со статикой уже лежит готовая .gz, и отдаёт её отдельная ветка.
    if path.startswith("/static/"):
        return resp

    try:
        if not client_accepts_gzip(request.headers.get("Accept-Encoding")):
            return resp
    except Exception:
        return resp

    try:
        payload = resp.get_data()
    except Exception:
        return resp
    if len(payload) < threshold:
        return resp

    try:
        packer = zlib.compressobj(_GZIP_LEVEL, zlib.DEFLATED, 31)
        packed = packer.compress(payload) + packer.flush()
    except Exception:
        return resp

    try:
        # set_data сам приводит Content-Length к новому телу.
        resp.set_data(packed)
        resp.headers["Content-Encoding"] = "gzip"
    except Exception:
        return resp

    return add_vary_accept_encoding(resp)


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
        # Allow same-origin framing for specific static pages that are loaded
        # inside modal iframes within the same UI.  This intentionally wins over
        # the conservative DENY baseline below for the whitelisted help page.
        try:
            if request.path in _SAMEORIGIN_FRAME_PATHS:
                resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        except Exception:
            pass

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
        filename = self.resolve_frontend_page_entry_filename(entry_name)
        # Bridge files intentionally keep stable names.  Give every deployment
        # a revisioned URL anyway, otherwise a browser may combine an old bridge
        # with newly installed source modules until the user performs Ctrl+F5.
        try:
            revision = os.stat(str(Path(self.static_folder) / filename)).st_mtime_ns
        except OSError:
            revision = 0
        return url_for("static", filename=filename, v=str(revision))

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
