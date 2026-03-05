"""Catalog of supported XKeen CLI flags for the UI.

Extracted from legacy app.py to keep UI rendering stable while allowing app.py refactor.
"""

from __future__ import annotations

import os

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
XKEEN_BIN = "xkeen"

# Timeout for background xkeen jobs (seconds)
COMMAND_TIMEOUT = 300

# Full shell mode (arbitrary commands via /bin/sh -c), enabled by default.
ALLOW_FULL_SHELL = bool(int(os.getenv("XKEEN_ALLOW_SHELL", "1")))

# Shell path for full shell mode
SHELL_BIN = "/bin/sh"
