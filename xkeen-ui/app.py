#!/opt/bin/python3
import time  # needed for gevent fallback stubs

try:
    from geventwebsocket import WebSocketError  # type: ignore
    import gevent  # type: ignore
    HAS_GEVENT = True
except Exception:  # gevent/geventwebsocket are optional
    HAS_GEVENT = False

    class WebSocketError(Exception):
        """Fallback WebSocketError when geventwebsocket is not installed."""
        pass

    class _GeventStub:
        @staticmethod
        def sleep(seconds: float) -> None:
            time.sleep(seconds)

    gevent = _GeventStub()

# True only when the app is served via gevent-websocket handler (run_server.py).
# When running under Flask/werkzeug dev server, WS routes exist but upgrades are not supported.
WS_RUNTIME = False


def set_ws_runtime(enabled: bool = True) -> None:
    """Mark WebSocket runtime as actually active (called by run_server.py)."""
    global WS_RUNTIME
    WS_RUNTIME = bool(enabled)


from flask import Flask, request, jsonify, render_template, redirect, url_for, session, g, send_file, send_from_directory
import json
import base64
import datetime
import os
import sys
import re
import time
import signal
import shutil
import logging
import subprocess
import select
import codecs
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs, unquote, quote

from typing import Any, Dict, Optional, Tuple
from dataclasses import dataclass, field
import threading
import uuid

# --- Dev/macOS fallback for MIHOMO_ROOT (must happen before importing mihomo_server_core) ---
# On router MIHOMO_ROOT is typically /opt/etc/mihomo.
# In development (e.g. macOS) /opt may exist but be not writable; we must check writability.
def _mh_is_writable_dir(path: str) -> bool:
    try:
        os.makedirs(path, exist_ok=True)
        test_path = os.path.join(path, ".writetest")
        with open(test_path, "w", encoding="utf-8") as f:
            f.write("")
        os.remove(test_path)
        return True
    except Exception:
        return False


if "MIHOMO_ROOT" not in os.environ:
    _router_mh = "/opt/etc/mihomo"
    if _mh_is_writable_dir(_router_mh):
        os.environ["MIHOMO_ROOT"] = _router_mh
    else:
        _here = os.path.dirname(os.path.abspath(__file__))
        _bundled = os.path.join(_here, "opt", "etc", "mihomo")
        if os.path.isdir(_bundled):
            os.environ["MIHOMO_ROOT"] = _bundled
        else:
            _home = os.path.expanduser("~")
            _xdg = os.environ.get("XDG_CONFIG_HOME")
            if _xdg:
                _base = os.path.join(_xdg, "xkeen-ui")
            elif sys.platform == "darwin":
                _base = os.path.join(_home, "Library", "Application Support", "xkeen-ui")
            else:
                _base = os.path.join(_home, ".config", "xkeen-ui")
            os.environ["MIHOMO_ROOT"] = os.path.join(_base, "etc", "mihomo")
        try:
            os.makedirs(os.environ["MIHOMO_ROOT"], exist_ok=True)
        except Exception:
            pass

from mihomo_server_core import CONFIG_PATH, validate_config


def api_error(message: str, status: int = 400, *, ok: bool | None = None):
    """Return a JSON error response in a consistent format.

    If ``ok`` is not None, include it in the payload (typically ``False``).
    """
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    return jsonify(payload), status





from routes_routing import create_routing_blueprint
from routes_backup import create_backups_blueprint
from routes_service import create_service_blueprint
from routes_remotefs import create_remotefs_blueprint
from routes_fs import create_fs_blueprint
from routes_devtools import create_devtools_blueprint
from services.xkeen import append_restart_log as _svc_append_restart_log, read_restart_log as _svc_read_restart_log, restart_xkeen as _svc_restart_xkeen
from services.xray_logs import load_xray_log_config as _svc_load_xray_log_config, tail_lines as _svc_tail_lines, tail_lines_fast as _svc_tail_lines_fast, read_new_lines as _svc_read_new_lines, adjust_log_timezone as _svc_adjust_log_timezone
from services.xray import restart_xray_core as _svc_restart_xray_core
from services import devtools as _svc_devtools
from services.mihomo import (
    parse_state_from_payload as _mihomo_parse_state,
    list_profiles_for_api as _mh_list_profiles_for_api,
    get_profile_content_for_api as _mh_get_profile_content_for_api,
    create_profile_from_content as _mh_create_profile_from_content,
    delete_profile_by_name as _mh_delete_profile_by_name,
    activate_profile as _mh_activate_profile,
)
from services.mihomo_backups import (
    list_backups_for_profile as _mh_list_backups_for_profile,
    get_backup_content as _mh_get_backup_content,
    restore_backup_file as _mh_restore_backup_file,
    delete_backup_file as _mh_delete_backup_file,
    clean_backups_for_api as _mh_clean_backups_for_api,
)







try:
    import yaml as _yaml_for_mihomo
except Exception:  # PyYAML is optional on router
    _yaml_for_mihomo = None


def _mihomo_validate_yaml_syntax(cfg: str):
    """
    Optional fast YAML-syntax validation for Mihomo configs (similar to isValidYAML in Go UI).

    Returns (ok: bool, error_message: str). If PyYAML is not available, always returns (True, "").
    """
    if _yaml_for_mihomo is None:
        return True, ""
    try:
        _yaml_for_mihomo.safe_load(cfg)
        return True, ""
    except Exception as e:  # pragma: no cover - depends on PyYAML details
        return False, str(e)




def _get_ui_state_dir() -> str:
    """Return a writable directory for UI state (auth, secret key, logs).

    Router default: /opt/etc/xkeen-ui
    Dev/macOS fallback: XDG/~/Library/Application Support/xkeen-ui (or ~/.config/xkeen-ui)

    Override with env:
    - XKEEN_UI_STATE_DIR (preferred)
    - XKEEN_UI_DIR (legacy)
    """
    env_dir = os.environ.get("XKEEN_UI_STATE_DIR") or os.environ.get("XKEEN_UI_DIR")
    if env_dir:
        return env_dir

    default_dir = "/opt/etc/xkeen-ui"
    # Try router default first, but never fail hard if it's not writable (e.g., on macOS dev).
    try:
        os.makedirs(default_dir, exist_ok=True)
        test_path = os.path.join(default_dir, ".writetest")
        with open(test_path, "w", encoding="utf-8") as f:
            f.write("")
        os.remove(test_path)
        return default_dir
    except Exception:
        pass

    home = os.path.expanduser("~")
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        fallback = os.path.join(xdg, "xkeen-ui")
    elif sys.platform == "darwin":
        fallback = os.path.join(home, "Library", "Application Support", "xkeen-ui")
    else:
        fallback = os.path.join(home, ".config", "xkeen-ui")

    try:
        os.makedirs(fallback, exist_ok=True)
    except Exception:
        # Last resort: current working directory
        fallback = os.path.abspath("./xkeen-ui-state")
        os.makedirs(fallback, exist_ok=True)
    return fallback


UI_STATE_DIR = _get_ui_state_dir()
def _choose_base_dir(default_dir: str, fallback_dir: str) -> str:
    """Choose ``default_dir`` if it is writable, otherwise use ``fallback_dir``.

    This is used to make the UI runnable on macOS/dev where /opt is missing or not writable.
    """
    try:
        os.makedirs(default_dir, exist_ok=True)
        test_path = os.path.join(default_dir, ".writetest")
        with open(test_path, "w", encoding="utf-8") as f:
            f.write("")
        os.remove(test_path)
        return default_dir
    except Exception:
        os.makedirs(fallback_dir, exist_ok=True)
        return fallback_dir


BASE_ETC_DIR = _choose_base_dir("/opt/etc", os.path.join(UI_STATE_DIR, "etc"))
BASE_VAR_DIR = _choose_base_dir("/opt/var", os.path.join(UI_STATE_DIR, "var"))

# --- UI logging (core/access/ws) ---
# Split + rotation are configured via env and are safe to disable.
from services.logging_setup import setup_logging as _setup_ui_logging, get_log_dir as _get_ui_log_dir, get_paths as _ui_log_paths, core_logger as _get_core_logger

UI_LOG_DIR = _get_ui_log_dir(os.path.join(BASE_VAR_DIR, "log", "xkeen-ui"))
_setup_ui_logging(UI_LOG_DIR)
UI_CORE_LOG, UI_ACCESS_LOG, UI_WS_LOG = _ui_log_paths(UI_LOG_DIR)
# Core logger helper (writes to core.log).
_CORE_LOGGER = None
try:
    _CORE_LOGGER = _get_core_logger()
except Exception:
    _CORE_LOGGER = None


def _core_log(level: str, msg: str, **extra) -> None:
    """Write structured-ish messages into core.log (never raises)."""
    if _CORE_LOGGER is None:
        return
    try:
        if extra:
            try:
                tail = ", ".join(f"{k}={v}" for k, v in extra.items())
            except Exception:
                tail = repr(extra)
            full = f"{msg} | {tail}"
        else:
            full = msg
        fn = getattr(_CORE_LOGGER, str(level or "info").lower(), None)
        if callable(fn):
            fn(full)
        else:
            _CORE_LOGGER.info(full)
    except Exception:
        pass


_core_log(
    "info",
    "xkeen-ui init",
    pid=os.getpid(),
    ui_state_dir=UI_STATE_DIR,
    ui_log_dir=UI_LOG_DIR,
    base_etc_dir=BASE_ETC_DIR,
    base_var_dir=BASE_VAR_DIR,
    ws_runtime=bool(WS_RUNTIME),
)


ROUTING_FILE = os.path.join(BASE_ETC_DIR, "xray", "configs", "05_routing.json")
ROUTING_FILE_RAW = os.path.join(BASE_ETC_DIR, "xray", "configs", "05_routing.jsonc")
INBOUNDS_FILE = os.path.join(BASE_ETC_DIR, "xray", "configs", "03_inbounds.json")
OUTBOUNDS_FILE = os.path.join(BASE_ETC_DIR, "xray", "configs", "04_outbounds.json")
BACKUP_DIR = os.path.join(BASE_ETC_DIR, "xray", "configs", "backups")
XKEEN_RESTART_CMD = ["xkeen", "-restart"]
RESTART_LOG_FILE = os.environ.get("XKEEN_RESTART_LOG_FILE", os.path.join(UI_STATE_DIR, "restart.log"))
PORT_PROXYING_FILE = os.path.join(BASE_ETC_DIR, "xkeen", "port_proxying.lst")
PORT_EXCLUDE_FILE = os.path.join(BASE_ETC_DIR, "xkeen", "port_exclude.lst")
IP_EXCLUDE_FILE = os.path.join(BASE_ETC_DIR, "xkeen", "ip_exclude.lst")
XRAY_LOG_CONFIG_FILE = os.path.join(BASE_ETC_DIR, "xray", "configs", "01_log.json")
XRAY_ACCESS_LOG = os.path.join(BASE_VAR_DIR, "log", "xray", "access.log")
XRAY_ERROR_LOG = os.path.join(BASE_VAR_DIR, "log", "xray", "error.log")
XRAY_ACCESS_LOG_SAVED = XRAY_ACCESS_LOG + ".saved"
XRAY_ERROR_LOG_SAVED = XRAY_ERROR_LOG + ".saved"

# Сдвиг временных меток в логах Xray/Mihomo (в часах).
# По умолчанию +3, как в оригинальном Go UI (MSK), можно переопределить переменной окружения XKEEN_XRAY_LOG_TZ_OFFSET.
_XRAY_LOG_TZ_ENV = os.environ.get("XKEEN_XRAY_LOG_TZ_OFFSET", "3")
try:
    XRAY_LOG_TZ_OFFSET_HOURS = int(_XRAY_LOG_TZ_ENV)
except ValueError:
    XRAY_LOG_TZ_OFFSET_HOURS = 3

# Простейший кэш для логов, чтобы не перечитывать файл, если он не менялся.
# Ключ: путь к файлу, значение: словарь с полями size, mtime, lines.
LOG_CACHE = {}


MIHOMO_CONFIG_FILE = str(CONFIG_PATH)
MIHOMO_ROOT_DIR = os.path.dirname(MIHOMO_CONFIG_FILE)
# Allow override in env, but default to MIHOMO_ROOT/templates.
MIHOMO_TEMPLATES_DIR = os.environ.get("MIHOMO_TEMPLATES_DIR", os.path.join(MIHOMO_ROOT_DIR, "templates"))
MIHOMO_DEFAULT_TEMPLATE = os.path.join(MIHOMO_TEMPLATES_DIR, "custom.yaml")

# In dev/macOS we may have no templates under MIHOMO_ROOT yet; copy bundled ones if present.
try:
    os.makedirs(MIHOMO_TEMPLATES_DIR, exist_ok=True)
    _bundled_templates = os.path.join(os.path.dirname(os.path.abspath(__file__)), "opt", "etc", "mihomo", "templates")
    if os.path.isdir(_bundled_templates):
        # Copy only if target is empty/missing files.
        existing = set(os.listdir(MIHOMO_TEMPLATES_DIR))
        for _name in os.listdir(_bundled_templates):
            if _name in existing:
                continue
            _src = os.path.join(_bundled_templates, _name)
            _dst = os.path.join(MIHOMO_TEMPLATES_DIR, _name)
            if os.path.isfile(_src):
                shutil.copy2(_src, _dst)
except Exception:
    pass

XRAY_CONFIG_DIR = os.path.dirname(ROUTING_FILE)
XKEEN_CONFIG_DIR = os.path.dirname(PORT_PROXYING_FILE)

GITHUB_OWNER = os.environ.get("XKEEN_GITHUB_OWNER", "umarcheh001")
GITHUB_REPO = os.environ.get("XKEEN_GITHUB_REPO", "xkeen-community-configs")
GITHUB_BRANCH = os.environ.get("XKEEN_GITHUB_BRANCH", "main")

# URL сервера конфигураций (FastAPI), например: http://144.31.17.58:8000
CONFIG_SERVER_BASE = os.environ.get("XKEEN_CONFIG_SERVER_BASE", "http://144.31.17.58:8000")

GITHUB_REPO_URL = os.environ.get(
    "XKEEN_GITHUB_REPO_URL",
    f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}",
)


