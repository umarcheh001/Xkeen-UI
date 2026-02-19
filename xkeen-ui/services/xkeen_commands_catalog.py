"""Catalog of supported XKeen CLI flags for the UI.

Extracted from legacy app.py to keep UI rendering stable while allowing app.py refactor.
"""

from __future__ import annotations

import os

# NOTE: Keep structure and text stable; UI uses this for rendering.
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
            {"flag": "-ipv6",    "desc": "Вкл/выкл IPv6 в KeeneticOS 5+ (параметр -ipv6; sysctl net.ipv6.conf.all/default.disable_ipv6). По умолчанию IPv6 включён"},
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

# Binary name for XKeen (usually available in PATH)
XKEEN_BIN = "xkeen"

# Timeout for background xkeen jobs (seconds)
COMMAND_TIMEOUT = 300

# Full shell mode (arbitrary commands via /bin/sh -c), enabled by default.
ALLOW_FULL_SHELL = bool(int(os.getenv("XKEEN_ALLOW_SHELL", "1")))

# Shell path for full shell mode
SHELL_BIN = "/bin/sh"
