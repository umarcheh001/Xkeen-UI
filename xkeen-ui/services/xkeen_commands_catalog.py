"""Catalog of supported XKeen CLI flags for the UI.

Extracted from legacy app.py to keep UI rendering stable while allowing app.py refactor.
"""

from __future__ import annotations

import os
import shutil
from typing import Mapping, Optional

from services.utils.env import _env_bool

# NOTE: Keep structure and text stable; UI uses this for rendering.
# "tone" is used only for UI color accents (see styles.css + panel.html).
COMMAND_GROUPS = [
    {
        "title": "Установка",
        "tone": "warn",
        "items": [
            {"flag": "-i",  "desc": "Основной режим установки XKeen + Xray + GeoFile + Mihomo"},
            {"flag": "-io", "desc": "OffLine установка XKeen"},
        ],
    },
    {
        "title": "Обновление",
        "tone": "warn",
        "items": [
            {"flag": "-uk", "desc": "XKeen"},
            {"flag": "-ug", "desc": "GeoFile"},
            {"flag": "-ux", "desc": "Xray (повышение/понижение версии)"},
            {"flag": "-um", "desc": "Mihomo (повышение/понижение версии)"},
        ],
    },
    {
        "title": "Включение или изменение задачи автообновления",
        "tone": "warn",
        "items": [
            {"flag": "-ugc", "desc": "GeoFile"},
        ],
    },
    {
        "title": "Регистрация в системе",
        "tone": "warn",
        "items": [
            {"flag": "-rrk", "desc": "XKeen"},
            {"flag": "-rrx", "desc": "Xray"},
            {"flag": "-rrm", "desc": "Mihomo"},
            {"flag": "-ri",  "desc": "Автозапуск XKeen средствами init.d"},
        ],
    },
    {
        "title": "Удаление | Утилиты и компоненты",
        "tone": "danger",
        "items": [
            {"flag": "-remove", "desc": "Полная деинсталляция XKeen"},
            {"flag": "-dgs",    "desc": "GeoSite"},
            {"flag": "-dgi",    "desc": "GeoIP"},
            {"flag": "-dx",     "desc": "Xray"},
            {"flag": "-dm",     "desc": "Mihomo"},
            {"flag": "-dk",     "desc": "XKeen"},
        ],
    },
    {
        "title": "Удаление | Задачи автообновления",
        "tone": "danger",
        "items": [
            {"flag": "-dgc", "desc": "GeoFile"},
        ],
    },
    {
        "title": "Удаление | Регистрации в системе",
        "tone": "danger",
        "items": [
            {"flag": "-drk", "desc": "XKeen"},
            {"flag": "-drx", "desc": "Xray"},
            {"flag": "-drm", "desc": "Mihomo"},
        ],
    },
    {
        "title": "Порты | Через которые работает прокси-клиент",
        "tone": "ok",
        "items": [
            {"flag": "-ap", "desc": "Добавить"},
            {"flag": "-dp", "desc": "Удалить"},
            {"flag": "-cp", "desc": "Посмотреть"},
        ],
    },
    {
        "title": "Порты | Исключенные из работы прокси-клиента",
        "tone": "ok",
        "items": [
            {"flag": "-ape", "desc": "Добавить"},
            {"flag": "-dpe", "desc": "Удалить"},
            {"flag": "-cpe", "desc": "Посмотреть"},
        ],
    },
    {
        "title": "Переустановка",
        "tone": "ok",
        "items": [
            {"flag": "-k", "desc": "XKeen"},
            {"flag": "-g", "desc": "GeoFile"},
        ],
    },
    {
        "title": "Резервная копия XKeen",
        "tone": "ok",
        "items": [
            {"flag": "-kb",  "desc": "Создание"},
            {"flag": "-kbr", "desc": "Восстановление"},
        ],
    },
    {
        "title": "Резервная копия конфигурации Xray",
        "tone": "ok",
        "items": [
            {"flag": "-cb",  "desc": "Создание"},
            {"flag": "-cbr", "desc": "Восстановление"},
        ],
    },
    {
        "title": "Резервная копия конфигурации Mihomo",
        "tone": "ok",
        "items": [
            {"flag": "-mb",  "desc": "Создание"},
            {"flag": "-mbr", "desc": "Восстановление"},
        ],
    },
    {
        "title": "Управление прокси-клиентом",
        "tone": "info",
        "items": [
            {"flag": "-start",   "desc": "Запуск"},
            {"flag": "-stop",    "desc": "Остановка"},
            {"flag": "-restart", "desc": "Перезапуск"},
            {"flag": "-status",  "desc": "Статус работы"},
            {"flag": "-tpx",     "desc": "Порты, шлюз и протокол прокси-клиента"},
            {"flag": "-auto",    "desc": "Включить | Отключить автозапуск прокси-клиента"},
            {"flag": "-d",       "desc": "Установить задержку автозапуска прокси-клиента"},
            {"flag": "-fd",      "desc": "Включить | Отключить контроль файловых дескрипторов прокси-клиента"},
            {"flag": "-diag",    "desc": "Выполнить диагностику"},
            {"flag": "-ipv6",    "desc": "Включить | Отключить протокол IPv6 в KeeneticOS"},
            {"flag": "-dns",     "desc": "Включить | Отключить перенаправление DNS в прокси"},
            {"flag": "-toff",    "desc": "Отключение таймаута при меделенной загрузке с GitHub"},
            {"flag": "-channel", "desc": "Переключить канал получения обновлений XKeen (Stable/Dev версия)"},
            {"flag": "-xray",    "desc": "Переключить XKeen на ядро Xray"},
            {"flag": "-mihomo",  "desc": "Переключить XKeen на ядро Mihomo"},
        ],
    },
    {
        "title": "Управление модулями",
        "tone": "info",
        "items": [
            {"flag": "-modules",    "desc": "Перенос модулей для XKeen в пользовательскую директорию"},
            {"flag": "-delmodules", "desc": "Удаление модулей из пользовательской директории"},
        ],
    },
    {
        "title": "Информация",
        "tone": "info",
        "items": [
            {"flag": "-about", "desc": "О программе"},
            {"flag": "-ad",    "desc": "Поддержать разработчиков"},
            {"flag": "-af",    "desc": "Обратная связь"},
            {"flag": "-v",     "desc": "Версия XKeen"},
        ],
    },
]