def build_user_configs_bundle():
    """Собирает *.json (кроме 04_outbounds.json) и *.lst в один объект."""
    files = []

    # Все JSON-конфиги Xray, кроме OUTBOUNDS_FILE
    if os.path.isdir(XRAY_CONFIG_DIR):
        for fname in sorted(os.listdir(XRAY_CONFIG_DIR)):
            if not fname.endswith(".".join(["json"])):
                # простой способ, но на всякий случай: только .json
                if not fname.endswith(".json"):
                    continue
            full_path = os.path.join(XRAY_CONFIG_DIR, fname)
            # пропускаем 04_outbounds.json
            if os.path.abspath(full_path) == os.path.abspath(OUTBOUNDS_FILE):
                continue

            data = load_json(full_path, default=None)
            if data is not None:
                files.append(
                    {
                        "path": f"xray/{fname}",
                        "kind": "json",
                        "content": data,
                    }
                )

    # *.lst из /opt/etc/xkeen
    lst_files = {
        "xkeen/port_proxying.lst": PORT_PROXYING_FILE,
        "xkeen/port_exclude.lst": PORT_EXCLUDE_FILE,
        "xkeen/ip_exclude.lst": IP_EXCLUDE_FILE,
    }

    for logical_path, real_path in lst_files.items():
        content = load_text(real_path, default="")
        files.append(
            {
                "path": logical_path,
                "kind": "text",
                "content": content,
            }
        )

    bundle = {
        "version": 1,
        "generated_at": int(time.time()),
        "files": files,
        "repo": {
            "owner": GITHUB_OWNER,
            "name": GITHUB_REPO,
        },
    }
    return bundle


def apply_user_configs_bundle(bundle):
    """Принимает bundle и раскладывает файлы по своим местам."""
    if not isinstance(bundle, dict):
        raise ValueError("bundle must be a dict")

    files = bundle.get("files", [])
    if not isinstance(files, list):
        raise ValueError("bundle.files must be a list")

    for item in files:
        if not isinstance(item, dict):
            continue

        path = item.get("path")
        kind = item.get("kind")
        content = item.get("content")

        if not path or kind not in ("json", "text"):
            continue

        basename = os.path.basename(path)
        real_path = None

        # JSON-конфиги
        if basename.endswith(".json"):
            # Не пишем в 04_outbounds.json
            if basename == os.path.basename(OUTBOUNDS_FILE):
                continue
            real_path = os.path.join(XRAY_CONFIG_DIR, basename)
        # LST-файлы
        elif basename == os.path.basename(PORT_PROXYING_FILE):
            real_path = PORT_PROXYING_FILE
        elif basename == os.path.basename(PORT_EXCLUDE_FILE):
            real_path = PORT_EXCLUDE_FILE
        elif basename == os.path.basename(IP_EXCLUDE_FILE):
            real_path = IP_EXCLUDE_FILE

        if not real_path:
            # неизвестный файл — пропускаем
            continue

        if kind == "json":
            if not isinstance(content, (dict, list)):
                # невалидный контент для JSON
                continue
            save_json(real_path, content)
        else:
            # text
            if not isinstance(content, str):
                content = str(content)
            save_text(real_path, content)


def _config_server_request(path: str, method: str = "GET", payload=None):
    """HTTP-запрос к серверу конфигураций (FastAPI)."""
    base = CONFIG_SERVER_BASE.rstrip("/")
    url = base + path

    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers or None, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        return json.loads(raw)


def _github_raw_get(path: str) -> str | None:
    """
    Читает файл из публичного GitHub-репозитория через raw.githubusercontent.com.
    Возвращает строку или None, если файла нет (404).
    """
    base = f"https://raw.githubusercontent.com/{GITHUB_OWNER}/{GITHUB_REPO}/{GITHUB_BRANCH}"
    url = base.rstrip("/") + "/" + path.lstrip("/")

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "xkeen-ui"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


COMMAND_GROUPS = [
    {
        "title": "Установка",
        "items": [
            {"flag": "-i",  "desc": "Основной режим установки XKeen + Xray + GeoFile + Mihomo"},
            {"flag": "-io", "desc": "OffLine установка XKeen"},
        ],
    },
    {
        "title": "Обновление",
        "items": [
            {"flag": "-uk", "desc": "Обновление XKeen"},
            {"flag": "-ug", "desc": "Обновление GeoFile"},
            {"flag": "-ux", "desc": "Обновление Xray (повышение/понижение версии)"},
            {"flag": "-um", "desc": "Обновление Mihomo (повышение/понижение версии)"},
        ],
    },
    {
        "title": "Автообновление",
        "items": [
            {"flag": "-ugc", "desc": "Включение или изменение задачи автообновления GeoFile"},
        ],
    },
    {
        "title": "Регистрация в системе",
        "items": [
            {"flag": "-rrk", "desc": "Регистрация XKeen в системе"},
            {"flag": "-rrx", "desc": "Регистрация Xray в системе"},
            {"flag": "-rrm", "desc": "Регистрация Mihomo в системе"},
            {"flag": "-ri",  "desc": "Автозапуск XKeen средствами init.d"},
        ],
    },
    {
        "title": "Удаление | Утилиты и компоненты",
        "items": [
            {"flag": "-remove", "desc": "Полная деинсталляция XKeen"},
            {"flag": "-dgs",    "desc": "Удаление GeoSite"},
            {"flag": "-dgi",    "desc": "Удаление GeoIP"},
            {"flag": "-dx",     "desc": "Удаление Xray"},
            {"flag": "-dm",     "desc": "Удаление Mihomo"},
            {"flag": "-dk",     "desc": "Удаление XKeen"},
        ],
    },
    {
        "title": "Удаление | Задачи автообновления",
        "items": [
            {"flag": "-dgc", "desc": "Удаление задачи автообновления GeoFile"},
        ],
    },
    {
        "title": "Удаление | Регистрация в системе",
        "items": [
            {"flag": "-drk", "desc": "Удаление регистрации XKeen"},
            {"flag": "-drx", "desc": "Удаление регистрации Xray"},
            {"flag": "-drm", "desc": "Удаление регистрации Mihomo"},
        ],
    },
    {
        "title": "Порты | Рабочие порты прокси-клиента",
        "items": [
            {"flag": "-ap", "desc": "Добавить порт"},
            {"flag": "-dp", "desc": "Удалить порт"},
            {"flag": "-cp", "desc": "Посмотреть список портов"},
        ],
    },
    {
        "title": "Порты | Исключённые из прокси",
        "items": [
            {"flag": "-ape", "desc": "Добавить исключённый порт"},
            {"flag": "-dpe", "desc": "Удалить исключённый порт"},
            {"flag": "-cpe", "desc": "Посмотреть исключённые порты"},
        ],
    },
    {
        "title": "Переустановка",
        "items": [
            {"flag": "-k", "desc": "Переустановка XKeen"},
            {"flag": "-g", "desc": "Переустановка GeoFile"},
        ],
    },
    {
        "title": "Резервные копии | XKeen",
        "items": [
            {"flag": "-kb",  "desc": "Создание резервной копии XKeen"},
            {"flag": "-kbr", "desc": "Восстановление XKeen из резервной копии"},
        ],
    },
    {
        "title": "Резервные копии | Конфигурация Xray",
        "items": [
            {"flag": "-cb",  "desc": "Создание резервной копии конфигурации Xray"},
            {"flag": "-cbr", "desc": "Восстановление конфигурации Xray из резервной копии"},
        ],
    },
    {
        "title": "Резервные копии | Конфигурация Mihomo",
        "items": [
            {"flag": "-mb",  "desc": "Создание резервной копии конфигурации Mihomo"},
            {"flag": "-mbr", "desc": "Восстановление конфигурации Mihomo из резервной копии"},
        ],
    },
    {
        "title": "Управление прокси-клиентом",
        "items": [
            {"flag": "-start",   "desc": "Запуск прокси-клиента"},
            {"flag": "-stop",    "desc": "Остановка прокси-клиента"},
            {"flag": "-restart", "desc": "Перезапуск прокси-клиента"},
            {"flag": "-status",  "desc": "Статус работы прокси-клиента"},
            {"flag": "-tpx",     "desc": "Порты, шлюз и протокол прокси-клиента"},
            {"flag": "-auto",    "desc": "Включить / отключить автозапуск прокси-клиента"},
            {"flag": "-d",       "desc": "Установить задержку автозапуска прокси-клиента"},
            {"flag": "-fd",      "desc": "Вкл/выкл контроль файловых дескрипторов прокси-клиента"},
            {"flag": "-diag",    "desc": "Выполнить диагностику"},
            {"flag": "-channel", "desc": "Переключить канал обновлений XKeen (Stable / Dev)"},
            {"flag": "-xray",    "desc": "Переключить XKeen на ядро Xray"},
            {"flag": "-mihomo",  "desc": "Переключить XKeen на ядро Mihomo"},
        ],
    },
    {
        "title": "Управление модулями",
        "items": [
            {"flag": "-modules",    "desc": "Перенос модулей XKeen в пользовательскую директорию"},
            {"flag": "-delmodules", "desc": "Удаление модулей из пользовательской директории"},
        ],
    },
    {
        "title": "Информация",
        "items": [
            {"flag": "-about", "desc": "О программе"},
            {"flag": "-ad",    "desc": "Поддержать разработчиков"},
            {"flag": "-af",    "desc": "Обратная связь"},
            {"flag": "-v",     "desc": "Версия XKeen"},
        ],
    },
]

ALLOWED_FLAGS = {item["flag"] for group in COMMAND_GROUPS for item in group["items"]}
XKEEN_BIN = "xkeen"

COMMAND_TIMEOUT = 300  # seconds for background xkeen jobs

ALLOW_FULL_SHELL = bool(int(os.getenv("XKEEN_ALLOW_SHELL", "1")))
SHELL_BIN = "/bin/sh"


@dataclass
class CommandJob:
    id: str
    flag: str | None = None
    cmd: str | None = None
    status: str = "queued"  # "queued" | "running" | "finished" | "error"
    exit_code: int | None = None
    output: str = ""
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    error: str | None = None


JOBS: Dict[str, CommandJob] = {}
JOBS_LOCK = threading.Lock()
MAX_JOB_AGE = 3600  # seconds to keep finished jobs


def _cleanup_old_jobs() -> None:
    """Remove finished jobs older than MAX_JOB_AGE."""
    now = time.time()
    with JOBS_LOCK:
        old_ids = [
            job_id
            for job_id, job in JOBS.items()
            if job.finished_at is not None and (now - job.finished_at) > MAX_JOB_AGE
        ]
        for job_id in old_ids:
            JOBS.pop(job_id, None)


def _run_command_job(job_id: str, stdin_data: str | None) -> None:
    """Run xkeen or shell command in background and store result in JOBS."""
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.status = "running"

    if job.cmd:
        cmd = [SHELL_BIN, "-c", job.cmd]
    elif job.flag:
        cmd = [XKEEN_BIN, job.flag]
    else:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                return
            job.status = "error"
            job.error = "empty command"
            job.finished_at = time.time()
        return

    # Stream output while the command is running so /ws/command-status can actually stream.
    # Note: we run the command in its own process group so we can terminate the whole tree on timeout.
    COMMAND_MAX_OUTPUT_CHARS = int(os.environ.get("XKEEN_COMMAND_MAX_OUTPUT_CHARS", "1048576"))  # 1 MiB

    def _is_noise_line(line: str) -> bool:
        low = (line or "").lower()
        if "collected errors" in low:
            return True
        if "opkg_conf" in low or "opkg" in low:
            return True
        return False

    def _append_output(chunk: str) -> None:
        if not chunk:
            return
        with JOBS_LOCK:
            j = JOBS.get(job_id)
            if not j:
                return
            # Prevent unbounded RAM usage on chatty commands.
            if COMMAND_MAX_OUTPUT_CHARS > 0 and len(j.output) >= COMMAND_MAX_OUTPUT_CHARS:
                # Mark once.
                if "[output truncated]" not in j.output:
                    j.output += "\n[output truncated]\n"
                return
            if COMMAND_MAX_OUTPUT_CHARS > 0:
                room = COMMAND_MAX_OUTPUT_CHARS - len(j.output)
                if room <= 0:
                    return
                if len(chunk) > room:
                    j.output += chunk[:room]
                    if "[output truncated]" not in j.output:
                        j.output += "\n[output truncated]\n"
                    return
            j.output += chunk

    started = time.time()
    proc: subprocess.Popen | None = None
    exit_code: int | None = None
    timed_out = False

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE if stdin_data is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=False,
            close_fds=True,
            preexec_fn=os.setsid,
        )

        if stdin_data is not None and proc.stdin is not None:
            try:
                proc.stdin.write(stdin_data.encode("utf-8", errors="ignore"))
            except Exception:
                pass
            try:
                proc.stdin.close()
            except Exception:
                pass

        if proc.stdout is None:
            raise RuntimeError("no stdout")

        fd = proc.stdout.fileno()
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        carry = ""

        while True:
            # Timeout check
            if (time.time() - started) > float(COMMAND_TIMEOUT):
                timed_out = True
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except Exception:
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                try:
                    # Give it a bit to exit
                    proc.wait(timeout=1.0)
                except Exception:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                break

            # Read available output (non-blocking-ish)
            try:
                r, _, _ = select.select([fd], [], [], 0.2)
            except Exception:
                r = [fd]

            if r:
                try:
                    data = os.read(fd, 4096)
                except Exception:
                    data = b""
                if not data:
                    break

                txt = decoder.decode(data)
                if txt:
                    carry += txt
                    while "\n" in carry:
                        line, carry = carry.split("\n", 1)
                        if _is_noise_line(line):
                            continue
                        _append_output(line + "\n")

            # If process exited and no more buffered data is coming, we can finish.
            try:
                if proc.poll() is not None:
                    # Drain whatever is left (best effort)
                    try:
                        while True:
                            r2, _, _ = select.select([fd], [], [], 0)
                            if not r2:
                                break
                            data2 = os.read(fd, 4096)
                            if not data2:
                                break
                            txt2 = decoder.decode(data2)
                            if txt2:
                                carry += txt2
                                while "\n" in carry:
                                    line, carry = carry.split("\n", 1)
                                    if _is_noise_line(line):
                                        continue
                                    _append_output(line + "\n")
                    except Exception:
                        pass
                    break
            except Exception:
                pass

        # Flush decoder + remaining partial line
        try:
            tail = decoder.decode(b"", final=True)
        except Exception:
            tail = ""
        if tail:
            carry += tail
        if carry:
            # last line without newline
            if not _is_noise_line(carry):
                _append_output(carry)

        try:
            exit_code = proc.wait(timeout=0.2)
        except Exception:
            try:
                exit_code = proc.poll()
            except Exception:
                exit_code = None

        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                return
            if timed_out:
                job.status = "error"
                job.error = f"timeout after {COMMAND_TIMEOUT}s"
            else:
                job.status = "finished"
            job.exit_code = int(exit_code) if exit_code is not None else None
            job.finished_at = time.time()

    except Exception as e:  # pragma: no cover - defensive
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                return
            job.status = "error"
            job.error = str(e)
            job.finished_at = time.time()
    finally:
        try:
            if proc is not None:
                try:
                    if proc.stdout:
                        proc.stdout.close()
                except Exception:
                    pass
                try:
                    if proc.stdin:
                        proc.stdin.close()
                except Exception:
                    pass
        except Exception:
            pass


def _create_command_job(flag: str | None, stdin_data: str | None, cmd: str | None = None) -> CommandJob:
    """Create CommandJob, start background thread and return the job object."""
    job_id = uuid.uuid4().hex[:12]
    job = CommandJob(id=job_id, flag=flag, cmd=cmd)
    with JOBS_LOCK:
        JOBS[job_id] = job

    _cleanup_old_jobs()

    t = threading.Thread(target=_run_command_job, args=(job_id, stdin_data), daemon=True)
    t.start()
    return job


def _get_command_job(job_id: str) -> CommandJob | None:
    with JOBS_LOCK:
        return JOBS.get(job_id)



app = Flask(__name__, static_folder="static", template_folder="templates")

@app.route("/favicon.ico")
def favicon():
    # Serve favicon at the root (some browsers request /favicon.ico by default)
    return send_from_directory(app.static_folder, "favicon.ico", mimetype="image/vnd.microsoft.icon")


# --------------------
# Auth / first-run setup
# --------------------

from werkzeug.security import generate_password_hash, check_password_hash

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

    This is critical for session security. We keep it on disk with 0600 perms (see UI_STATE_DIR).
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


app.secret_key = os.environ.get("XKEEN_UI_SECRET_KEY") or _load_or_create_secret_key()

# Cookie hardening (HTTPS may be unavailable on routers; keep Secure off by default)
app.config.setdefault("SESSION_COOKIE_HTTPONLY", True)
app.config.setdefault("SESSION_COOKIE_SAMESITE", "Lax")


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


@app.context_processor
def _inject_auth_context():
    # Available in all templates
    return {
        "csrf_token": _ensure_csrf_token(),
        "auth_user": session.get("user"),
        "auth_configured": auth_is_configured(),
    }


@app.before_request
def _auth_guard():
    """Global access control.

    - If credentials are not configured: force /setup.
    - If configured but user is not logged in: force /login.
    - For mutating requests (POST/PUT/DELETE/PATCH) when logged in: require CSRF token.
    """

    path = request.path or ""

    # Always allow static and websocket endpoints
    if path.startswith("/static/") or path.startswith("/ws/"):
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
        if path.startswith("/api/"):
            return jsonify({"ok": False, "error": "not_configured"}), 428
        return redirect(url_for("setup"))

    # If configured but not logged in – force login
    if not _is_logged_in():
        if path.startswith("/api/"):
            return _json_unauthorized()
        return redirect(url_for("login", next=path))

    # Logged in: CSRF protection for mutating calls
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        if not _check_csrf():
            if path.startswith("/api/"):
                return _csrf_failed()
            return "csrf_failed", 403

    return None




# --- WS debug logger (optional) ---
from services.logging_setup import ws_logger as _get_ws_logger, ws_enabled as _ws_enabled

def ws_debug(msg: str, **extra):
    """
    Простая обёртка для логирования событий WebSocket/HTTP логов.
    ws_debug("text", key="value", ...)
    """
    if extra:
        try:
            tail = ", ".join(f"{k}={v}" for k, v in extra.items())
        except Exception:
            tail = repr(extra)
        full = f"{msg} | {tail}"
    else:
        full = msg

    if not _ws_enabled():
        return

    try:
        _get_ws_logger().debug(full)
        return
    except Exception:
        # Не даём отладчику ломать основной код.
        # Fallback: append to the same ws.log path (respects XKEEN_LOG_DIR).
        try:
            import os
            os.makedirs(os.path.dirname(UI_WS_LOG) or ".", exist_ok=True)
            with open(UI_WS_LOG, "a", encoding="utf-8") as f:
                f.write(full + "\n")
        except Exception:
            pass



# --- Access log (optional) ---
from services.logging_setup import access_enabled as _access_enabled, access_logger as _get_access_logger

@app.after_request
def _access_log_after_request(response):
    try:
        if not _access_enabled():
            return response
        path = request.path or ""
        if path.startswith("/static/") or path.startswith("/ws/"):
            return response

        # Basic combined-like line without cookies/auth details
        method = request.method or ""
        status = getattr(response, "status_code", 0) or 0
        client = request.headers.get("X-Forwarded-For") or request.remote_addr or ""
        # Request duration (best-effort)
        dt_ms = None
        try:
            t0 = getattr(g, "_xkeen_t0", None)
            if t0:
                dt_ms = int((time.time() - float(t0)) * 1000.0)
        except Exception:
            dt_ms = None

        url = path
        if dt_ms is None:
            line = f"{client} {method} {url} -> {status}"
        else:
            line = f"{client} {method} {url} -> {status} ({dt_ms}ms)"
        _get_access_logger().info(line)
    except Exception:
        # Logging must never affect response
        pass
    return response

@app.before_request
def _access_log_before_request():
    try:
        g._xkeen_t0 = time.time()
    except Exception:
        pass
    return None


# ---------- helpers ----------

def strip_json_comments_text(s):
    """Удаляем //, # и /* */ комментарии вне строк."""
    res = []
    in_string = False
    escape = False
    i = 0
    length = len(s)

    while i < length:
        ch = s[i]

        # Внутри строки — просто копируем символы, следим за экранированием
        if in_string:
            res.append(ch)
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue

        # Начало строки
        if ch == '"':
            in_string = True
            res.append(ch)
            i += 1
            continue

        # Однострочный комментарий // ...
        if ch == '/' and i + 1 < length and s[i + 1] == '/':
            # пропускаем до конца строки
            i += 2
            while i < length and s[i] != '\n':
                i += 1
            continue

        # Однострочный комментарий # ...
        if ch == '#':
            # пропускаем до конца строки
            i += 1
            while i < length and s[i] != '\n':
                i += 1
            continue

        # Многострочный комментарий /* ... */
        if ch == '/' and i + 1 < length and s[i + 1] == '*':
            i += 2
            while i + 1 < length and not (s[i] == '*' and s[i + 1] == '/'):
                i += 1
            i += 2
            continue

        # Обычный символ
        res.append(ch)
        i += 1

    return ''.join(res)

def load_json(path, default=None):
    def strip_json_comments(s):
        """Удаляем //, # и /* */ комментарии вне строк."""
        res = []
        in_string = False
        escape = False
        i = 0
        length = len(s)

        while i < length:
            ch = s[i]

            # Внутри строки — просто копируем символы, следим за экранированием
            if in_string:
                res.append(ch)
                if escape:
                    escape = False
                elif ch == '\\':
                    escape = True
                elif ch == '"':
                    in_string = False
                i += 1
                continue

            # Начало строки
            if ch == '"':
                in_string = True
                res.append(ch)
                i += 1
                continue

            # Однострочный комментарий // ...
            if ch == '/' and i + 1 < length and s[i + 1] == '/':
                # пропускаем до конца строки
                i += 2
                while i < length and s[i] != '\n':
                    i += 1
                continue

            # Однострочный комментарий # ...
            if ch == '#':
                # пропускаем до конца строки
                i += 1
                while i < length and s[i] != '\n':
                    i += 1
                continue

            # Многострочный комментарий /* ... */
            if ch == '/' and i + 1 < length and s[i + 1] == '*':
                i += 2
                while i + 1 < length and not (s[i] == '*' and s[i + 1] == '/'):
                    i += 1
                i += 2
                continue

            # Обычный символ
            res.append(ch)
            i += 1

        return ''.join(res)

    try:
        with open(path, "r") as f:
            raw = f.read()
        cleaned = strip_json_comments(raw)
        if not cleaned.strip():
            return default
        return json.loads(cleaned)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def load_text(path, default=""):
    try:
        with open(path, "r") as f:
            return f.read()
    except FileNotFoundError:
        return default


def save_text(path, content):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, "w") as f:
        f.write(content)



def _detect_backup_target_file(filename: str):
    """Return which config file this backup filename should restore into.

    We rely on filename prefixes that we control when creating backups:
    - 05_routing-YYYY... -> ROUTING_FILE
    - 03_inbounds-YYYY... -> INBOUNDS_FILE
    - 04_outbounds-YYYY... -> OUTBOUNDS_FILE
    Anything else defaults to ROUTING_FILE for backwards compatibility.
    """
    if filename.startswith("03_inbounds-"):
        return INBOUNDS_FILE
    if filename.startswith("04_outbounds-"):
        return OUTBOUNDS_FILE
    return ROUTING_FILE


def _find_latest_auto_backup_for(config_path: str):
    """Find newest auto-backup file for given config, created by install.sh.

    install.sh uses the pattern:
        ${NAME}.auto-backup-YYYYMMDD-HHMMSS
    where NAME is basename of the config file (e.g. 05_routing.json).
    """
    base = os.path.basename(config_path)
    if not os.path.isdir(BACKUP_DIR):
        return None, None
    latest = None
    latest_mtime = None
    prefix = base + ".auto-backup-"
    for name in os.listdir(BACKUP_DIR):
        if not name.startswith(prefix):
            continue
        full = os.path.join(BACKUP_DIR, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        if latest is None or st.st_mtime > latest_mtime:
            latest = full
            latest_mtime = st.st_mtime
    return latest, latest_mtime


def list_backups():
    items = []
    if not os.path.isdir(BACKUP_DIR):
        return items
    for name in os.listdir(BACKUP_DIR):
        # Список показывает только ручные JSON-бэкапы:
        # 05_routing-*, 03_inbounds-*, 04_outbounds-*.
        if not name.endswith(".json"):
            continue
        full = os.path.join(BACKUP_DIR, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        items.append(
            {
                "name": name,
                "size": st.st_size,
                "mtime": time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)
                ),
            }
        )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items




def append_restart_log(ok, source="api"):
    """Thin wrapper around services.xkeen.append_restart_log using global RESTART_LOG_FILE."""
    return _svc_append_restart_log(RESTART_LOG_FILE, ok, source=source)



def read_restart_log(limit=100):
    """Thin wrapper around services.xkeen.read_restart_log using global RESTART_LOG_FILE."""
    return _svc_read_restart_log(RESTART_LOG_FILE, limit=limit)



def tail_lines(path, max_lines=800):
    """Wrapper around services.xray_logs.tail_lines using LOG_CACHE."""
    return _svc_tail_lines(path, max_lines=max_lines, cache=LOG_CACHE)



def adjust_log_timezone(lines, offset_hours: int = XRAY_LOG_TZ_OFFSET_HOURS):
    """Wrapper around services.xray_logs.adjust_log_timezone."""
    return _svc_adjust_log_timezone(lines, offset_hours)



def load_xray_log_config():
    """Wrapper around services.xray_logs.load_xray_log_config using global paths."""
    return _svc_load_xray_log_config(
        load_json,
        XRAY_LOG_CONFIG_FILE,
        XRAY_ACCESS_LOG,
        XRAY_ERROR_LOG,
    )



def restart_xkeen(source="api"):
    """Thin wrapper around services.xkeen.restart_xkeen using global XKEEN_RESTART_CMD/RESTART_LOG_FILE."""
    return _svc_restart_xkeen(XKEEN_RESTART_CMD, RESTART_LOG_FILE, source=source)


def restart_xray_core() -> tuple[bool, str]:
    """Restart only Xray core process (no xkeen-ui restart).

    Returns:
        (ok, detail)
    """
    try:
        return _svc_restart_xray_core()
    except Exception as e:  # noqa: BLE001
        return False, str(e)



# ---------- INBOUNDS presets (03_inbounds.json) ----------

MIXED_INBOUNDS = {
    "inbounds": [
        {
            "tag": "redirect",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "tcp", "followRedirect": True},
            "sniffing": {
                "enabled": True,
                "routeOnly": True,
                "destOverride": ["http", "tls"],
            },
        },
        {
            "tag": "tproxy",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "udp", "followRedirect": True},
            "streamSettings": {"sockopt": {"tproxy": "tproxy"}},
            "sniffing": {
                "enabled": True,
                "routeOnly": True,
                "destOverride": ["http", "tls"],
            },
        },
    ]
}

TPROXY_INBOUNDS = {
    "inbounds": [
        {
            "tag": "tproxy",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "tcp,udp", "followRedirect": True},
            "streamSettings": {"sockopt": {"tproxy": "tproxy"}},
            "sniffing": {
                "routeOnly": True,
                "enabled": True,
                "destOverride": ["http", "tls", "quic"],
            },
        }
    ]
}

REDIRECT_INBOUNDS = {
    "inbounds": [
        {
            "tag": "redirect",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "tcp", "followRedirect": True},
            "sniffing": {
                "enabled": True,
                "routeOnly": True,
                "destOverride": ["http", "tls"],
            },
        }
    ]
}


def load_inbounds():
    return load_json(INBOUNDS_FILE, default=None)


def save_inbounds(data):
    save_json(INBOUNDS_FILE, data)


def detect_inbounds_mode():
    data = load_inbounds()
    if not data:
        return None
    if data == MIXED_INBOUNDS:
        return "mixed"
    if data == TPROXY_INBOUNDS:
        return "tproxy"
    if data == REDIRECT_INBOUNDS:
        return "redirect"
    return "custom"