ALLOWED_FLAGS = {item["flag"] for group in COMMAND_GROUPS for item in group["items"]}

# Binary name for XKeen (usually available in PATH)
XKEEN_BIN = os.getenv("XKEEN_BIN", "xkeen")

_CONTROL_FLAG_TO_ACTION = {
    "-start": "start",
    "-stop": "stop",
    "-restart": "restart",
    "-status": "status",
}


def _is_executable_file(path: str) -> bool:
    try:
        return bool(path) and os.path.isfile(path) and os.access(path, os.X_OK)
    except Exception:
        return False


def _command_available(cmd: str) -> bool:
    try:
        raw = str(cmd or "").strip()
        if not raw:
            return False
        if os.path.isabs(raw) or os.sep in raw:
            return _is_executable_file(raw)
        return bool(shutil.which(raw))
    except Exception:
        return False


def resolve_xkeen_init_script() -> Optional[str]:
    """Resolve XKeen init.d script path for old/new router releases.

    Order:
      1. explicit env override (`XKEEN_INIT_SCRIPT`, `XKEEN_INITD_FILE`, `XKEEN_INITD_SCRIPT`)
      2. new beta path `/opt/etc/init.d/S05xkeen`
      3. legacy path `/opt/etc/init.d/S99xkeen`
    """
    candidates: list[str] = []

    for env_name in ("XKEEN_INIT_SCRIPT", "XKEEN_INITD_FILE", "XKEEN_INITD_SCRIPT"):
        val = str(os.getenv(env_name, "") or "").strip()
        if val:
            candidates.append(val)

    candidates.extend((
        "/opt/etc/init.d/S05xkeen",
        "/opt/etc/init.d/S99xkeen",
    ))

    seen: set[str] = set()
    for cand in candidates:
        path = str(cand or "").strip()
        if not path or path in seen:
            continue
        seen.add(path)
        if _is_executable_file(path):
            return path
    return None


def build_xkeen_cmd(flag_or_action: str) -> list[str]:
    """Build a compatible XKeen command.

    For service-control actions we prefer the standard `xkeen` CLI because it
    matches legacy behaviour and is noticeably faster on real devices. The
    init.d script resolver is kept as a compatibility fallback for setups where
    the CLI is unavailable but `/opt/etc/init.d/S05xkeen` or
    `/opt/etc/init.d/S99xkeen` exists.
    """
    raw = str(flag_or_action or "").strip()
    if not raw:
        return [XKEEN_BIN]

    flag = raw if raw.startswith("-") else f"-{raw}"
    action = _CONTROL_FLAG_TO_ACTION.get(flag)
    if action:
        if _command_available(XKEEN_BIN):
            return [XKEEN_BIN, flag]
        init_script = resolve_xkeen_init_script()
        if init_script:
            return [init_script, action]
    return [XKEEN_BIN, flag]

# Timeout for background xkeen jobs (seconds)
COMMAND_TIMEOUT = 300

SHELL_ENABLE_ENV = "XKEEN_ALLOW_SHELL"
SHELL_ENABLE_DEFAULT = False


def is_full_shell_enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    """Return whether arbitrary shell execution is allowed right now.

    Reads the current process env by default so DevTools ENV changes can apply
    without re-importing this module.
    """
    if env is None:
        return _env_bool(SHELL_ENABLE_ENV, SHELL_ENABLE_DEFAULT)

    try:
        raw = str(env.get(SHELL_ENABLE_ENV, "") or "").strip().lower()
    except Exception:
        raw = ""
    if not raw:
        return bool(SHELL_ENABLE_DEFAULT)
    if raw in {"1", "true", "yes", "y", "on"}:
        return True
    if raw in {"0", "false", "no", "n", "off"}:
        return False
    return bool(SHELL_ENABLE_DEFAULT)


def get_full_shell_policy(env: Optional[Mapping[str, str]] = None) -> dict[str, object]:
    """Return a stable UI/API payload describing shell execution policy."""
    enabled = bool(is_full_shell_enabled(env))
    return {
        "enabled": enabled,
        "env": SHELL_ENABLE_ENV,
        "default": "1" if SHELL_ENABLE_DEFAULT else "0",
        "requires_restart": False,
        "message": "Shell-команды в UI отключены по умолчанию.",
        "hint": (
            f"Откройте DevTools -> ENV и установите {SHELL_ENABLE_ENV}=1 только если "
            "доверяете сети. Изменение применяется для новых запусков терминала."
        ),
    }


# Backward-compatible snapshot for older imports. New code should call
# is_full_shell_enabled() dynamically instead of relying on this constant.
ALLOW_FULL_SHELL = is_full_shell_enabled()

# Shell path for full shell mode
SHELL_BIN = "/bin/sh"