# ---------- OUTBOUNDS VLESS helper (04_outbounds.json) ----------

def build_vless_url_from_config(cfg):
    try:
        outbounds = cfg.get("outbounds", [])
        if not outbounds:
            return None
        main = outbounds[0]
        if main.get("protocol") != "vless":
            return None
        vnext = main["settings"]["vnext"][0]
        addr = vnext["address"]
        port = vnext["port"]
        user = vnext["users"][0]
        uid = user["id"]
        flow = user.get("flow", "xtls-rprx-vision")
        enc = user.get("encryption", "none")

        stream = main.get("streamSettings", {})
        security = stream.get("security", "reality")
        reality = stream.get("realitySettings", {})
        pbk = reality.get("publicKey", "")
        fp = reality.get("fingerprint", "chrome")
        sni = reality.get("serverName", addr)
        sid = reality.get("shortId", "")
        spx = reality.get("spiderX", "/")

        params = []
        params.append(f"encryption={enc}")
        params.append(f"flow={flow}")
        params.append(f"security={security}")
        if pbk:
            params.append(f"pbk={pbk}")
        if fp:
            params.append(f"fp={fp}")
        if sni:
            params.append(f"sni={sni}")
        if sid:
            params.append(f"sid={sid}")
        if spx:
            params.append(f"spx={quote(spx)}")

        query = "&".join(params)
        return f"vless://{uid}@{addr}:{port}?{query}"
    except Exception:
        return None


def build_outbounds_config_from_vless(url):
    parsed = urlparse(url.strip())
    if parsed.scheme != "vless":
        raise ValueError("Ожидается ссылка vless://")

    if "@" not in parsed.netloc:
        raise ValueError("Некорректный формат vless: нет '@'")
    user_part, host_part = parsed.netloc.split("@", 1)
    if ":" not in host_part:
        raise ValueError("Некорректный формат vless: нет порта")
    host, port_str = host_part.split(":", 1)
    try:
        port = int(port_str)
    except ValueError:
        raise ValueError("Некорректный порт в ссылке vless")

    uid = user_part
    qs = parse_qs(parsed.query)

    def qget(key, default=None):
        vals = qs.get(key)
        return vals[0] if vals else default

    enc = qget("encryption", "none")
    flow = qget("flow", "xtls-rprx-vision")
    security = qget("security", "reality")
    pbk = qget("pbk", "")
    fp = qget("fp", "chrome")
    sni = qget("sni", host)
    sid = qget("sid", "")
    spx = qget("spx", "/") or "/"
    spx = unquote(spx)

    cfg = {
        "outbounds": [
            {
                "tag": "vless-reality",
                "protocol": "vless",
                "settings": {
                    "vnext": [
                        {
                            "address": host,
                            "port": port,
                            "users": [
                                {
                                    "id": uid,
                                    "flow": flow,
                                    "encryption": enc,
                                    "level": 0,
                                }
                            ],
                        }
                    ]
                },
                "streamSettings": {
                    "network": "tcp",
                    "security": security,
                    "realitySettings": {
                        "publicKey": pbk,
                        "fingerprint": fp,
                        "serverName": sni,
                        "shortId": sid,
                        "spiderX": spx,
                    },
                },
            },
            {"tag": "direct", "protocol": "freedom"},
            {
                "tag": "block",
                "protocol": "blackhole",
                "settings": {"response": {"type": "http"}},
            },
        ]
    }
    return cfg


def load_outbounds():
    return load_json(OUTBOUNDS_FILE, default=None)


def save_outbounds(cfg):
    save_json(OUTBOUNDS_FILE, cfg)


# ---------- routes: Auth / Setup ----------


def _auth_save(username: str, password: str) -> None:
    username = (username or "").strip()
    pw_hash = generate_password_hash(password)
    payload = {
        "version": 1,
        "created_at": int(time.time()),
        "username": username,
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
    return jsonify({
        "ok": True,
        "configured": auth_is_configured(),
        "logged_in": _is_logged_in(),
        "user": session.get("user"),
    })


@app.get("/setup")
def setup():
    if auth_is_configured():
        # Setup already done
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

    # Immediately log in after setup
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
        ok = (username == (rec.get("username") or "")) and check_password_hash((rec.get("password_hash") or ""), password)
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
        ok = (username == (rec.get("username") or "")) and check_password_hash((rec.get("password_hash") or ""), password)
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


# ---------- routes: UI ----------

@app.get("/")
def index():
    # machine info for conditional UI (e.g. hide Files tab on MIPS)
    try:
        _machine = os.uname().machine
    except Exception:
        _machine = ''
    _is_mips = str(_machine).lower().startswith('mips')
    return render_template(
        "panel.html",
        machine=_machine,
        is_mips=_is_mips,

        routing_file=ROUTING_FILE,
        mihomo_config_file=MIHOMO_CONFIG_FILE,
        inbounds_file=INBOUNDS_FILE,
        outbounds_file=OUTBOUNDS_FILE,
        backup_dir=BACKUP_DIR,
        command_groups=COMMAND_GROUPS,
        github_repo_url=GITHUB_REPO_URL,
    )



@app.get("/xkeen")
def xkeen_page():
    return render_template("xkeen.html")

@app.get("/mihomo_generator")
def mihomo_generator_page():
    return render_template("mihomo_generator.html")


@app.get("/devtools")
def devtools_page():
    return render_template("devtools.html")





# ---------- API: routing (05_routing.json) ----------




# ---------- API: mihomo config.yaml ----------

@app.get("/api/mihomo-config")
def api_get_mihomo_config():
    content = load_text(MIHOMO_CONFIG_FILE, default=None)
    if content is None:
        return api_error(f"Файл {MIHOMO_CONFIG_FILE} не найден", 404, ok=False)
    return jsonify({"ok": True, "content": content}), 200


@app.post("/api/mihomo-config")
def api_set_mihomo_config():
    data = request.get_json(silent=True) or {}
    content = data.get("content", "")

    try:
        # Сохраняем конфиг через mihomo_server_core, чтобы перед записью делался бэкап
        ensure_mihomo_layout()
        save_config(content)
    except Exception as e:
        return api_error(str(e), 400, ok=False)

    restart_flag = bool(data.get("restart", True))
    restarted = restart_flag and restart_xkeen(source="mihomo-config")

    return jsonify({"ok": True, "restarted": restarted}), 200




@app.post("/api/mihomo/preview")
def api_mihomo_preview():
    """Generate Mihomo config preview from UI state without saving or restart.

    The payload format matches /api/mihomo/generate_apply, but this
    endpoint only returns the generated config text.
    """
    data = request.get_json(silent=True) or {}
    try:
        cfg = mihomo_svc.generate_preview(data)
    except Exception as exc:  # pragma: no cover - defensive
        return api_error(f"Ошибка генерации предпросмотра: {exc}", 400, ok=False)
    return jsonify({"ok": True, "content": cfg}), 200


@app.get("/api/mihomo/profile_defaults")
def api_mihomo_profile_defaults():
    """Return profile-specific presets for the Mihomo generator UI.

    Currently this exposes only ``enabledRuleGroups`` – the list of rule
    packages that should be checked by default for the selected profile.
    """
    profile = request.args.get("profile")
    try:
        data = mihomo_svc.get_profile_defaults(profile)
    except Exception as exc:  # pragma: no cover - defensive
        return api_error(f"Ошибка получения пресета профиля Mihomo: {exc}", 400, ok=False)

    resp = {"ok": True}
    resp.update(data)
    return jsonify(resp), 200


@app.get("/api/mihomo-config/template")
def api_get_mihomo_default_template():
    content = load_text(MIHOMO_DEFAULT_TEMPLATE, default=None)
    if content is None:
        return api_error(f"Файл шаблона {MIHOMO_DEFAULT_TEMPLATE} не найден", 404, ok=False)
    return jsonify({"ok": True, "content": content}), 200


# ---------- API: mihomo templates directory ----------

def _safe_template_path(name: str):
    # не даём уходить вверх по дереву и использовать подкаталоги
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    if not name.endswith(".yaml") and not name.endswith(".yml"):
        name = name + ".yaml"
    return os.path.join(MIHOMO_TEMPLATES_DIR, name)


@app.get("/api/mihomo-templates")
def api_list_mihomo_templates():
    if not os.path.isdir(MIHOMO_TEMPLATES_DIR):
        os.makedirs(MIHOMO_TEMPLATES_DIR, exist_ok=True)

    items = []
    for fname in sorted(os.listdir(MIHOMO_TEMPLATES_DIR)):
        if not (fname.endswith(".yaml") or fname.endswith(".yml")):
            continue
        items.append({"name": fname})

    return jsonify({"ok": True, "templates": items}), 200


@app.get("/api/mihomo-template")
def api_get_mihomo_template():
    name = request.args.get("name", "").strip()
    path = _safe_template_path(name)
    if not path:
        return api_error("invalid template name", 400, ok=False)

    content = load_text(path, default=None)
    if content is None:
        return api_error("template not found", 404, ok=False)

    return jsonify({"ok": True, "content": content, "name": os.path.basename(path)}), 200


@app.post("/api/mihomo-template")
def api_save_mihomo_template():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    content = data.get("content", "")

    path = _safe_template_path(name)
    if not path:
        return api_error("invalid template name", 400, ok=False)

    d = os.path.dirname(path)
    if not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)

    save_text(path, content)
    return jsonify({"ok": True, "name": os.path.basename(path)}), 200




@app.post("/delete-backup")
def delete_backup_from_backups_page():
    filename = request.form.get("filename")
    if filename:
        path = os.path.join(BACKUP_DIR, filename)
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                # Ignore deletion error and just return to the backups page
                pass
    return redirect(url_for("backups.backups_page"))






# ---------- API: restart xkeen ----------

@app.post("/api/restart")
def api_restart():
    """
    Restart xkeen via API button.

    To keep frontend logic consistent, this endpoint always returns a JSON object
    with a boolean "restarted" flag along with "ok".
    """
    ok = restart_xkeen(source="api-button")
    # Even on failure we still include the "restarted" flag so the UI
    # can reliably check for it.
    payload = {"ok": bool(ok), "restarted": bool(ok)}
    return jsonify(payload), (200 if ok else 500)




# ------------------------------
# One-time WebSocket tokens
# ------------------------------
import secrets as _secrets

# token -> (expires_ts, scope)
# scope is used to avoid cross-using tokens between endpoints.
WS_TOKENS: Dict[str, Tuple[float, str]] = {}
WS_TOKENS_LOCK = threading.Lock()

WS_TOKEN_SCOPES = {"pty", "cmd"}


def _cleanup_ws_tokens_locked(now: float) -> None:
    """Remove expired tokens (lock must be held)."""
    try:
        dead = [t for t, (exp, _scope) in WS_TOKENS.items() if float(exp) < float(now)]
        for t in dead:
            WS_TOKENS.pop(t, None)
    except Exception:
        # Never fail hard on cleanup
        pass


def issue_ws_token(scope: str = "pty", ttl_seconds: int = 60) -> str:
    """Issue a one-time token for a given WS endpoint scope."""
    try:
        scope = (scope or "pty").strip().lower()
    except Exception:
        scope = "pty"
    if scope not in WS_TOKEN_SCOPES:
        scope = "pty"

    try:
        ttl = int(ttl_seconds)
    except Exception:
        ttl = 60
    ttl = max(10, min(300, ttl))

    token = _secrets.token_urlsafe(24)
    exp = time.time() + ttl

    with WS_TOKENS_LOCK:
        # Opportunistic cleanup to prevent unbounded growth.
        if len(WS_TOKENS) > 1024:
            _cleanup_ws_tokens_locked(time.time())
        WS_TOKENS[token] = (float(exp), scope)

    return token


def validate_ws_token(token: str, scope: str = "pty") -> bool:
    """Validate and consume (one-time) WS token."""
    try:
        token = (token or "").strip()
    except Exception:
        token = ""
    if not token:
        return False

    try:
        scope = (scope or "pty").strip().lower()
    except Exception:
        scope = "pty"
    if scope not in WS_TOKEN_SCOPES:
        scope = "pty"

    # Atomic one-time consume under lock.
    with WS_TOKENS_LOCK:
        rec = WS_TOKENS.pop(token, None)

    if not rec:
        return False
    exp, tok_scope = rec
    if time.time() > float(exp):
        return False
    if tok_scope != scope:
        return False
    return True


# Backward-compatible helpers (PTY)
def issue_pty_ws_token(ttl_seconds: int = 60) -> str:
    return issue_ws_token(scope="pty", ttl_seconds=ttl_seconds)


def validate_pty_ws_token(token: str) -> bool:
    return validate_ws_token(token, scope="pty")


def validate_cmd_ws_token(token: str) -> bool:
    return validate_ws_token(token, scope="cmd")


@app.post("/api/ws-token")
def api_ws_token():
    # Requires login + CSRF (enforced by _auth_guard)
    ttl = 60
    scope = "pty"
    try:
        data = request.get_json(silent=True) or {}
        if isinstance(data, dict) and data.get("ttl"):
            ttl = max(10, min(300, int(data.get("ttl"))))
        if isinstance(data, dict) and data.get("scope"):
            scope = str(data.get("scope") or "pty").strip().lower()
    except Exception:
        ttl = 60
        scope = "pty"

    if scope not in WS_TOKEN_SCOPES:
        scope = "pty"

    token = issue_ws_token(scope=scope, ttl_seconds=ttl)
    return jsonify({"ok": True, "token": token, "ttl": ttl, "scope": scope})


@app.post("/api/run-command")
def api_run_command():
    data = request.get_json(silent=True) or {}

    flag = str(data.get("flag", "") or "").strip()
    cmd = str(data.get("cmd", "") or "").strip()

    stdin_data = data.get("stdin")
    if not isinstance(stdin_data, str):
        stdin_data = None

    # Legacy mode: xkeen <flag>
    if flag:
        if flag not in ALLOWED_FLAGS:
            return api_error("flag not allowed", 400, ok=False)
        job = _create_command_job(flag=flag, stdin_data=stdin_data, cmd=None)
        return jsonify(
            {
                "ok": True,
                "job_id": job.id,
                "flag": job.flag,
                "status": job.status,
            }
        ), 202

    # Full shell mode: arbitrary command, if enabled
    if cmd:
        if not ALLOW_FULL_SHELL:
            return api_error("shell disabled by config", 403, ok=False)
        job = _create_command_job(flag=None, stdin_data=stdin_data, cmd=cmd)
        return jsonify(
            {
                "ok": True,
                "job_id": job.id,
                "cmd": job.cmd,
                "status": job.status,
            }
        ), 202

    return api_error("empty flag/cmd", 400, ok=False)


@app.get("/api/run-command/<job_id>")
def api_run_command_status(job_id: str):
    _cleanup_old_jobs()
    job = _get_command_job(job_id)
    if job is None:
        return api_error("job not found", 404, ok=False)

    return jsonify(
        {
            "ok": True,
            "job_id": job.id,
            "flag": job.flag,
            "status": job.status,
            "exit_code": job.exit_code,
            "output": job.output,
            "created_at": job.created_at,
            "finished_at": job.finished_at,
            "error": job.error,
        }
    ), 200

@app.get("/api/restart-log")
def api_restart_log():
    lines = read_restart_log(limit=100)
    return jsonify({"lines": lines}), 200



@app.post("/api/restart-log/clear")
def api_restart_log_clear():
    try:
        if os.path.isfile(RESTART_LOG_FILE):
            with open(RESTART_LOG_FILE, "w") as f:
                f.write("")
        return jsonify({"ok": True}), 200
    except Exception as e:
        return api_error(str(e), 500, ok=False)


# ---------- API: Xray live logs ----------

# Cursor helpers for incremental HTTP tail (DevTools-like)
def _xray_b64e(data: bytes) -> str:
    if not data:
        return ""
    try:
        return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")
    except Exception:
        return ""


def _xray_b64d(s: str) -> bytes:
    if not s:
        return b""
    try:
        pad = "=" * (-len(s) % 4)
        return base64.urlsafe_b64decode((s + pad).encode("ascii"))
    except Exception:
        return b""


def _xray_encode_cursor(obj: Dict[str, Any]) -> str:
    try:
        raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    except Exception:
        return ""


def _xray_decode_cursor(cur: Optional[str]) -> Optional[Dict[str, Any]]:
    if not cur:
        return None
    try:
        pad = "=" * (-len(cur) % 4)
        raw = base64.urlsafe_b64decode((cur + pad).encode("ascii"))
    except Exception:
        return None
    try:
        obj = json.loads(raw.decode("utf-8", "ignore"))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None

@app.get("/api/xray-logs")
def api_xray_logs():
    """
    Псевдо-tail логов Xray (HTTP).

    query:
      file=error|access (или error.log/access.log)
      max_lines=число (по умолчанию 800, 50–5000)
      cursor=строка (опционально) — инкрементальный курсор (DevTools-like)
      source=строка — для debug-логов
    """
    file_name = request.args.get("file", "error")
    cursor = request.args.get("cursor")
    try:
        max_lines = int(request.args.get("max_lines", 800))
    except (TypeError, ValueError):
        max_lines = 800

    # sanity clamp
    if max_lines < 50:
        max_lines = 50
    if max_lines > 5000:
        max_lines = 5000

    source = request.args.get("source", "manual")
    ws_debug(
        "api_xray_logs: HTTP tail requested",
        file=file_name,
        max_lines=max_lines,
        cursor=bool(cursor),
        source=source,
        client=request.remote_addr or "unknown",
    )

    path = _resolve_xray_log_path_for_ws(file_name)
    if not path or not os.path.isfile(path):
        return jsonify({"lines": [], "mode": "full", "cursor": "", "exists": False, "size": 0, "mtime": 0.0, "ino": 0}), 200

    try:
        st = os.stat(path)
        ino = int(getattr(st, "st_ino", 0) or 0)
        size = int(getattr(st, "st_size", 0) or 0)
        mtime = float(getattr(st, "st_mtime", 0.0) or 0.0)
    except Exception:
        return jsonify({"lines": [], "mode": "full", "cursor": "", "exists": False, "size": 0, "mtime": 0.0, "ino": 0}), 200

    # Try incremental append mode first (when cursor matches the same file inode)
    cur = _xray_decode_cursor(cursor)
    if cur and int(cur.get("ino", -1)) == ino:
        try:
            off = int(cur.get("off", 0) or 0)
        except Exception:
            off = 0

        if 0 <= off <= size:
            carry = _xray_b64d(str(cur.get("carry", "")))
            new_lines, new_off, new_carry = _svc_read_new_lines(path, off, carry=carry, max_bytes=128 * 1024)
            new_cursor = _xray_encode_cursor({"ino": ino, "off": int(new_off), "carry": _xray_b64e(new_carry)})

            new_lines = adjust_log_timezone(new_lines)

            return (
                jsonify(
                    {
                        "lines": new_lines,
                        "mode": "append",
                        "cursor": new_cursor,
                        "exists": True,
                        "size": size,
                        "mtime": mtime,
                        "ino": ino,
                    }
                ),
                200,
            )

    # Full tail snapshot
    lines = _svc_tail_lines_fast(path, max_lines=max_lines, max_bytes=256 * 1024)
    lines = adjust_log_timezone(lines)
    new_cursor = _xray_encode_cursor({"ino": ino, "off": size, "carry": ""})

    return (
        jsonify(
            {
                "lines": lines,
                "mode": "full",
                "cursor": new_cursor,
                "exists": True,
                "size": size,
                "mtime": mtime,
                "ino": ino,
            }
        ),
        200,
    )

@app.post("/api/xray-logs/clear")
def api_xray_logs_clear():
    """
    Очищает логфайлы Xray.
    body JSON: {"file": "error"|"access"} — если не задано, чистим оба.
    """
    data = request.get_json(silent=True) or {}
    file_name = data.get("file")

    targets = []
    if file_name in ("error", "error.log"):
        targets = [XRAY_ERROR_LOG]
    elif file_name in ("access", "access.log"):
        targets = [XRAY_ACCESS_LOG]
    else:
        targets = [XRAY_ACCESS_LOG, XRAY_ERROR_LOG]

    # Чистим и основные файлы, и их "снимки" (.saved)
    for path in targets:
        for actual in (path, path + ".saved"):
            try:
                os.makedirs(os.path.dirname(actual), exist_ok=True)
                with open(actual, "w") as f:
                    f.write("")
                # сбрасываем кэш для очищенного файла
                if actual in LOG_CACHE:
                    LOG_CACHE.pop(actual, None)
            except Exception:
                # просто игнорируем, роутер может быть в readonly и т.п.
                pass

    return jsonify({"ok": True}), 200



@app.get("/api/xray-logs/download")
def api_xray_logs_download():
    """Download current Xray log file (error/access)."""
    file_name = request.args.get("file", "error")
    path = _resolve_xray_log_path_for_ws(file_name)
    if not path or not os.path.isfile(path):
        return jsonify({"ok": False, "error": "not_found"}), 404

    # normalize download name
    base = "error" if str(file_name or "").lower() in ("error", "error.log") else "access"
    try:
        return send_file(path, as_attachment=True, download_name=f"xray-{base}.log")
    except TypeError:
        # Flask < 2.0
        return send_file(path, as_attachment=True, attachment_filename=f"xray-{base}.log")

def _resolve_xray_log_path_for_ws(file_name: str) -> str | None:
    """
    Возвращает путь к лог-файлу для WebSocket-стрима
    с учётом loglevel=none и *.saved.
    """
    file_name = (file_name or "error").lower()

    cfg = load_xray_log_config()
    log_cfg = cfg.get("log", {})
    loglevel = str(log_cfg.get("loglevel", "none")).lower()

    if file_name in ("error", "error.log"):
        if loglevel == "none" and os.path.isfile(XRAY_ERROR_LOG_SAVED):
            return XRAY_ERROR_LOG_SAVED
        return XRAY_ERROR_LOG

    if file_name in ("access", "access.log"):
        if loglevel == "none" and os.path.isfile(XRAY_ACCESS_LOG_SAVED):
            return XRAY_ACCESS_LOG_SAVED
        return XRAY_ACCESS_LOG

    # дефолт — error
    if loglevel == "none" and os.path.isfile(XRAY_ERROR_LOG_SAVED):
        return XRAY_ERROR_LOG_SAVED
    return XRAY_ERROR_LOG


@app.get("/api/xray-logs/status")
def api_xray_logs_status():
    """Возвращает текущий loglevel и пути для логов Xray."""
    cfg = load_xray_log_config()
    log_cfg = cfg.get("log", {})
    return jsonify(
        {
            "loglevel": log_cfg.get("loglevel", "none"),
            "access": log_cfg.get("access", XRAY_ACCESS_LOG),
            "error": log_cfg.get("error", XRAY_ERROR_LOG),
        }
    ), 200


@app.post("/api/xray-logs/enable")
def api_xray_logs_enable():
    """
    Включает логи Xray: loglevel != none.
    body JSON: {"loglevel": "warning"|"info"|...} — опционально, по умолчанию warning.
    После смены конфига перезапускает только процесс Xray (без перезапуска xkeen-ui).
    """
    data = request.get_json(silent=True) or {}
    level = str(data.get("loglevel") or "warning").strip().lower()

    # Xray supports: debug/info/warning/error/none. We keep a strict allowlist here
    # so the UI selector (and API clients) can't write arbitrary values.
    allowed = {"debug", "info", "warning", "error", "none"}
    if level not in allowed:
        level = "warning"

    cfg = load_xray_log_config()
    cfg["log"]["access"] = XRAY_ACCESS_LOG
    cfg["log"]["error"] = XRAY_ERROR_LOG
    cfg["log"]["loglevel"] = level
    save_json(XRAY_LOG_CONFIG_FILE, cfg)

    ok, detail = restart_xray_core()
    nonfatal = str(detail or '') == 'xray not running'
    resp_ok = bool(ok or nonfatal)
    # IMPORTANT: keep "restarted" for backward compatibility (it historically meant xkeen restart).
    # We intentionally avoid xkeen restart here.
    return (
        jsonify({
            "ok": resp_ok,
            "loglevel": level,
            "restarted": False,
            "xray_restarted": bool(ok),
            "detail": detail,
        }),
        200 if resp_ok else 500,
    )


@app.post("/api/xray-logs/disable")
def api_xray_logs_disable():
    """
    Отключает логи Xray (loglevel = none).
    Перед применением сохраняет текущие логи в *.saved, чтобы их можно было просмотреть после остановки.
    """
    # Делаем "снимок" текущих логов
    try:
        if os.path.isfile(XRAY_ACCESS_LOG):
            shutil.copy2(XRAY_ACCESS_LOG, XRAY_ACCESS_LOG_SAVED)
        if os.path.isfile(XRAY_ERROR_LOG):
            shutil.copy2(XRAY_ERROR_LOG, XRAY_ERROR_LOG_SAVED)
    except Exception:
        # если не получилось — не критично
        pass

    cfg = load_xray_log_config()
    cfg["log"]["loglevel"] = "none"
    save_json(XRAY_LOG_CONFIG_FILE, cfg)

    ok, detail = restart_xray_core()
    nonfatal = str(detail or '') == 'xray not running'
    resp_ok = bool(ok or nonfatal)
    return (
        jsonify({
            "ok": resp_ok,
            "restarted": False,
            "xray_restarted": bool(ok),
            "detail": detail,
        }),
        200 if resp_ok else 500,
    )


# ---------- API: xkeen text configs (/opt/etc/xkeen/*.lst) ----------

DEFAULT_PORT_PROXYING = """#80
#443
#596:599

# (Раскомментируйте/добавьте по образцу) единичные порты и диапазоны для проскирования
"""

DEFAULT_PORT_EXCLUDE = """#
# Одновременно использовать порты проксирования и исключать порты нельзя
# Приоритет у портов проксирования
"""

DEFAULT_IP_EXCLUDE = """#192.168.0.0/16
#2001:db8::/32

# Добавьте необходимые IP и подсети без комментария # для исключения их из проксирования
"""


@app.get("/api/xkeen/port-proxying")
def api_get_port_proxying():
    content = load_text(PORT_PROXYING_FILE, default=DEFAULT_PORT_PROXYING)
    return jsonify({"content": content}), 200


@app.post("/api/xkeen/port-proxying")
def api_set_port_proxying():
    payload = request.get_json(silent=True) or {}
    content = payload.get("content", "")
    save_text(PORT_PROXYING_FILE, content)
    restart_flag = bool(payload.get("restart", True))
    restarted = restart_flag and restart_xkeen(source="port-proxying")

    return jsonify({"ok": True, "restarted": restarted}), 200


@app.get("/api/xkeen/port-exclude")
def api_get_port_exclude():
    content = load_text(PORT_EXCLUDE_FILE, default=DEFAULT_PORT_EXCLUDE)
    return jsonify({"content": content}), 200


@app.post("/api/xkeen/port-exclude")
def api_set_port_exclude():
    payload = request.get_json(silent=True) or {}
    content = payload.get("content", "")
    save_text(PORT_EXCLUDE_FILE, content)
    restart_flag = bool(payload.get("restart", True))
    restarted = restart_flag and restart_xkeen(source="port-exclude")

    return jsonify({"ok": True, "restarted": restarted}), 200


@app.get("/api/xkeen/ip-exclude")
def api_get_ip_exclude():
    content = load_text(IP_EXCLUDE_FILE, default=DEFAULT_IP_EXCLUDE)
    return jsonify({"content": content}), 200


@app.post("/api/xkeen/ip-exclude")
def api_set_ip_exclude():
    payload = request.get_json(silent=True) or {}
    content = payload.get("content", "")
    save_text(IP_EXCLUDE_FILE, content)
    restart_flag = bool(payload.get("restart", True))
    restarted = restart_flag and restart_xkeen(source="ip-exclude")

    return jsonify({"ok": True, "restarted": restarted}), 200


# ---------- API: inbounds (03_inbounds.json) ----------

@app.get("/api/inbounds")
def api_get_inbounds():
    mode = detect_inbounds_mode()
    data = load_inbounds()
    try:
        pretty = json.dumps(data, ensure_ascii=False, indent=2) if data is not None else "{}"
    except Exception:
        pretty = "{}"
    return jsonify({"mode": mode, "config": data, "text": pretty}), 200


@app.post("/api/inbounds")
def api_set_inbounds():
    payload = request.get_json(silent=True) or {}

    # Новый режим: прямое сохранение произвольного конфига
    if "config" in payload:
        data = payload.get("config")
        if not isinstance(data, dict):
            return api_error("config must be object", 400, ok=False)

        restart_flag = bool(payload.get("restart", True))
        save_inbounds(data)
        # после ручного редактирования пробуем определить режим (mixed/tproxy/redirect/custom)
        mode = detect_inbounds_mode()
        restarted = restart_flag and restart_xkeen(source="inbounds")

        return jsonify({"ok": True, "mode": mode, "restarted": restarted}), 200

    # Старый режим: выбор предустановленного режима по полю mode
    mode = payload.get("mode")

    if mode not in ("mixed", "tproxy", "redirect"):
        return api_error("invalid mode", 400, ok=False)

    if mode == "mixed":
        data = MIXED_INBOUNDS
    elif mode == "tproxy":
        data = TPROXY_INBOUNDS
    else:
        data = REDIRECT_INBOUNDS

    restart_flag = bool(payload.get("restart", True))
    save_inbounds(data)
    restarted = restart_flag and restart_xkeen(source="inbounds")

    return jsonify({"ok": True, "mode": mode, "restarted": restarted}), 200


# ---------- API: outbounds (04_outbounds.json) ----------

@app.get("/api/outbounds")
def api_get_outbounds():
    cfg = load_outbounds()
    url = None
    if cfg:
        url = build_vless_url_from_config(cfg)
    try:
        pretty = json.dumps(cfg, ensure_ascii=False, indent=2) if cfg is not None else "{}"
    except Exception:
        pretty = "{}"
    return jsonify({"url": url, "config": cfg, "text": pretty}), 200


@app.post("/api/outbounds")
def api_set_outbounds():
    payload = request.get_json(silent=True) or {}

    # Новый режим: прямое сохранение произвольного конфига
    if "config" in payload:
        cfg = payload.get("config")
        if not isinstance(cfg, dict):
            return api_error("config must be object", 400, ok=False)
    else:
        # Старый режим: собираем конфиг из VLESS-ссылки
        url = (payload.get("url") or "").strip()
        if not url:
            return api_error("url is required", 400, ok=False)
        try:
            cfg = build_outbounds_config_from_vless(url)
        except Exception as e:
            return api_error(str(e), 400, ok=False)

    save_outbounds(cfg)
    restart_flag = bool(payload.get("restart", True))
    restarted = restart_flag and restart_xkeen(source="outbounds")

    return jsonify({"ok": True, "restarted": restarted}), 200

# ---------- API: Local configs import/export ----------

@app.get("/api/local/export-configs")
def api_local_export_configs():
    """Экспорт всех пользовательских конфигураций (кроме 04_outbounds.json)
    в один JSON-файл, используя build_user_configs_bundle()."""
    bundle = build_user_configs_bundle()
    filename = time.strftime("xkeen-config-%Y%m%d-%H%M%S.json")

    resp = app.response_class(
        response=json.dumps(bundle, ensure_ascii=False, indent=2),
        status=200,
        mimetype="application/json",
    )
    resp.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp


@app.post("/api/local/import-configs")
def api_local_import_configs():
    """Импорт конфигураций из локального JSON-файла bundle."""
    file = request.files.get("file")
    if not file or file.filename == "":
        return api_error("no file uploaded", 400, ok=False)

    try:
        raw = file.read().decode("utf-8", errors="replace")
    except Exception as e:
        return api_error(f"read failed: {e}", 400, ok=False)

    try:
        bundle = json.loads(raw)
    except Exception as e:
        return api_error(f"invalid json: {e}", 400, ok=False)

    if not isinstance(bundle, dict):
        return api_error("bundle must be a dict", 400, ok=False)

    try:
        apply_user_configs_bundle(bundle)
    except Exception as e:
        return api_error(f"apply failed: {e}", 500, ok=False)

    return jsonify({"ok": True}), 200


# ---------- API: GitHub / config server integration ----------

@app.post("/api/github/export-configs")
def api_github_export_configs():
    if not CONFIG_SERVER_BASE:
        return api_error("CONFIG_SERVER_BASE is not configured", 500, ok=False)

    bundle = build_user_configs_bundle()

    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    description = (data.get("description") or "").strip()
    tags = data.get("tags") or []

    if not title:
        title = f"XKeen config {time.strftime('%Y-%m-%d %H:%M:%S')}"

    upload_payload = {
        "title": title,
        "description": description,
        "tags": tags,
        "bundle": bundle,
    }

    try:
        server_resp = _config_server_request("/upload", method="POST", payload=upload_payload)
    except Exception as e:
        return api_error(f"upload failed: {e}", 500, ok=False)

    ok = bool(server_resp.get("ok"))
    cfg_id = server_resp.get("id")

    if not ok or not cfg_id:
        payload = {"error": "upload failed on config server", "ok": False, "server_response": server_resp}
        return jsonify(payload), 500

    return jsonify({"ok": True, "id": cfg_id, "server_response": server_resp}), 200


@app.get("/api/github/configs")
def api_github_list_configs():
    """Возвращает список конфигов из GitHub (configs/index.json)."""
    try:
        raw = _github_raw_get("configs/index.json")
    except Exception as e:
        return api_error(f"github index failed: {e}", 500, ok=False)

    if not raw:
        items = []
    else:
        try:
            items = json.loads(raw)
            if not isinstance(items, list):
                items = []
        except Exception:
            items = []

    return jsonify({"ok": True, "items": items}), 200


@app.post("/api/github/import-configs")
def api_github_import_configs():
    """
    Если в теле есть cfg_id — загружаем именно его.
    Если нет — берём самый свежий из configs/index.json в GitHub-репозитории.
    """
    payload = request.get_json(silent=True) or {}
    cfg_id = (payload.get("cfg_id") or "").strip()

    # Если id не указан — читаем index.json из репозитория и выбираем последнюю конфигурацию.
    if not cfg_id:
        try:
            raw_index = _github_raw_get("configs/index.json")
        except Exception as e:
            return api_error(f"github index failed: {e}", 500, ok=False)

        if not raw_index:
            return api_error("no configs found in repo", 404, ok=False)

        try:
            items = json.loads(raw_index)
            if not isinstance(items, list) or not items:
                return api_error("no configs found in repo", 404, ok=False)
        except Exception:
            return api_error("invalid index.json in repo", 500, ok=False)

        latest = max(items, key=lambda it: int(it.get("created_at", 0) or 0))
        cfg_id = latest.get("id")
        if not cfg_id:
            return api_error("latest config has no id", 500, ok=False)

    # Загружаем bundle.json выбранной конфигурации
    try:
        raw_bundle = _github_raw_get(f"configs/{cfg_id}/bundle.json")
    except Exception as e:
        return api_error(f"github get {cfg_id} failed: {e}", 500, ok=False)

    if not raw_bundle:
        return api_error(f"config {cfg_id} not found in repo", 404, ok=False)

    try:
        bundle = json.loads(raw_bundle)
    except Exception as e:
        return api_error(f"invalid bundle JSON for {cfg_id}: {e}", 500, ok=False)

    if not isinstance(bundle, dict):
        return api_error("invalid bundle structure from repo", 500, ok=False)

    try:
        apply_user_configs_bundle(bundle)
    except Exception as e:
        return api_error(f"apply failed: {e}", 500, ok=False)

    # Не перезапускаем xkeen автоматически — пользователь может внести правки.
    return jsonify({"ok": True, "cfg_id": cfg_id}), 200

# ---------- API: mihomo universal generator backend ----------

from mihomo_server_core import (
    ensure_mihomo_layout,
    get_active_profile_name,
    save_config,
    restart_mihomo_and_get_log,
    validate_config,
)
import xkeen_mihomo_service as mihomo_svc


def _mihomo_get_state_from_request():
    """Obtain Mihomo state from the current HTTP request via service parser."""
    data = request.get_json(silent=True) or {}
    return _mihomo_parse_state(data)




@app.post("/api/mihomo/generate")
def api_mihomo_generate():
    try:
        state = _mihomo_get_state_from_request()
        cfg = mihomo_svc.generate_config_from_state(state)
        return app.response_class(cfg, mimetype="text/plain; charset=utf-8")
    except Exception as e:
        return api_error(str(e), 400, ok=False)


@app.post("/api/mihomo/download")
def api_mihomo_download():
    try:
        state = _mihomo_get_state_from_request()
        cfg = mihomo_svc.generate_config_from_state(state)
        return app.response_class(
            cfg,
            mimetype="application/x-yaml",
            headers={"Content-Disposition": "attachment; filename=config.yaml"},
        )
    except Exception as e:
        return api_error(str(e), 400, ok=False)


@app.post("/api/mihomo/save")
def api_mihomo_save():
    try:
        state = _mihomo_get_state_from_request()
        cfg, active_profile = mihomo_svc.generate_and_save_config(state)
        return jsonify(
            {
                "ok": True,
                "active_profile": active_profile,
                "config_length": len(cfg),
            }
        )
    except Exception as e:
        return api_error(str(e), 400, ok=False)


@app.post("/api/mihomo/restart")
def api_mihomo_restart():
    try:
        state = _mihomo_get_state_from_request()
        cfg, log = mihomo_svc.generate_save_and_restart(state)
        return jsonify(
            {"ok": True, "config_length": len(cfg), "log": log}
        )
    except Exception as e:
        return api_error(str(e), 400, ok=False)

@app.post("/api/mihomo/generate_apply")
def api_mihomo_generate_apply():
    """Endpoint used by mihomo_generator.html to generate+apply config.

    Expects JSON:
      {
        "state": {...},
        "configOverride": "yaml from editor (optional)"
      }

    If configOverride is non-empty, it will be used as final config.yaml.
    Otherwise the config is generated from state using build_full_config().
    """
    data = request.get_json(silent=True) or {}
    try:
        # Если есть configOverride из редактора – предварительно проверим синтаксис YAML.
        cfg_override = (data.get("configOverride") or "")
        if cfg_override.strip():
            ok_yaml, yaml_err = _mihomo_validate_yaml_syntax(cfg_override)
            if not ok_yaml:
                return api_error(f"Invalid YAML syntax: {yaml_err}", 400, ok=False)

        cfg, log = mihomo_svc.generate_save_and_restart(data)
        return jsonify(
            {
                "ok": True,
                "config_length": len(cfg),
                "log": log,
            }
        )
    except FileNotFoundError as e:
        return api_error(str(e), 404, ok=False)
    except ValueError as e:
        return api_error(str(e), 400, ok=False)
    except Exception as e:
        return api_error(str(e), 500, ok=False)






@app.post("/api/mihomo/save_raw")
def api_mihomo_save_raw():
    """
    Сохранить произвольный YAML как активный профиль mihomo (с бэкапом).
    Ожидает JSON: { "config": "yaml..." }.
    """
    data = request.get_json(silent=True) or {}
    cfg = (data.get("config") or "").rstrip()
    if not cfg:
        return api_error("config is required", 400, ok=False)
    # Быстрая проверка синтаксиса YAML (если установлен PyYAML), по аналогии с isValidYAML в Go-версии XKeen UI.
    ok_yaml, yaml_err = _mihomo_validate_yaml_syntax(cfg)
    if not ok_yaml:
        return api_error(f"Invalid YAML syntax: {yaml_err}", 400, ok=False)
    try:
        ensure_mihomo_layout()
        save_config(cfg)
        active = get_active_profile_name()
        return jsonify(
            {"ok": True, "active_profile": active, "config_length": len(cfg)}
        )
    except Exception as e:
        return api_error(str(e), 400, ok=False)


@app.post("/api/mihomo/restart_raw")
def api_mihomo_restart_raw():
    """
    Сохранить произвольный YAML и перезапустить mihomo (xkeen -restart).
    Ожидает JSON: { "config": "yaml..." }.
    """
    data = request.get_json(silent=True) or {}
    cfg = (data.get("config") or "").rstrip()
    if not cfg:
        return api_error("config is required", 400, ok=False)
    # Перед сохранением и перезапуском тоже проверяем синтаксис YAML (если доступен PyYAML).
    ok_yaml, yaml_err = _mihomo_validate_yaml_syntax(cfg)
    if not ok_yaml:
        return api_error(f"Invalid YAML syntax: {yaml_err}", 400, ok=False)
    try:
        ensure_mihomo_layout()
        log = restart_mihomo_and_get_log(cfg)
        return jsonify(
            {
                "ok": True,
                "config_length": len(cfg),
                "log": log,
            }
        )
    except Exception as e:
        return api_error(str(e), 400, ok=False)



@app.post("/api/mihomo/validate_raw")
def api_mihomo_validate_raw():
    """
    Лёгкая проверка YAML-конфига Mihomo БЕЗ рестарта сервиса.

    Ожидает JSON: { "config": "yaml..." }.

    Если "config" пустой — валидируется текущий активный config.yaml.
    Если не пустой — валидируется присланный текст (без сохранения и рестарта).
    """
    data = request.get_json(silent=True) or {}
    cfg = (data.get("config") or "").rstrip()

    try:
        ensure_mihomo_layout()

        # Если конфиг не прислали – читаем активный config.yaml
        if not cfg:
            try:
                with open(MIHOMO_CONFIG_FILE, "r", encoding="utf-8") as f:
                    cfg = f.read()
            except FileNotFoundError:
                return api_error("active config.yaml not found", 404, ok=False)

        # Проверяем конфиг только через внешнее ядро Mihomo (mihomo -t)
        log_lines = []
        rc = 0

        try:
            mh_log = validate_config(new_content=cfg)
        except Exception as e:
            mh_log = f"Failed to run mihomo validate: {e}"

        if mh_log:
            log_lines.append(mh_log)

            # Пытаемся вытащить exit code из вывода validate_config
            m = re.search(r"\[exit code:\s*(\d+)\]", mh_log)
            if m:
                rc = int(m.group(1))

        log = "\n".join(log_lines)

        return jsonify({"ok": rc == 0, "log": log})
    except Exception as e:
        return api_error(str(e), 400, ok=False)



@app.get("/api/mihomo/profiles")
def api_mihomo_profiles_list():
    """List Mihomo profiles (name + is_active) via service layer."""
    try:
        infos = _mh_list_profiles_for_api()
        return jsonify(infos)
    except Exception as e:
        return api_error(str(e), 400, ok=False)


@app.get("/api/mihomo/profiles/<name>")
def api_mihomo_profiles_get(name: str):
    """Return raw YAML content of the given Mihomo profile."""
    try:
        content = _mh_get_profile_content_for_api(name)
        return app.response_class(content, mimetype="text/plain; charset=utf-8")
    except FileNotFoundError:
        return api_error("profile not found", 404, ok=False)
    except Exception as e:
        return api_error(str(e), 400, ok=False)


@app.put("/api/mihomo/profiles/<name>")
def api_mihomo_profiles_put(name: str):
    """Create a new Mihomo profile with given YAML content."""
    content = request.data.decode("utf-8", errors="ignore")
    if not content.strip():
        return api_error("empty content", 400, ok=False)
    try:
        _mh_create_profile_from_content(name, content)
        return jsonify({"ok": True})
    except FileExistsError:
        return api_error("profile already exists", 409, ok=False)
    except Exception as e:
        return api_error(str(e), 400, ok=False)


@app.delete("/api/mihomo/profiles/<name>")
def api_mihomo_profiles_delete(name: str):
    """Delete Mihomo profile."""
    try:
        _mh_delete_profile_by_name(name)
        return jsonify({"ok": True})
    except RuntimeError as e:
        # For example: attempt to delete active profile.
        return api_error(str(e), 400, ok=False)
    except Exception as e:
        return api_error(str(e), 400, ok=False)


@app.post("/api/mihomo/profiles/<name>/activate")
def api_mihomo_profiles_activate(name: str):
    "Activate given Mihomo profile and restart xkeen."
    try:
        _mh_activate_profile(name)
        restarted = restart_xkeen(source="mihomo-profile-activate")
        return jsonify({"ok": True, "restarted": restarted})
    except FileNotFoundError:
        return api_error("profile not found", 404, ok=False)
    except Exception as e:
        return api_error(str(e), 400, ok=False)
@app.post("/api/mihomo/backups/clean")
def api_mihomo_backups_clean():
    """
    Remove old Mihomo config backups, keeping at most `limit` newest ones.
    """
    data = request.get_json(silent=True) or {}
    limit = data.get("limit", 5)
    profile = (data.get("profile") or "").strip() or None

    try:
        limit = int(limit)
    except Exception:
        return api_error("limit must be an integer", 400, ok=False)
    if limit < 0:
        return api_error("limit must be >= 0", 400, ok=False)

    try:
        result = _mh_clean_backups_for_api(limit, profile)
        return jsonify(result)
    except Exception as e:
        return api_error(str(e), 400, ok=False)


@app.get("/api/mihomo/backups")
def api_mihomo_backups_list():
    profile = request.args.get("profile") or None
    infos = _mh_list_backups_for_profile(profile)
    return jsonify(infos)


@app.get("/api/mihomo/backups/<filename>")
def api_mihomo_backup_get(filename: str):
    try:
        content = _mh_get_backup_content(filename)
        return app.response_class(content, mimetype="text/plain; charset=utf-8")
    except FileNotFoundError:
        return api_error("backup not found", 404, ok=False)


@app.delete("/api/mihomo/backups/<filename>")
def api_mihomo_backup_delete(filename: str):
    try:
        _mh_delete_backup_file(filename)
        return jsonify({"ok": True})
    except Exception as e:
        return api_error(str(e), 400, ok=False)


@app.post("/api/mihomo/backups/<filename>/restore")
def api_mihomo_backup_restore(filename: str):
    try:
        _mh_restore_backup_file(filename)
        # Перезапуск после восстановления бэкапа, чтобы конфиг применился
        restarted = restart_xkeen(source="mihomo-backup-restore")
        return jsonify({"ok": True, "restarted": restarted})
    except FileNotFoundError:
        return api_error("backup not found", 404, ok=False)
    except Exception as e:
        return api_error(str(e), 400, ok=False)



def _detect_machine_arch() -> str:
    try:
        return (os.uname().machine or "").strip()
    except Exception:
        try:
            import platform
            return (platform.machine() or "").strip()
        except Exception:
            return ""


def _is_mips_arch(machine: str) -> bool:
    m = (machine or "").lower()
    return m.startswith("mips")


def _which_lftp() -> str | None:
    # Prefer Entware location
    candidates = ["/opt/bin/lftp", "/usr/bin/lftp", "/bin/lftp"]
    for c in candidates:
        try:
            if os.path.isfile(c) and os.access(c, os.X_OK):
                return c
        except Exception:
            pass

    # Try PATH (ensure /opt/bin is included)
    try:
        path = os.environ.get("PATH", "")
        if "/opt/bin" not in path.split(":"):
            os.environ["PATH"] = "/opt/bin:" + path
    except Exception:
        pass

    try:
        return shutil.which("lftp")
    except Exception:
        return None


REMOTEFS_MACHINE_ARCH = _detect_machine_arch()
REMOTEFS_LFTP_BIN = _which_lftp()
REMOTEFS_SUPPORTED = bool(REMOTEFS_LFTP_BIN) and (not _is_mips_arch(REMOTEFS_MACHINE_ARCH))
REMOTEFS_ENABLED = REMOTEFS_SUPPORTED and (os.getenv("XKEEN_REMOTEFM_ENABLE", "1").strip().lower() not in ("0", "false", "no", "off"))

REMOTEFS_DISABLED_REASON = None
if not REMOTEFS_LFTP_BIN:
    REMOTEFS_DISABLED_REASON = "lftp_missing"
elif _is_mips_arch(REMOTEFS_MACHINE_ARCH):
    REMOTEFS_DISABLED_REASON = "arch_mips_disabled"
elif not REMOTEFS_ENABLED:
    REMOTEFS_DISABLED_REASON = "disabled"



# ---------- Blueprints registration ----------


routing_bp = create_routing_blueprint(
    ROUTING_FILE=ROUTING_FILE,
    ROUTING_FILE_RAW=ROUTING_FILE_RAW,
    load_json=load_json,
    strip_json_comments_text=strip_json_comments_text,
    restart_xkeen=restart_xkeen,
)
app.register_blueprint(routing_bp)

backups_bp = create_backups_blueprint(
    BACKUP_DIR=BACKUP_DIR,
    ROUTING_FILE=ROUTING_FILE,
    ROUTING_FILE_RAW=ROUTING_FILE_RAW,
    INBOUNDS_FILE=INBOUNDS_FILE,
    OUTBOUNDS_FILE=OUTBOUNDS_FILE,
    load_json=load_json,
    save_json=save_json,
    list_backups=list_backups,
    _detect_backup_target_file=_detect_backup_target_file,
    _find_latest_auto_backup_for=_find_latest_auto_backup_for,
    strip_json_comments_text=strip_json_comments_text,
    restart_xkeen=restart_xkeen,
)
app.register_blueprint(backups_bp)


# Глобальный список WebSocket-подписчиков на сервисные события.
# Наполняется в run_server.py при подключении к /ws/events.
EVENT_SUBSCRIBERS: list = []


def broadcast_event(event: dict) -> None:
    """Отправить событие всем активным WebSocket-подписчикам.

    Работает только на устройствах с gevent/geventwebsocket, где
    есть обработчик /ws/events. На остальных устройствах список
    подписчиков будет пустым, и функция просто залогирует событие.
    """
    try:
        payload = {"type": "event", **(event or {})}
    except Exception:
        payload = {"type": "event", "raw": repr(event)}
    try:
        data = json.dumps(payload, ensure_ascii=False)
    except Exception as e:
        ws_debug("broadcast_event: failed to encode payload", error=str(e))
        return

    dead: list = []
    for ws in list(EVENT_SUBSCRIBERS):
        try:
            ws.send(data)
        except Exception as e:  # noqa: BLE001
            dead.append(ws)
            ws_debug("broadcast_event: failed to send to subscriber", error=str(e))

    # Удаляем отвалившихся подписчиков
    for ws in dead:
        try:
            EVENT_SUBSCRIBERS.remove(ws)
        except ValueError:
            # уже удалён где-то ещё
            pass
        except Exception:
            pass

    ws_debug(
        "broadcast_event: dispatched",
        event=event,
        subscribers=len(EVENT_SUBSCRIBERS),
        removed=len(dead),
    )


service_bp = create_service_blueprint(
    restart_xkeen=restart_xkeen,
    append_restart_log=append_restart_log,
    XRAY_ERROR_LOG=XRAY_ERROR_LOG,
    broadcast_event=broadcast_event,
)
app.register_blueprint(service_bp)

devtools_bp = create_devtools_blueprint(UI_STATE_DIR)
app.register_blueprint(devtools_bp)

# Filesystem facade blueprint (always enabled for local file manager)
try:
    fs_bp = create_fs_blueprint(
        tmp_dir=str(os.getenv("XKEEN_REMOTEFM_TMP_DIR", "/tmp") or "/tmp"),
        max_upload_mb=int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200") or "200"),
    )
    app.register_blueprint(fs_bp)
except Exception as _e:
    try:
        ws_debug("fs blueprint init failed", error=str(_e))
    except Exception:
        pass


# RemoteFS blueprint (optional; disabled on MIPS and when lftp is missing)
if REMOTEFS_ENABLED:
    try:
        remotefs_bp, remotefs_mgr = create_remotefs_blueprint(
            enabled=True,
            lftp_bin=REMOTEFS_LFTP_BIN or "lftp",
            max_sessions=int(os.getenv("XKEEN_REMOTEFM_MAX_SESSIONS", "6")),
            ttl_seconds=int(os.getenv("XKEEN_REMOTEFM_SESSION_TTL", "900")),
            max_upload_mb=int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200")),
            tmp_dir=str(os.getenv("XKEEN_REMOTEFM_TMP_DIR", "/tmp") or "/tmp"),
            return_mgr=True,
        )
        app.extensions["xkeen.remotefs_mgr"] = remotefs_mgr
        app.register_blueprint(remotefs_bp)
    except Exception as _e:
        try:
            ws_debug("remotefs init failed", error=str(_e))
        except Exception:
            pass




@app.route("/ws/xray-logs")
def ws_xray_logs():
    """
    WebSocket-стрим логов Xray.

    query:
      file=error|access (или error.log/access.log)

    Сервер читает файл по мере появления новых строк и
    шлёт JSON:
      {"type": "line", "line": "<строка>"}
    первые несколько строк можно отдать пачкой:
      {"type": "init", "lines": ["...", "...", ...]}
    """
    file_name = request.args.get("file", "error")
    client_ip = request.remote_addr or "unknown"

    try:
        max_lines = int((request.args.get("max_lines", "800") or "800").strip())
    except Exception:
        max_lines = 800
    # sanity clamp (keep in sync with /api/xray-logs)
    max_lines = max(50, min(5000, int(max_lines or 800)))

    ws_debug("ws_xray_logs: handler called", client=client_ip, file=file_name, max_lines=max_lines)

    ws = request.environ.get("wsgi.websocket")
    if ws is None:
        # обычный HTTP-запрос сюда не должен попадать
        ws_debug(
            "ws_xray_logs: no WebSocket in environ, returning 400",
            path=request.path,
            method=request.method,
        )
        return "Expected WebSocket", 400

    path = _resolve_xray_log_path_for_ws(file_name)
    ws_debug("ws_xray_logs: resolved log path", path=path)

    if not path or not os.path.isfile(path):
        ws_debug("ws_xray_logs: logfile not found", path=path)
        try:
            ws.send(json.dumps({"type": "init", "lines": [], "error": "logfile not found"}, ensure_ascii=False))
        except Exception as e:
            ws_debug("ws_xray_logs: failed to send 'not found' message", error=str(e))
        return ""

    sent_lines = 0

    try:
        # 1) Отдаём “снимок” последних строк
        try:
            last_lines = tail_lines(path, max_lines=max_lines)
            last_lines = adjust_log_timezone(last_lines)
            ws_debug(
                "ws_xray_logs: initial snapshot ready",
                lines_count=len(last_lines),
                path=path,
            )
        except Exception as e:
            ws_debug(
                "ws_xray_logs: failed to read initial snapshot",
                error=str(e),
                path=path,
            )
            last_lines = []

        try:
            ws.send(json.dumps({"type": "init", "lines": last_lines}, ensure_ascii=False))
            sent_lines += len(last_lines)
            ws_debug(
                "ws_xray_logs: initial snapshot sent",
                total_sent=sent_lines,
            )
        except WebSocketError as e:
            ws_debug(
                "ws_xray_logs: WebSocketError on initial send, closing",
                error=str(e),
            )
            return ""
        except Exception as e:
            ws_debug(
                "ws_xray_logs: unexpected error on initial send, closing",
                error=str(e),
            )
            return ""

        # 2) Дальше ведём себя как tail -f
        with open(path, "r") as f:
            f.seek(0, os.SEEK_END)
            ws_debug(
                "ws_xray_logs: entering tail loop",
                path=path,
                start_pos=f.tell(),
            )

            while True:
                line = f.readline()
                if not line:
                    # нет новых данных — подождём
                    gevent.sleep(0.3)
                    continue

                try:
                    adj = adjust_log_timezone([line])
                    ws.send(json.dumps({"type": "line", "line": adj[0]}, ensure_ascii=False))
                    sent_lines += 1

                    # каждые 100 строк отметимся
                    if sent_lines % 100 == 0:
                        ws_debug(
                            "ws_xray_logs: still streaming",
                            total_sent=sent_lines,
                            path=path,
                        )

                except WebSocketError as e:
                    ws_debug(
                        "ws_xray_logs: WebSocketError while streaming, client probably closed",
                        error=str(e),
                        total_sent=sent_lines,
                    )
                    break
                except Exception as e:
                    ws_debug(
                        "ws_xray_logs: error while streaming single line",
                        error=str(e),
                    )
                    continue

    finally:
        ws_debug(
            "ws_xray_logs: closing WebSocket",
            client=client_ip,
            total_sent=sent_lines,
        )
        try:
            ws.close()
        except Exception:
            pass

    return ""



@app.route("/ws/devtools-logs")
def ws_devtools_logs():
    """WebSocket tail -f for DevTools logs.

    query:
      name=<log name from /api/devtools/logs>
      lines=<initial snapshot lines, default 400>
      cursor=<optional resume cursor from HTTP tail>

    Server sends JSON messages:
      init:   {"type":"init","mode":"full",  "name":...,"path":...,"lines":[...],"cursor":...,"exists":bool,"size":int,"mtime":float,"ino":int}
      append: {"type":"append","mode":"append","name":...,"lines":[...],"cursor":...,"exists":bool,"size":int,"mtime":float,"ino":int}

    Notes:
      - When cursor is valid and file inode matches, initial message can be "append".
      - On rotation/truncate, server falls back to sending "init" snapshot.
    """

    name = (request.args.get("name") or "").strip()
    cursor_in = request.args.get("cursor")
    try:
        lines_req = int(request.args.get("lines", "400") or "400")
    except Exception:
        lines_req = 400
    lines_req = max(1, min(5000, int(lines_req or 400)))

    client_ip = request.remote_addr or "unknown"
    ws_debug("ws_devtools_logs: handler called", client=client_ip, name=name)

    ws = request.environ.get("wsgi.websocket")
    if ws is None:
        ws_debug("ws_devtools_logs: no WebSocket in environ, returning 400", path=request.path)
        return "Expected WebSocket", 400

    if not name:
        try:
            ws.send(json.dumps({"type": "error", "error": "missing_name"}, ensure_ascii=False))
        except Exception:
            pass
        try:
            ws.close()
        except Exception:
            pass
        return ""

    sent_msgs = 0

    def _stat_meta(p: str):
        meta = {"size": 0, "mtime": 0.0, "ino": 0, "exists": False}
        try:
            st = os.stat(p)
            meta = {
                "size": int(getattr(st, "st_size", 0) or 0),
                "mtime": float(getattr(st, "st_mtime", 0.0) or 0.0),
                "ino": int(getattr(st, "st_ino", 0) or 0),
                "exists": True,
            }
        except Exception:
            pass
        return meta

    def _send(payload: dict):
        nonlocal sent_msgs
        try:
            ws.send(json.dumps(payload, ensure_ascii=False))
            sent_msgs += 1
            return True
        except WebSocketError as e:
            ws_debug("ws_devtools_logs: WebSocketError on send", error=str(e), client=client_ip)
            return False
        except Exception as e:
            ws_debug("ws_devtools_logs: error on send", error=str(e), client=client_ip)
            return False

    try:
        # Initial snapshot (or resume-append if cursor is valid)
        try:
            path, lns, new_cursor, mode = _svc_devtools.tail_log(name, lines=lines_req, cursor=cursor_in)
        except ValueError:
            _send({"type": "error", "error": "unknown_log", "name": name})
            return ""

        meta = _stat_meta(path)
        init_type = "append" if mode == "append" else "init"
        if not _send({
            "type": init_type,
            "mode": mode,
            "name": name,
            "path": path,
            "lines": lns,
            "cursor": new_cursor,
            **meta,
        }):
            return ""

        # If the file does not exist – nothing to follow.
        if not meta.get("exists"):
            ws_debug("ws_devtools_logs: log file missing, closing", name=name, path=path)
            return ""

        # Decode cursor state for follow loop.
        cur = None
        try:
            cur = _svc_devtools._decode_cursor(new_cursor)  # type: ignore[attr-defined]
        except Exception:
            cur = None
        ino = int((cur or {}).get("ino", 0) or 0)
        off = int((cur or {}).get("off", meta.get("size", 0) or 0) or 0)
        try:
            carry = _svc_devtools._b64d(str((cur or {}).get("carry", "")))  # type: ignore[attr-defined]
        except Exception:
            carry = b""

        # Follow
        f = None
        try:
            f = open(path, "rb", buffering=0)
            try:
                f.seek(off, os.SEEK_SET)
            except Exception:
                try:
                    f.seek(0, os.SEEK_END)
                    off = int(f.tell() or 0)
                except Exception:
                    off = int(meta.get("size", 0) or 0)
        except Exception as e:
            ws_debug("ws_devtools_logs: failed to open log for follow", error=str(e), path=path)
            return ""

        last_stat_check = time.time()
        idle_sleep = 0.10  # fast enough for "instant", low CPU load

        while True:
            try:
                chunk = f.read(64 * 1024)
            except Exception:
                chunk = b""

            if chunk:
                off += len(chunk)
                buf = (carry or b"") + chunk
                parts = buf.splitlines(True)
                new_carry = b""
                if parts:
                    last = parts[-1]
                    if not last.endswith(b"\n") and not last.endswith(b"\r"):
                        new_carry = last
                        parts = parts[:-1]
                carry = new_carry

                if parts:
                    lines_out = [p.decode("utf-8", "replace") for p in parts]
                    try:
                        cur_str = _svc_devtools._encode_cursor({"ino": ino, "off": int(off), "carry": _svc_devtools._b64e(carry)})  # type: ignore[attr-defined]
                    except Exception:
                        cur_str = new_cursor
                    new_cursor = cur_str
                    meta_now = _stat_meta(path)
                    if not _send({
                        "type": "append",
                        "mode": "append",
                        "name": name,
                        "path": path,
                        "lines": lines_out,
                        "cursor": new_cursor,
                        **meta_now,
                    }):
                        break

                idle_sleep = 0.05
                continue

            # No data at EOF: wait a bit.
            gevent.sleep(idle_sleep)
            if idle_sleep < 0.25:
                idle_sleep = min(0.25, idle_sleep * 1.3)

            # Periodic rotation/truncate checks.
            now = time.time()
            if now - last_stat_check < 1.0:
                continue
            last_stat_check = now

            try:
                st = os.stat(path)
            except Exception:
                ws_debug("ws_devtools_logs: log file disappeared", name=name, path=path)
                _send({"type": "init", "mode": "full", "name": name, "path": path, "lines": [], "cursor": "", "exists": False, "size": 0, "mtime": 0.0, "ino": 0})
                break

            cur_ino = int(getattr(st, "st_ino", 0) or 0)
            cur_size = int(getattr(st, "st_size", 0) or 0)

            rotated = (ino and cur_ino and cur_ino != ino)
            truncated = (cur_size < int(off or 0))

            if rotated or truncated:
                ws_debug(
                    "ws_devtools_logs: rotation/truncate detected", 
                    name=name, path=path, rotated=rotated, truncated=truncated,
                    old_ino=ino, new_ino=cur_ino, old_off=off, new_size=cur_size,
                )

                # Send a fresh snapshot and reset follow state.
                try:
                    path2, lns2, new_cur2, _mode2 = _svc_devtools.tail_log(name, lines=lines_req, cursor=None)
                except Exception:
                    # if something goes wrong, just re-seek to end
                    lns2, new_cur2, path2 = [], None, path

                meta2 = _stat_meta(path2)
                if new_cur2:
                    try:
                        cur2 = _svc_devtools._decode_cursor(new_cur2)  # type: ignore[attr-defined]
                    except Exception:
                        cur2 = None
                    ino = int((cur2 or {}).get("ino", meta2.get("ino", 0) or 0) or 0)
                    off = int((cur2 or {}).get("off", meta2.get("size", 0) or 0) or 0)
                    try:
                        carry = _svc_devtools._b64d(str((cur2 or {}).get("carry", "")))  # type: ignore[attr-defined]
                    except Exception:
                        carry = b""
                    new_cursor = new_cur2
                else:
                    ino = meta2.get("ino", 0) or 0
                    off = meta2.get("size", 0) or 0
                    carry = b""
                    try:
                        new_cursor = _svc_devtools._encode_cursor({"ino": int(ino), "off": int(off), "carry": ""})  # type: ignore[attr-defined]
                    except Exception:
                        new_cursor = ""

                _send({
                    "type": "init",
                    "mode": "full",
                    "name": name,
                    "path": path2,
                    "lines": lns2,
                    "cursor": new_cursor,
                    **meta2,
                })

                try:
                    if f:
                        f.close()
                except Exception:
                    pass
                try:
                    f = open(path2, "rb", buffering=0)
                    try:
                        f.seek(off, os.SEEK_SET)
                    except Exception:
                        f.seek(0, os.SEEK_END)
                        off = int(f.tell() or 0)
                except Exception:
                    break

    finally:
        ws_debug("ws_devtools_logs: closing", client=client_ip, name=name, sent_msgs=sent_msgs)
        try:
            ws.close()
        except Exception:
            pass

    return ""





# ---------- RemoteFS (SFTP/FTP/FTPS) capability detection ----------



@app.get("/api/capabilities")
def api_capabilities():
    """
    Возвращает возможности бэкенда для фронтенда.

    Используется фронтом для условного показа функционала.
    """
    """
    Возвращает возможности бэкенда для фронтенда.

    - websocket: наличие поддержки WebSocket (gevent).
    - remoteFs: возможности удалённого файлового менеджера (SFTP/FTP/FTPS).
    
    Фичу можно выключить переменной окружения XKEEN_REMOTEFM_ENABLE=0.
    На MIPS (mips/mipsel/...) фича по умолчанию отключена.
    """

    # Runtime/environment info (router vs dev).
    # Can be overridden by env: XKEEN_RUNTIME=router|dev
    rt_env = (os.environ.get('XKEEN_RUNTIME') or os.environ.get('XKEEN_ENV') or '').strip().lower()
    if rt_env in ('router','dev','desktop','mac'):
        rt_mode = 'router' if rt_env == 'router' else 'dev'
    else:
        # Heuristics: Keenetic/Entware markers + platform.
        try:
            is_darwin = (sys.platform == 'darwin')
        except Exception:
            is_darwin = False
        if is_darwin:
            rt_mode = 'dev'
        else:
            # /proc/ndm and ndmc are common on Keenetic; opkg indicates Entware
            has_ndm = os.path.exists('/proc/ndm') or os.path.exists('/opt/etc/ndm')
            has_ndmc = bool(shutil.which('ndmc'))
            has_opkg = os.path.exists('/opt/bin/opkg')
            rt_mode = 'router' if (has_ndm or has_ndmc or has_opkg or str(BASE_ETC_DIR).startswith('/opt/')) else 'dev'

    runtime = {
        'mode': rt_mode,
        'platform': sys.platform,
        'ws_runtime': bool(WS_RUNTIME),
        'ui_state_dir': UI_STATE_DIR,
        'base_etc_dir': BASE_ETC_DIR,
        'base_var_dir': BASE_VAR_DIR,
        'ui_log_dir': UI_LOG_DIR,
        'mihomo_root_dir': MIHOMO_ROOT_DIR,
        'mihomo_config_file': MIHOMO_CONFIG_FILE,
    }

    files = {
        'routing': ROUTING_FILE,
        'inbounds': INBOUNDS_FILE,
        'outbounds': OUTBOUNDS_FILE,
        'mihomo': MIHOMO_CONFIG_FILE,
        'restart_log': RESTART_LOG_FILE,
    }

    remote = {
        "enabled": bool(REMOTEFS_ENABLED),
        "supported": bool(REMOTEFS_SUPPORTED),
        "arch": REMOTEFS_MACHINE_ARCH,
        "backend": "lftp" if REMOTEFS_LFTP_BIN else None,
        "reason": REMOTEFS_DISABLED_REASON,
        "protocols": {
            "sftp": bool(REMOTEFS_LFTP_BIN) and not _is_mips_arch(REMOTEFS_MACHINE_ARCH),
            "ftp": bool(REMOTEFS_LFTP_BIN) and not _is_mips_arch(REMOTEFS_MACHINE_ARCH),
            "ftps": bool(REMOTEFS_LFTP_BIN) and not _is_mips_arch(REMOTEFS_MACHINE_ARCH),
        },
        "limits": {
            "max_sessions": int(os.getenv("XKEEN_REMOTEFM_MAX_SESSIONS", "6") or "6"),
            "session_ttl_seconds": int(os.getenv("XKEEN_REMOTEFM_SESSION_TTL", "900") or "900"),
            "max_upload_mb": int(os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200") or "200"),
        },
        "fileops": {
            "enabled": bool(REMOTEFS_ENABLED),
            "ws": bool(WS_RUNTIME and REMOTEFS_ENABLED),
            "workers": int(os.getenv("XKEEN_FILEOPS_WORKERS", "1") or "1"),
            "max_jobs": int(os.getenv("XKEEN_FILEOPS_MAX_JOBS", "100") or "100"),
            "job_ttl_seconds": int(os.getenv("XKEEN_FILEOPS_JOB_TTL", "3600") or "3600"),
            "ops": ["copy", "move", "delete"],
            "remote_to_remote": bool(REMOTEFS_ENABLED),
            "remote_to_remote_direct": (os.getenv("XKEEN_FILEOPS_REMOTE2REMOTE_DIRECT", "1") or "1") not in ("0", "false", "no", "off", "-"),
            "fxp": (os.getenv("XKEEN_FILEOPS_FXP", "1") or "1") not in ("0", "false", "no", "off", "-"),
            "spool_max_mb": int(os.getenv("XKEEN_FILEOPS_SPOOL_MAX_MB", os.getenv("XKEEN_REMOTEFM_MAX_UPLOAD_MB", "200")) or "200"),
            "overwrite_modes": ["replace", "skip", "ask"],
            "supports_dry_run": True,
            "supports_decisions": True,
        },
        "fs_admin": {
            "local": {"chmod": True, "chown": True, "touch": True, "stat_batch": True},
            "remote": {"chmod": True, "chown": True, "chown_protocols": ["sftp"], "touch": True, "stat_batch": True},
        },
    }

    return jsonify({
        "websocket": bool(WS_RUNTIME),
        "runtime": runtime,
        "files": files,
        "remoteFs": remote,
    })
@app.post("/api/ws-debug")
def api_ws_debug():
    """
    Принимает отладочные события с фронта и пишет их в ws.log.
    body JSON: { "msg": "...", "extra": { ... } }
    """
    data = request.get_json(silent=True) or {}
    msg = data.get("msg", "")
    extra = data.get("extra") or {}
    extra["remote_addr"] = request.remote_addr or "unknown"
    ws_debug("FRONTEND: " + str(msg), **extra)
    return jsonify({"ok": True})
